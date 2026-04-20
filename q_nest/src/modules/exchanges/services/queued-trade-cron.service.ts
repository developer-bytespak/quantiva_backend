import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConnectionStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AlpacaService } from '../integrations/alpaca.service';
import { EncryptionService } from './encryption.service';
import { QueuedTradeService } from './queued-trade.service';

/**
 * Cron that drives the queued-trade state machine for Alpaca stock orders
 * clicked while the market was closed.
 *
 * Runs every minute. Each tick:
 *   1. Expires stale `queued` rows older than their `expires_at`.
 *   2. Submits still-queued rows to Alpaca (buy first). If Alpaca rejects
 *      with MARKET_CLOSED we leave the row as queued and retry next tick —
 *      the market opens at 9:30 ET so a minutely cadence catches it fast.
 *   3. For rows in `submitted` status, polls Alpaca to see if the buy has
 *      filled. On fill, places TP + SL using the stored percentages and
 *      advances the row to `filled`.
 *
 * Keeps failures per-row: one bad connection or one broken order doesn't
 * stop the sweep. Every row's error is captured into `failure_reason`.
 */
@Injectable()
export class QueuedTradeCronService {
  private readonly logger = new Logger(QueuedTradeCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queuedTradeService: QueuedTradeService,
    private readonly alpacaService: AlpacaService,
    private readonly encryptionService: EncryptionService,
  ) {}

  @Cron('0 * * * * *') // every minute
  async tick(): Promise<void> {
    try {
      await this.queuedTradeService.expireStaleRows();
    } catch (err: any) {
      this.logger.warn(`Expire sweep failed: ${err?.message ?? err}`);
    }

    try {
      await this.submitQueuedRows();
    } catch (err: any) {
      this.logger.error(`Submit sweep failed: ${err?.message ?? err}`);
    }

    try {
      await this.watchSubmittedRows();
    } catch (err: any) {
      this.logger.error(`Fill-watch sweep failed: ${err?.message ?? err}`);
    }
  }

  // ── Submission ──────────────────────────────────────────────────────────

  private async submitQueuedRows(): Promise<void> {
    const rows = await this.queuedTradeService.findReadyForSubmission();
    if (rows.length === 0) return;

    for (const row of rows) {
      try {
        await this.submitOne(row);
      } catch (err: any) {
        this.logger.warn(
          `Submit failed for queue ${row.id} (${row.symbol}): ${err?.message ?? err}`,
        );
        // intentionally not marking as failed here — MARKET_CLOSED is expected
        // to loop until open. The inner handler marks permanent errors as failed.
      }
    }
  }

  private async submitOne(row: any): Promise<void> {
    // Re-verify connection is still active and still Alpaca
    const connection = await this.prisma.user_exchange_connections.findUnique({
      where: { connection_id: row.connection_id },
      include: { exchange: true },
    });

    if (!connection || connection.status !== ConnectionStatus.active) {
      await this.queuedTradeService.markFailed(
        row.id,
        `Connection ${row.connection_id} is no longer active`,
      );
      return;
    }

    if (connection.exchange?.name?.toLowerCase() !== 'alpaca') {
      await this.queuedTradeService.markFailed(
        row.id,
        `Connection ${row.connection_id} is no longer an Alpaca connection`,
      );
      return;
    }

    if (!connection.api_key_encrypted || !connection.api_secret_encrypted) {
      await this.queuedTradeService.markFailed(
        row.id,
        'Connection is missing API credentials',
      );
      return;
    }

    const apiKey = this.encryptionService.decryptApiKey(connection.api_key_encrypted);
    const apiSecret = this.encryptionService.decryptApiKey(connection.api_secret_encrypted);

    try {
      const placed = await this.alpacaService.placeOrder(
        row.symbol,
        row.side,
        row.order_type,
        Number(row.quantity),
        row.limit_price ? Number(row.limit_price) : undefined,
        apiKey,
        apiSecret,
      );

      await this.queuedTradeService.markSubmitted(row.id, placed.orderId);
      this.logger.log(
        `Queue ${row.id}: submitted ${row.side} ${row.quantity} ${row.symbol} ` +
          `as Alpaca order ${placed.orderId}`,
      );
    } catch (err: any) {
      const status = err?.response?.status;
      const bodyMsg = ((err?.response?.data?.message ?? err?.message ?? '') + '').toLowerCase();

      // MARKET_CLOSED is expected until 9:30 ET — leave row queued for next tick.
      if (bodyMsg.includes('market is closed') || bodyMsg.includes('market closed')) {
        return;
      }

      // Anything else is a real problem — mark failed with the reason surfaced.
      await this.queuedTradeService.markFailed(
        row.id,
        `Alpaca rejected submission: ${err?.message ?? 'unknown error'} (status ${status ?? 'n/a'})`,
      );
      this.logger.warn(
        `Queue ${row.id}: failed to submit — ${err?.message ?? err}`,
      );
    }
  }

  // ── Fill watching ───────────────────────────────────────────────────────

  private async watchSubmittedRows(): Promise<void> {
    const rows = await this.queuedTradeService.findAwaitingFill();
    if (rows.length === 0) return;

    for (const row of rows) {
      try {
        await this.watchOne(row);
      } catch (err: any) {
        this.logger.warn(
          `Fill-watch failed for queue ${row.id}: ${err?.message ?? err}`,
        );
      }
    }
  }

  /**
   * Maximum time a row can sit in `submitted` after the buy fills before we
   * give up on attaching TP/SL. 96h covers the worst realistic case: a
   * Friday-afternoon PDT block where the weekend + Monday holiday close
   * eats ~72h before the position can first be sold. 96h leaves a full
   * day of retry headroom inside the regular market session.
   */
  private static readonly PROTECTION_GIVE_UP_MS = 96 * 60 * 60 * 1000;

  /**
   * Break a Date into the calendar/clock parts as seen in New York time.
   * Used for PDT "same-day" comparison and market-hours check without
   * depending on the server's local timezone. Handles DST automatically
   * via the IANA `America/New_York` zone.
   */
  private static getEasternParts(date: Date): {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    weekday: number;
  } {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hour12: false,
    }).formatToParts(date);
    const map: Record<string, string> = {};
    for (const p of parts) if (p.type !== 'literal') map[p.type] = p.value;
    const weekdayMap: Record<string, number> = {
      Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
    };
    return {
      year: parseInt(map.year, 10),
      month: parseInt(map.month, 10),
      day: parseInt(map.day, 10),
      // 'hour12: false' can emit '24' for midnight in some locales — mod 24 normalizes.
      hour: parseInt(map.hour, 10) % 24,
      minute: parseInt(map.minute, 10),
      weekday: weekdayMap[map.weekday] ?? 0,
    };
  }

  /** Is the US stock market currently open? Weekdays 9:30 AM – 4:00 PM ET. */
  private static isUSMarketOpen(
    et: ReturnType<typeof QueuedTradeCronService.getEasternParts>,
  ): boolean {
    if (et.weekday === 0 || et.weekday === 6) return false;
    const mins = et.hour * 60 + et.minute;
    return mins >= 570 && mins < 960; // 9:30 → 16:00
  }

  /**
   * Decide whether to skip this tick for a row whose last failure was a
   * deferrable block. Two cases save thousands of wasted Alpaca calls:
   *
   *   1. PDT: Alpaca blocks any sell of a stock bought *today* for flagged
   *      accounts. The block lifts the moment the position becomes an
   *      overnight hold — i.e. when the calendar day in ET rolls forward.
   *      → Skip all retries while the ET date equals the buy's ET date.
   *
   *   2. Market closed: outside 9:30–16:00 ET on weekdays Alpaca refuses
   *      every sell, whatever the reason.
   *      → Skip until the market is open.
   *
   * Any other `failure_reason` (network blip, unknown Alpaca error, etc.)
   * keeps today's immediate-retry behavior.
   */
  private static shouldDeferRetry(row: {
    buy_filled_at: Date | null;
    failure_reason: string | null;
  }): boolean {
    if (!row.buy_filled_at) return false;
    const reason = (row.failure_reason || '').toLowerCase();
    const isPdt = reason.includes('pattern day trading') || reason.includes('pdt');
    const isMarketClosed =
      reason.includes('market closed') || reason.includes('market is closed');
    if (!isPdt && !isMarketClosed) return false;

    const now = QueuedTradeCronService.getEasternParts(new Date());

    if (isPdt) {
      const buy = QueuedTradeCronService.getEasternParts(
        new Date(row.buy_filled_at),
      );
      const sameDay =
        buy.year === now.year && buy.month === now.month && buy.day === now.day;
      if (sameDay) return true;
    }

    // PDT after the date rolled OR a bare market-closed rejection: only
    // retry while the market is actually accepting orders.
    return !QueuedTradeCronService.isUSMarketOpen(now);
  }

  private async watchOne(row: any): Promise<void> {
    if (!row.alpaca_buy_order_id) {
      await this.queuedTradeService.markFailed(row.id, 'Missing alpaca_buy_order_id after submission');
      return;
    }

    // Give-up deadline: if the buy filled long ago and TP/SL still won't
    // place, stop retrying so we don't hammer Alpaca forever. The row
    // transitions to `failed` with the accumulated reason, and the user
    // can add protection manually from the positions UI.
    if (row.buy_filled_at) {
      const ageMs = Date.now() - new Date(row.buy_filled_at).getTime();
      if (ageMs > QueuedTradeCronService.PROTECTION_GIVE_UP_MS) {
        const reason = `Gave up attaching TP/SL after 96h (attempts=${row.protection_attempts ?? 0}). Last error: ${row.failure_reason ?? 'unknown'}`;
        await this.queuedTradeService.markFailed(row.id, reason);
        this.logger.warn(`Queue ${row.id}: ${reason}`);
        return;
      }
    }

    // Skip deferrable rejections (PDT / market-closed) without calling
    // Alpaca. We already know the next call would be rejected identically
    // until either the ET date rolls forward (PDT) or the market opens.
    if (QueuedTradeCronService.shouldDeferRetry(row)) {
      return;
    }

    const connection = await this.prisma.user_exchange_connections.findUnique({
      where: { connection_id: row.connection_id },
    });
    if (!connection?.api_key_encrypted || !connection?.api_secret_encrypted) {
      await this.queuedTradeService.markFailed(row.id, 'Connection missing credentials during fill-watch');
      return;
    }

    const apiKey = this.encryptionService.decryptApiKey(connection.api_key_encrypted);
    const apiSecret = this.encryptionService.decryptApiKey(connection.api_secret_encrypted);

    // Fetch the buy order's current state from Alpaca
    const orders = await this.alpacaService.getOrders(apiKey, apiSecret, 'all', 500);
    const buyOrder = (orders || []).find((o: any) => o.id === row.alpaca_buy_order_id);

    if (!buyOrder) {
      // Shouldn't happen, but if it does we have no way to watch it further.
      await this.queuedTradeService.markFailed(
        row.id,
        `Buy order ${row.alpaca_buy_order_id} not found in Alpaca after submission`,
      );
      return;
    }

    const status = (buyOrder.status || '').toLowerCase();
    const filledQty = parseFloat(buyOrder.filled_qty || '0') || 0;
    const filledAvgPrice = parseFloat(buyOrder.filled_avg_price || '0') || 0;

    // Terminal failure states on the buy
    if (['canceled', 'rejected', 'expired'].includes(status)) {
      await this.queuedTradeService.markFailed(
        row.id,
        `Buy order finalized without fill (status=${status})`,
      );
      return;
    }

    // Not yet filled — wait for next tick
    if (filledQty <= 0 || filledAvgPrice <= 0) {
      return;
    }

    // Buy is filled. Record that moment if we haven't already, so the
    // give-up deadline has a stable anchor even if protection takes many
    // ticks to succeed.
    if (!row.buy_filled_at) {
      await this.queuedTradeService.markBuyFilled(row.id);
    }

    // Fill detected — place TP/SL using the stored percentages
    const tpPct = row.take_profit_pct ? Number(row.take_profit_pct) : null;
    const slPct = row.stop_loss_pct ? Number(row.stop_loss_pct) : null;

    // If percentages weren't provided, the trade is truly done — no
    // protection was ever requested. Mark fully filled so the cron stops
    // picking up this row.
    if (!tpPct && !slPct) {
      await this.queuedTradeService.markFullyFilled(row.id, null, null);
      this.logger.log(
        `Queue ${row.id}: buy filled, no TP/SL configured (skipping protection)`,
      );
      return;
    }

    // Floor to whole shares for LIMIT/STOP compatibility on stocks
    const protectionQty = Math.floor(filledQty);
    if (protectionQty <= 0) {
      // Fractional-only fill — no whole-share protection possible. Mark
      // fully filled so the cron stops retrying.
      await this.queuedTradeService.markFullyFilled(row.id, null, null);
      this.logger.warn(
        `Queue ${row.id}: buy filled ${filledQty} shares, floors to 0 whole shares — no protection placed`,
      );
      return;
    }

    try {
      const tpPrice = tpPct ? filledAvgPrice * (1 + tpPct) : filledAvgPrice * 1.1;
      const slPrice = slPct ? filledAvgPrice * (1 - slPct) : filledAvgPrice * 0.95;

      const protection = await this.alpacaService.placeProtectionOrders(
        apiKey,
        apiSecret,
        row.symbol,
        protectionQty,
        parseFloat(tpPrice.toPrecision(8)),
        parseFloat(slPrice.toPrecision(8)),
      );

      await this.queuedTradeService.markFullyFilled(
        row.id,
        protection.takeProfitOrderId,
        protection.stopLossOrderId,
      );
      this.logger.log(
        `Queue ${row.id}: buy filled ${filledQty} ${row.symbol} @ ${filledAvgPrice}, ` +
          `TP=${protection.takeProfitOrderId}, SL=${protection.stopLossOrderId}`,
      );
    } catch (err: any) {
      // Buy is filled but protection failed. Do NOT mark the row filled —
      // that would stop the cron from ever retrying. Instead record the
      // failure reason, bump the attempts counter, and leave the row in
      // `submitted` so the next tick tries again. Transient failures
      // (rate limits, network blips) recover quickly; PDT blocks recover
      // overnight once the position becomes an overnight hold.
      const alpacaMsg =
        err?.response?.data?.message ??
        err?.response?.data?.reject_reason ??
        err?.message ??
        String(err);
      const errStatus = err?.response?.status;
      const reason = `Buy filled but protection failed: ${alpacaMsg}${errStatus ? ` (status ${errStatus})` : ''}`;

      await this.queuedTradeService.recordProtectionFailure(row.id, reason);
      const nextAttempt = Number(row.protection_attempts ?? 0) + 1;
      this.logger.warn(
        `Queue ${row.id}: protection failed (attempt ${nextAttempt}) — ${alpacaMsg}. Will retry next tick.`,
      );
    }
  }
}
