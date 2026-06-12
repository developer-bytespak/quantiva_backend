import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { ExchangesService } from '../exchanges/exchanges.service';

/**
 * Real-Holdings Sync (foundation for price-move alerts + new-signal alerts).
 *
 * Real holdings are not stored anywhere — they live in each user's broker account.
 * This cron snapshots them into `user_holdings` every ~15 min so the alert features can
 * answer "who holds asset X?" with a fast DB query instead of per-request broker calls.
 *
 * Reuses the EXISTING per-connection fetch (`ExchangesService.getConnectionData`), which
 * already decrypts keys and routes Alpaca (stocks) + Binance/ByBit (crypto). No new broker code.
 *
 * At ~150 connected users this simple poll is cheap (each call hits that user's OWN API key —
 * no shared rate limit). Scale-up path: event-driven updates off the Binance user-data-stream.
 */
@Injectable()
export class UserHoldingsService {
  private readonly logger = new Logger(UserHoldingsService.name);

  // Common crypto quote currencies to strip when mapping a broker pair (e.g. BTCUSDT) to a base
  // symbol (BTC) for the `assets` lookup. Longest-first so USDT matches before USD.
  private static readonly QUOTE_SUFFIXES = ['USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD', 'USD'];

  constructor(
    private readonly prisma: PrismaService,
    private readonly exchanges: ExchangesService,
    private readonly config: ConfigService,
  ) {}

  @Cron('*/15 * * * *', { name: 'user-holdings-sync' })
  async scheduledSync(): Promise<void> {
    if (this.config.get('ENABLE_CRONS') === 'false') return;
    await this.syncAllHoldings();
  }

  /**
   * Sync real holdings for every active broker connection. Per-connection try/catch so one
   * bad/expired key never aborts the whole run.
   */
  async syncAllHoldings(): Promise<{ connections: number; ok: number; failed: number }> {
    const connections = await this.prisma.user_exchange_connections.findMany({
      where: { status: 'active' },
      select: {
        connection_id: true,
        user_id: true,
        exchange: { select: { name: true } },
      },
    });

    this.logger.log(`Holdings sync: ${connections.length} active connection(s)`);
    const assetIdCache = new Map<string, string | null>();
    let ok = 0;
    let failed = 0;

    for (const conn of connections) {
      const exchangeName = conn.exchange?.name ?? 'unknown';
      try {
        await this.syncConnection(conn.connection_id, conn.user_id, exchangeName, assetIdCache);
        ok++;
      } catch (err: any) {
        failed++;
        this.logger.warn(
          `Holdings sync failed for connection ${conn.connection_id} (${exchangeName}): ${err?.message ?? err}`,
        );
      }
    }

    this.logger.log(`Holdings sync done: ${ok} ok, ${failed} failed`);
    return { connections: connections.length, ok, failed };
  }

  /** Sync one connection's holdings: upsert held symbols, delete sold-off ones. */
  private async syncConnection(
    connectionId: string,
    userId: string,
    exchangeName: string,
    assetIdCache: Map<string, string | null>,
  ): Promise<void> {
    const isStock = exchangeName.toLowerCase() === 'alpaca';
    const assetType = isStock ? 'stock' : 'crypto';

    const raw = (await this.exchanges.getConnectionData(connectionId, 'positions')) as any[];
    const positions = Array.isArray(raw) ? raw : [];

    // Normalize defensively — crypto returns { symbol, quantity }, Alpaca returns { symbol, qty }.
    const held = positions
      .map((p) => ({
        symbol: String(p?.symbol ?? '').toUpperCase(),
        quantity: Number(p?.quantity ?? p?.qty ?? 0),
      }))
      .filter((p) => p.symbol && Number.isFinite(p.quantity) && p.quantity > 0);

    // Upsert each held symbol.
    for (const pos of held) {
      const assetId = await this.resolveAssetId(pos.symbol, assetType, assetIdCache);
      await this.prisma.user_holdings.upsert({
        where: {
          user_id_symbol_exchange: { user_id: userId, symbol: pos.symbol, exchange: exchangeName },
        },
        create: {
          user_id: userId,
          symbol: pos.symbol,
          asset_type: assetType,
          asset_id: assetId,
          quantity: pos.quantity,
          exchange: exchangeName,
        },
        update: {
          quantity: pos.quantity,
          asset_id: assetId,
          asset_type: assetType,
          updated_at: new Date(),
        },
      });
    }

    // Delete rows for symbols the user no longer holds on this exchange.
    const heldSymbols = held.map((h) => h.symbol);
    await this.prisma.user_holdings.deleteMany({
      where: {
        user_id: userId,
        exchange: exchangeName,
        ...(heldSymbols.length > 0 ? { symbol: { notIn: heldSymbols } } : {}),
      },
    });
  }

  /**
   * Resolve a broker symbol to an `assets.asset_id` (needed for the signal-alert join).
   * Crypto pairs (BTCUSDT) are reduced to their base (BTC). Returns null if unmapped —
   * price alerts still work on symbol alone; only signal alerts need the asset_id.
   */
  private async resolveAssetId(
    symbol: string,
    assetType: string,
    cache: Map<string, string | null>,
  ): Promise<string | null> {
    const base = assetType === 'crypto' ? this.toBaseSymbol(symbol) : symbol;
    const cacheKey = `${assetType}:${base}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey)!;

    const asset = await this.prisma.assets.findFirst({
      where: { symbol: { equals: base, mode: 'insensitive' } },
      select: { asset_id: true },
    });
    const assetId = asset?.asset_id ?? null;
    cache.set(cacheKey, assetId);
    return assetId;
  }

  private toBaseSymbol(pair: string): string {
    const upper = pair.toUpperCase();
    for (const quote of UserHoldingsService.QUOTE_SUFFIXES) {
      if (upper.length > quote.length && upper.endsWith(quote)) {
        return upper.slice(0, -quote.length);
      }
    }
    return upper;
  }
}
