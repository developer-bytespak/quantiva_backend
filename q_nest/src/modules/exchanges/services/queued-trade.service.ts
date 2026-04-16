import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { QueuedTradeStatus } from '.prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Service that manages the queue of top-trade orders users clicked while
 * the stock market was closed. The controller calls `enqueue` when
 * Alpaca rejects a stock order with MARKET_CLOSED. A cron later picks up
 * queued rows at market open, submits them, and attaches TP/SL after fill.
 *
 * Scoped to Alpaca connections only — crypto trades 24/7 so there's
 * nothing to queue, and Binance/Bybit paths never hit this service.
 */
@Injectable()
export class QueuedTradeService {
  private readonly logger = new Logger(QueuedTradeService.name);

  /** Queued trades auto-expire after this many days if not submitted. */
  private static readonly DEFAULT_LIFETIME_DAYS = 3;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Persist a new queued trade. Called from ExchangesController.placeOrder
   * when a top-trade on an Alpaca stock hits MARKET_CLOSED. The row starts
   * in `queued` status; the cron advances it to `submitted` / `filled`.
   */
  async enqueue(params: {
    userId: string;
    connectionId: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    orderType?: 'MARKET' | 'LIMIT';
    quantity: number;
    limitPrice?: number;
    takeProfitPct?: number;
    stopLossPct?: number;
    source?: string;
  }) {
    const expiresAt = new Date();
    expiresAt.setDate(
      expiresAt.getDate() + QueuedTradeService.DEFAULT_LIFETIME_DAYS,
    );

    const row = await this.prisma.pending_queued_trades.create({
      data: {
        user_id: params.userId,
        connection_id: params.connectionId,
        symbol: params.symbol,
        side: params.side,
        order_type: params.orderType ?? 'MARKET',
        quantity: params.quantity,
        limit_price: params.limitPrice ?? null,
        take_profit_pct: params.takeProfitPct ?? null,
        stop_loss_pct: params.stopLossPct ?? null,
        source: params.source ?? 'top_trade',
        status: QueuedTradeStatus.queued,
        expires_at: expiresAt,
      },
    });

    this.logger.log(
      `Queued ${params.side} ${params.quantity} ${params.symbol} for next market open ` +
        `(user=${params.userId}, queueId=${row.id}, expires=${expiresAt.toISOString()})`,
    );

    return row;
  }

  /**
   * Track an already-placed Alpaca buy for delayed TP/SL attachment.
   *
   * Used when the user clicks a top-trade during pre/post-market hours and
   * Alpaca ACCEPTS the buy order (unlike the MARKET_CLOSED case where Alpaca
   * rejects outright). The buy sits on Alpaca with status='new' waiting for
   * the market to open to fill — which can be hours away. Our in-controller
   * race-retry loop only waits 1.5s and can't cover that gap, so we persist
   * the buy here with status='submitted' and let the fill-watcher cron
   * attach TP/SL once the buy actually fills.
   *
   * The row starts in 'submitted' (not 'queued') because the buy is already
   * on Alpaca — we don't need to submit it again. The cron's watchSubmittedRows
   * logic will poll the buy's fill status and place protection when it fills.
   */
  async trackForDelayedProtection(params: {
    userId: string;
    connectionId: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    orderType?: 'MARKET' | 'LIMIT';
    quantity: number;
    limitPrice?: number;
    takeProfitPct?: number;
    stopLossPct?: number;
    source?: string;
    alpacaBuyOrderId: string;
  }) {
    const expiresAt = new Date();
    expiresAt.setDate(
      expiresAt.getDate() + QueuedTradeService.DEFAULT_LIFETIME_DAYS,
    );

    const row = await this.prisma.pending_queued_trades.create({
      data: {
        user_id: params.userId,
        connection_id: params.connectionId,
        symbol: params.symbol,
        side: params.side,
        order_type: params.orderType ?? 'MARKET',
        quantity: params.quantity,
        limit_price: params.limitPrice ?? null,
        take_profit_pct: params.takeProfitPct ?? null,
        stop_loss_pct: params.stopLossPct ?? null,
        source: params.source ?? 'top_trade',
        status: QueuedTradeStatus.submitted,
        alpaca_buy_order_id: params.alpacaBuyOrderId,
        submitted_at: new Date(),
        expires_at: expiresAt,
      },
    });

    this.logger.log(
      `Tracking delayed protection: ${params.side} ${params.quantity} ${params.symbol} ` +
        `(buy=${params.alpacaBuyOrderId}, user=${params.userId}, rowId=${row.id}). ` +
        `Fill-watcher cron will attach TP/SL when the buy fills.`,
    );

    return row;
  }

  /** List a user's queued trades, most recent first. Used by the UI. */
  async listForUser(userId: string, limit = 50) {
    return this.prisma.pending_queued_trades.findMany({
      where: { user_id: userId },
      orderBy: { queued_at: 'desc' },
      take: limit,
    });
  }

  /**
   * Cancel a queued trade. Only allowed while in `queued` status — once it's
   * been submitted to Alpaca, the user must cancel the live order via the
   * regular order-cancel path. Verifies ownership to prevent cross-user
   * cancellation.
   */
  async cancelByUser(queueId: string, userId: string) {
    const row = await this.prisma.pending_queued_trades.findUnique({
      where: { id: queueId },
    });
    if (!row) {
      throw new NotFoundException(`Queued trade ${queueId} not found`);
    }
    if (row.user_id !== userId) {
      throw new ForbiddenException(
        `Queued trade ${queueId} does not belong to this user`,
      );
    }
    if (row.status !== QueuedTradeStatus.queued) {
      throw new ForbiddenException(
        `Queued trade ${queueId} is in status "${row.status}" and can no longer be canceled via the queue. Cancel the live Alpaca order if you want to abort.`,
      );
    }

    return this.prisma.pending_queued_trades.update({
      where: { id: queueId },
      data: {
        status: QueuedTradeStatus.canceled,
        canceled_at: new Date(),
      },
    });
  }

  /** Fetch all queued rows ready for submission. Used by the cron. */
  async findReadyForSubmission() {
    return this.prisma.pending_queued_trades.findMany({
      where: { status: QueuedTradeStatus.queued },
      include: {
        // We need the connection to decrypt API keys and confirm it's still active
      },
      orderBy: { queued_at: 'asc' },
      take: 100, // batch cap per sweep
    });
  }

  /** Fetch rows that have been submitted but not yet filled — for the fill-watcher. */
  async findAwaitingFill() {
    return this.prisma.pending_queued_trades.findMany({
      where: { status: QueuedTradeStatus.submitted },
      orderBy: { submitted_at: 'asc' },
      take: 100,
    });
  }

  /** Mark a row as submitted with the Alpaca order id. */
  async markSubmitted(id: string, alpacaBuyOrderId: string) {
    return this.prisma.pending_queued_trades.update({
      where: { id },
      data: {
        status: QueuedTradeStatus.submitted,
        alpaca_buy_order_id: alpacaBuyOrderId,
        submitted_at: new Date(),
      },
    });
  }

  /**
   * Mark the BUY as filled on Alpaca, while keeping the row in `submitted`
   * status so the fill-watcher cron keeps retrying TP/SL placement. The
   * `filled_at` column is deliberately NOT set here — that column is
   * reserved for the truly-done state when TP/SL are also placed. The
   * `buy_filled_at` column records the moment the buy actually filled so
   * we can compute a give-up deadline (e.g. 48h since fill).
   *
   * Idempotent: only writes `buy_filled_at` if it's currently null.
   */
  async markBuyFilled(id: string) {
    return this.prisma.pending_queued_trades.update({
      where: { id },
      data: {
        buy_filled_at: new Date(), // overwrites is fine — the first set wins via the watcher's guard
      },
    });
  }

  /**
   * Mark the row as fully done: BUY filled AND TP/SL both placed. This is
   * the terminal "success" state — the cron will no longer pick the row up
   * (watch query filters on status='submitted'). `filled_at` is populated
   * here so the UI can show a completion timestamp; `buy_filled_at` was
   * set earlier when the BUY first filled.
   */
  async markFullyFilled(
    id: string,
    tpOrderId: string | null,
    slOrderId: string | null,
  ) {
    return this.prisma.pending_queued_trades.update({
      where: { id },
      data: {
        status: QueuedTradeStatus.filled,
        tp_order_id: tpOrderId,
        sl_order_id: slOrderId,
        filled_at: new Date(),
      },
    });
  }

  /**
   * Record that a TP/SL placement attempt failed but the row should remain
   * in `submitted` status so the cron retries on the next tick. Bumps
   * `protection_attempts` so we can spot stuck rows and (separately) apply
   * a give-up deadline. `failure_reason` is overwritten each call with the
   * latest Alpaca message — if you want full history, inspect the logs.
   */
  async recordProtectionFailure(id: string, reason: string) {
    return this.prisma.pending_queued_trades.update({
      where: { id },
      data: {
        failure_reason: reason,
        protection_attempts: { increment: 1 },
      },
    });
  }

  /**
   * Legacy compatibility: previously the cron/controller called `markFilled`
   * at the fill-detection point. The new split is `markBuyFilled` +
   * `markFullyFilled`. Kept as a thin alias so any lingering caller still
   * compiles; prefer the explicit names.
   *
   * @deprecated Use markBuyFilled + markFullyFilled instead.
   */
  async markFilled(
    id: string,
    tpOrderId: string | null,
    slOrderId: string | null,
  ) {
    return this.markFullyFilled(id, tpOrderId, slOrderId);
  }

  /** Mark a row as failed with a human-readable reason. */
  async markFailed(id: string, reason: string) {
    return this.prisma.pending_queued_trades.update({
      where: { id },
      data: {
        status: QueuedTradeStatus.failed,
        failure_reason: reason,
      },
    });
  }

  /** Expire rows older than their expires_at timestamp. Called by the cron. */
  async expireStaleRows() {
    const now = new Date();
    const result = await this.prisma.pending_queued_trades.updateMany({
      where: {
        status: QueuedTradeStatus.queued,
        expires_at: { lt: now },
      },
      data: {
        status: QueuedTradeStatus.expired,
        failure_reason: 'Auto-expired after queue lifetime elapsed',
      },
    });
    if (result.count > 0) {
      this.logger.log(`Expired ${result.count} stale queued trade(s)`);
    }
    return result.count;
  }
}
