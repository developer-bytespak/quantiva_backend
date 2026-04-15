import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConnectionStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AlpacaService, ALPACA_CLIENT_ID_TA_PREFIX } from '../integrations/alpaca.service';
import { EncryptionService } from './encryption.service';

/**
 * Background sweep that cancels orphaned Alpaca TP/SL sell orders.
 *
 * Why this service exists
 * -----------------------
 * Alpaca does not link the Take-Profit and Stop-Loss legs of a top-trade
 * together (unlike Binance's OCO or Bybit's bracket). When one leg fires
 * and closes the position, the other leg stays open forever in Alpaca's
 * order book. Over time these orphans:
 *
 *   - Clutter the user's Alpaca dashboard.
 *   - Block manual trading on the same symbol (Alpaca wash-trade rule
 *     treats any open opposite-side order as blocking).
 *
 * There is already inline cleanup in ExchangesController.placeOrder's
 * Alpaca branch — but that only runs when the user next auto-trades the
 * same symbol. This cron catches every other case (user never re-trades
 * the symbol, user manually sold via Alpaca's UI, app offline, etc.).
 *
 * Safety rule
 * -----------
 * The cron only cancels orders whose `client_order_id` starts with
 * `ta-` (the prefix our AlpacaService.placeProtectionOrders sets). Orders
 * the user placed directly in Alpaca have no client_order_id, or a
 * different prefix, and are never touched.
 *
 * Scope rule
 * ----------
 * An order is considered orphaned when `order.qty > held_position.qty`.
 * This catches both full orphans (TP fired → position 0 → entire SL
 * orphaned) and partial-fill orphans (TP half-filled → position < order
 * qty on the remaining side).
 *
 * Crypto paths and paper-trading are untouched. This service only reads
 * Alpaca connections from the DB; BinanceService / BybitService /
 * BinanceUSService are not referenced or modified in any way.
 */
@Injectable()
export class AlpacaOrphanCleanupService {
  private readonly logger = new Logger(AlpacaOrphanCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly alpacaService: AlpacaService,
    private readonly encryptionService: EncryptionService,
  ) {}

  @Cron('*/5 * * * *') // every 5 minutes
  async sweep(): Promise<void> {
    const startedAt = Date.now();
    let connectionsProcessed = 0;
    let ordersCanceled = 0;

    try {
      const connections = await this.prisma.user_exchange_connections.findMany({
        where: {
          status: ConnectionStatus.active,
          exchange: { name: 'alpaca' },
          api_key_encrypted: { not: null },
          api_secret_encrypted: { not: null },
        },
        include: { exchange: true },
      });

      if (connections.length === 0) {
        return;
      }

      this.logger.debug(
        `Alpaca orphan sweep starting: ${connections.length} active connection(s) to scan`,
      );

      for (const connection of connections) {
        connectionsProcessed += 1;
        try {
          const canceled = await this.sweepConnection(connection);
          ordersCanceled += canceled;
        } catch (err: any) {
          this.logger.warn(
            `Sweep failed for connection ${connection.connection_id}: ${err?.message ?? err}`,
          );
          // continue to next connection — do not let one bad connection halt the sweep
        }
      }

      if (ordersCanceled > 0) {
        this.logger.log(
          `Alpaca orphan sweep complete: canceled ${ordersCanceled} orphan order(s) across ${connectionsProcessed} connection(s) in ${Date.now() - startedAt}ms`,
        );
      }
    } catch (err: any) {
      this.logger.error(
        `Alpaca orphan sweep crashed: ${err?.message ?? err}`,
        err?.stack,
      );
    }
  }

  /**
   * Scan a single connection's open orders, cancel any tagged sell order
   * whose quantity exceeds the held position on the same symbol.
   * Returns the number of orders canceled.
   */
  private async sweepConnection(connection: {
    connection_id: string;
    api_key_encrypted: string | null;
    api_secret_encrypted: string | null;
  }): Promise<number> {
    if (!connection.api_key_encrypted || !connection.api_secret_encrypted) {
      return 0;
    }

    const apiKey = this.encryptionService.decryptApiKey(connection.api_key_encrypted);
    const apiSecret = this.encryptionService.decryptApiKey(connection.api_secret_encrypted);

    const [openOrders, positions] = await Promise.all([
      this.alpacaService.getOrders(apiKey, apiSecret, 'open', 500),
      this.alpacaService.getPositions(apiKey, apiSecret),
    ]);

    if (!Array.isArray(openOrders) || openOrders.length === 0) {
      return 0;
    }

    // Build symbol → held qty map from current positions
    const heldQty = new Map<string, number>();
    for (const p of positions || []) {
      const sym = String(p?.symbol || '').toUpperCase();
      if (!sym) continue;
      const qty = parseFloat(p?.qty ?? '0') || 0;
      heldQty.set(sym, qty);
    }

    let canceled = 0;

    for (const order of openOrders) {
      const clientId = String(order?.client_order_id || '');
      if (!clientId.startsWith(ALPACA_CLIENT_ID_TA_PREFIX)) {
        // Not one of our tagged TP/SL orders — leave it alone.
        continue;
      }

      const side = String(order?.side || '').toLowerCase();
      if (side !== 'sell') {
        continue;
      }

      const sym = String(order?.symbol || '').toUpperCase();
      const orderQty = parseFloat(order?.qty ?? '0') || 0;
      const held = heldQty.get(sym) ?? 0;

      if (orderQty > held) {
        try {
          await this.alpacaService.cancelOrder(apiKey, apiSecret, order.id);
          canceled += 1;
          this.logger.log(
            `Orphan swept: canceled ${order.id} (${sym} sell qty=${orderQty}, held=${held}) on connection ${connection.connection_id}`,
          );
        } catch (err: any) {
          this.logger.warn(
            `Failed to cancel orphan ${order.id} on ${connection.connection_id}: ${err?.message ?? err}`,
          );
          // swallow per-order errors — next sweep will retry
        }
      }
    }

    return canceled;
  }
}
