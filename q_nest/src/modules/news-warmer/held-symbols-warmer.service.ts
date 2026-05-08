import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { NewsService } from '../news/news.service';
import { ExchangePositionsDiscoveryService } from './exchange-positions-discovery.service';

/**
 * Refreshes news for symbols that any user is currently holding so that the
 * "View Insight per held position" popup can serve fresh data from
 * `trending_news` without making an upstream call on the user's request path.
 *
 * Quota math (validated against the LunarCrush Individual plan: 8 rpm,
 * 1,600 calls/day):
 *   - Crypto cap: top 100 most-held coins, refreshed every 2h (max 1,200/day).
 *   - Stocks: every held ticker, refreshed every 1h, batched 50 per call
 *     against StockNewsAPI (~50–250 calls/day for typical loads).
 *
 * Rate-limit defense in depth: every upstream call goes through the existing
 * Python-side LunarCrushQuotaGate / StockNewsQuotaGate. If budget is exhausted
 * the gate denies, the call returns empty, and we just continue the loop.
 */
@Injectable()
export class HeldSymbolsWarmerService {
  private readonly logger = new Logger(HeldSymbolsWarmerService.name);

  // Knobs — keep these conservative; the plan's locked cadence is 2h crypto / 1h stocks.
  private readonly CRYPTO_HOT_CAP = 100;
  private readonly STOCK_BATCH_SIZE = 50;
  private readonly PER_COIN_DELAY_MS = 8000; // ~7.5 calls/min, under the 8 rpm cap

  constructor(
    private readonly newsService: NewsService,
    private readonly discovery: ExchangePositionsDiscoveryService,
    private readonly config: ConfigService,
  ) {}

  private get cronsEnabled(): boolean {
    return this.config.get('ENABLE_CRONS') !== 'false';
  }

  /** Crypto warmer — top 100 most-held coins, every 2 hours, on the hour. */
  @Cron('0 */2 * * *')
  async warmCryptoHeldSymbols(): Promise<void> {
    if (!this.cronsEnabled) return;

    let symbols: string[] = [];
    try {
      const { crypto } = await this.discovery.discoverAll();
      // Sort by holdersCount DESC so we refresh the most-held first; if the
      // quota gate trips later in the loop, the popular coins still got refreshed.
      symbols = [...crypto.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, this.CRYPTO_HOT_CAP)
        .map(([s]) => s);
    } catch (err: any) {
      this.logger.error(`Failed to discover held crypto symbols: ${err?.message}`);
      return;
    }

    if (symbols.length === 0) {
      this.logger.log('warmCryptoHeldSymbols: no held crypto symbols found, nothing to refresh');
      return;
    }

    this.logger.log(
      `warmCryptoHeldSymbols: refreshing ${symbols.length} symbol(s) (cap=${this.CRYPTO_HOT_CAP})`,
    );

    let ok = 0;
    let fail = 0;
    for (const symbol of symbols) {
      try {
        await this.newsService.fetchAndStoreNewsFromPython(symbol, 20);
        ok++;
      } catch (err: any) {
        fail++;
        this.logger.warn(`warmCryptoHeldSymbols: ${symbol} failed: ${err?.message}`);
      }
      // Throttle to stay under the 8 rpm LunarCrush cap. The Python-side gate
      // is the actual enforcer; this just avoids unnecessary 429s.
      await this.sleep(this.PER_COIN_DELAY_MS);
    }

    this.logger.log(`warmCryptoHeldSymbols: done — ok=${ok} fail=${fail}`);
  }

  /** Stocks warmer — all held tickers, batched, every 1 hour. */
  @Cron('0 * * * *')
  async warmStockHeldSymbols(): Promise<void> {
    if (!this.cronsEnabled) return;

    let symbols: string[] = [];
    try {
      const { stock } = await this.discovery.discoverAll();
      symbols = [...stock.keys()];
    } catch (err: any) {
      this.logger.error(`Failed to discover held stock symbols: ${err?.message}`);
      return;
    }

    if (symbols.length === 0) {
      this.logger.log('warmStockHeldSymbols: no held stock symbols found, nothing to refresh');
      return;
    }

    const chunks = this.chunk(symbols, this.STOCK_BATCH_SIZE);
    this.logger.log(
      `warmStockHeldSymbols: refreshing ${symbols.length} ticker(s) in ${chunks.length} batch(es)`,
    );

    let okBatches = 0;
    let failBatches = 0;
    for (const tickers of chunks) {
      try {
        await this.newsService.fetchAndStoreGeneralStockNewsFromPython(50, tickers);
        okBatches++;
      } catch (err: any) {
        failBatches++;
        this.logger.warn(
          `warmStockHeldSymbols: batch [${tickers.slice(0, 3).join(',')}…] failed: ${err?.message}`,
        );
      }
    }

    this.logger.log(
      `warmStockHeldSymbols: done — batches ok=${okBatches} fail=${failBatches}`,
    );
  }

  private chunk<T>(arr: T[], size: number): T[][] {
    if (size <= 0) return [arr];
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((res) => setTimeout(res, ms));
  }
}
