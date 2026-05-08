import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../exchanges/services/encryption.service';
import { BinanceService } from '../exchanges/integrations/binance.service';
import { BinanceUSService } from '../exchanges/integrations/binance-us.service';
import { BybitService } from '../exchanges/integrations/bybit.service';
import { AlpacaService } from '../exchanges/integrations/alpaca.service';

const STABLES = new Set([
  'USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'FDUSD', 'USDP', 'USD',
]);

export interface DiscoveredHoldings {
  /** symbol → distinct user_id count */
  crypto: Map<string, number>;
  /** symbol → distinct user_id count */
  stock: Map<string, number>;
  /** Diagnostic: connections processed / failed counts */
  stats: {
    totalConnections: number;
    succeeded: number;
    failed: number;
    skipped: number;
  };
}

/**
 * Discovers what symbols Quantiva users currently hold across all their
 * connected exchanges (Binance, Binance.US, Bybit, Alpaca).
 *
 * Holdings only exist on the live exchange APIs — `portfolio_positions` is
 * unused by Quantiva — so this service iterates `user_exchange_connections`
 * and asks each exchange directly. It is meant to run from cron, not from
 * the user request path.
 *
 * Per-connection failures (revoked API keys, rate limits, network blips)
 * are caught and skipped so one bad connection cannot poison the run.
 */
@Injectable()
export class ExchangePositionsDiscoveryService {
  private readonly logger = new Logger(ExchangePositionsDiscoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly binance: BinanceService,
    private readonly binanceUS: BinanceUSService,
    private readonly bybit: BybitService,
    private readonly alpaca: AlpacaService,
  ) {}

  async discoverAll(): Promise<DiscoveredHoldings> {
    const connections = await this.prisma.user_exchange_connections.findMany({
      where: { status: 'active' as any },
      include: { exchange: true },
    });

    this.logger.log(
      `discoverAll: iterating ${connections.length} active connection(s)`,
    );

    // user_id → Set<symbol> per asset type, so a user holding the same coin
    // on two exchanges is counted once.
    const cryptoByUser = new Map<string, Set<string>>();
    const stockByUser = new Map<string, Set<string>>();

    const stats = { totalConnections: connections.length, succeeded: 0, failed: 0, skipped: 0 };

    const tasks = connections.map(async (conn) => {
      try {
        const exName = (conn.exchange?.name || '').toLowerCase().trim();
        if (!exName) {
          stats.skipped++;
          return;
        }

        // OAuth not currently implemented for any of the four exchanges, but
        // skip defensively if a future connection lacks api_key.
        if (!conn.api_key_encrypted || !conn.api_secret_encrypted) {
          stats.skipped++;
          this.logger.debug(
            `skip ${conn.connection_id} (${exName}): no api_key/secret`,
          );
          return;
        }

        const apiKey = this.encryption.decryptApiKey(conn.api_key_encrypted);
        const apiSecret = this.encryption.decryptApiKey(conn.api_secret_encrypted);

        const { crypto, stock } = await this.fetchSymbolsForConnection(
          exName,
          apiKey,
          apiSecret,
        );

        if (crypto.length > 0) {
          const set = cryptoByUser.get(conn.user_id) ?? new Set<string>();
          for (const s of crypto) set.add(s);
          cryptoByUser.set(conn.user_id, set);
        }
        if (stock.length > 0) {
          const set = stockByUser.get(conn.user_id) ?? new Set<string>();
          for (const s of stock) set.add(s);
          stockByUser.set(conn.user_id, set);
        }
        stats.succeeded++;
      } catch (err: any) {
        stats.failed++;
        this.logger.warn(
          `connection ${conn.connection_id} (${conn.exchange?.name}) failed: ${err?.message}`,
        );
      }
    });

    await Promise.allSettled(tasks);

    // Tally distinct holders per symbol.
    const cryptoCounts = new Map<string, number>();
    for (const symbols of cryptoByUser.values()) {
      for (const s of symbols) {
        cryptoCounts.set(s, (cryptoCounts.get(s) ?? 0) + 1);
      }
    }
    const stockCounts = new Map<string, number>();
    for (const symbols of stockByUser.values()) {
      for (const s of symbols) {
        stockCounts.set(s, (stockCounts.get(s) ?? 0) + 1);
      }
    }

    this.logger.log(
      `discoverAll: done — connections ok=${stats.succeeded} fail=${stats.failed} skip=${stats.skipped}; ` +
        `unique crypto=${cryptoCounts.size} stock=${stockCounts.size}`,
    );

    return { crypto: cryptoCounts, stock: stockCounts, stats };
  }

  /** Returns base symbols (e.g. "BTC", "AAPL") split by asset type. */
  private async fetchSymbolsForConnection(
    exchangeName: string,
    apiKey: string,
    apiSecret: string,
  ): Promise<{ crypto: string[]; stock: string[] }> {
    if (exchangeName === 'binance') {
      const acc = await this.binance.getAccountInfo(apiKey, apiSecret);
      const positions = await this.binance.getPositionsFromAccount(apiKey, apiSecret, acc);
      return { crypto: this.normalizeBaseSymbols(positions.map((p) => p.symbol)), stock: [] };
    }

    if (exchangeName === 'binance.us' || exchangeName === 'binanceus' || exchangeName === 'binance-us') {
      const acc = await this.binanceUS.getAccountInfo(apiKey, apiSecret);
      const positions = await this.binanceUS.getPositionsFromAccount(apiKey, apiSecret, acc);
      return { crypto: this.normalizeBaseSymbols(positions.map((p) => p.symbol)), stock: [] };
    }

    if (exchangeName === 'bybit') {
      const acc = await this.bybit.getAccountInfo(apiKey, apiSecret);
      const positions = await this.bybit.getPositionsFromAccount(apiKey, apiSecret, acc);
      return { crypto: this.normalizeBaseSymbols(positions.map((p) => p.symbol)), stock: [] };
    }

    if (exchangeName === 'alpaca') {
      // Alpaca's getPositions returns the raw shape with asset_class,
      // unlike the other three which already map to PositionDto.
      const raw = await this.alpaca.getPositions(apiKey, apiSecret);
      const crypto: string[] = [];
      const stock: string[] = [];
      for (const p of raw || []) {
        const cls = p?.asset_class ?? 'us_equity';
        if (cls === 'us_option') continue; // out of scope for news
        const base = this.baseSymbol(p?.symbol);
        if (!base) continue;
        if (cls === 'crypto') crypto.push(base);
        else stock.push(base);
      }
      return { crypto: this.dedupeAndFilter(crypto), stock: this.dedupeAndFilter(stock) };
    }

    this.logger.debug(`unknown exchange '${exchangeName}', skipping`);
    return { crypto: [], stock: [] };
  }

  private normalizeBaseSymbols(symbols: (string | undefined | null)[]): string[] {
    return this.dedupeAndFilter(symbols.map((s) => this.baseSymbol(s)));
  }

  private dedupeAndFilter(symbols: string[]): string[] {
    const out = new Set<string>();
    for (const s of symbols) {
      if (!s) continue;
      if (STABLES.has(s)) continue;
      out.add(s);
    }
    return [...out];
  }

  /**
   * Strip exchange suffixes / quote-currency separators from a raw symbol so
   * "BTCUSDT", "BTC/USD", "btc" all resolve to "BTC". Returns "" when the
   * input is empty.
   */
  private baseSymbol(raw: string | undefined | null): string {
    let s = (raw || '').toUpperCase().trim();
    if (!s) return '';
    if (s.includes('/')) s = s.split('/')[0]!; // "BTC/USD" → "BTC"
    s = s.replace(/USDT$/, '').replace(/BUSD$/, '').replace(/USDC$/, '');
    // Strip a trailing USD only when there's another letter before it
    // (so we don't shrink the 3-letter ticker "USD" itself to empty).
    if (/[A-Z]USD$/.test(s)) s = s.slice(0, -3);
    return s;
  }
}
