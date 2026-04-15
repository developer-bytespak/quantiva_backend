import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConnectionStatus } from '@prisma/client';
import { QueuedTradeStatus } from '.prisma/client';
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

  private async watchOne(row: any): Promise<void> {
    if (!row.alpaca_buy_order_id) {
      await this.queuedTradeService.markFailed(row.id, 'Missing alpaca_buy_order_id after submission');
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

    // Fill detected — place TP/SL using the stored percentages
    const tpPct = row.take_profit_pct ? Number(row.take_profit_pct) : null;
    const slPct = row.stop_loss_pct ? Number(row.stop_loss_pct) : null;

    // If percentages weren't provided, mark filled without protection
    if (!tpPct && !slPct) {
      await this.queuedTradeService.markFilled(row.id, null, null);
      this.logger.log(
        `Queue ${row.id}: buy filled, no TP/SL configured (skipping protection)`,
      );
      return;
    }

    try {
      const tpPrice = tpPct ? filledAvgPrice * (1 + tpPct) : filledAvgPrice * 1.1;
      const slPrice = slPct ? filledAvgPrice * (1 - slPct) : filledAvgPrice * 0.95;

      // Floor to whole shares for LIMIT/STOP compatibility on stocks
      const protectionQty = Math.floor(filledQty);
      if (protectionQty <= 0) {
        await this.queuedTradeService.markFilled(row.id, null, null);
        this.logger.warn(
          `Queue ${row.id}: buy filled ${filledQty} shares, floors to 0 whole shares — no protection placed`,
        );
        return;
      }

      const protection = await this.alpacaService.placeProtectionOrders(
        apiKey,
        apiSecret,
        row.symbol,
        protectionQty,
        parseFloat(tpPrice.toPrecision(8)),
        parseFloat(slPrice.toPrecision(8)),
      );

      await this.queuedTradeService.markFilled(
        row.id,
        protection.takeProfitOrderId,
        protection.stopLossOrderId,
      );
      this.logger.log(
        `Queue ${row.id}: buy filled ${filledQty} ${row.symbol} @ ${filledAvgPrice}, ` +
          `TP=${protection.takeProfitOrderId}, SL=${protection.stopLossOrderId}`,
      );
    } catch (err: any) {
      // Buy is filled but protection failed — mark filled with null TP/SL and
      // surface the reason. User or a separate recovery flow can add protection.
      await this.prisma.pending_queued_trades.update({
        where: { id: row.id },
        data: {
          status: QueuedTradeStatus.filled,
          filled_at: new Date(),
          failure_reason: `Buy filled but protection failed: ${err?.message ?? err}`,
        },
      });
      this.logger.error(
        `Queue ${row.id}: buy filled but protection failed — ${err?.message ?? err}`,
      );
    }
  }
}
