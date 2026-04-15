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

  /** Mark a row as filled and record the TP/SL order ids. */
  async markFilled(
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
