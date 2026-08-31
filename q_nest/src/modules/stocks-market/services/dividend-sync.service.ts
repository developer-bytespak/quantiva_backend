import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';
import { FmpService, DividendInfo } from './fmp.service';
import { MarketStocksDbService } from './market-stocks-db.service';
import { CacheManagerService } from './cache-manager.service';

export interface DividendSyncResult {
  synced: number;
  failed: number;
  skipped: number;
}

/**
 * Daily dividend data sync.
 *
 * Separate from the 2 AM market-data sync on purpose: dividend data changes
 * quarterly at most (14-day freshness is plenty), and the market sync bumps
 * assets.last_seen_at for every stock every run, so its rotation ordering
 * cannot drive dividend freshness. This service rotates on its own
 * dividend_synced_at column instead.
 *
 * Primary source: FMP stable /dividends (yield + frequency + ex-date).
 * Fallback: Finnhub /stock/metric (yield only, frequency stays NULL).
 */
@Injectable()
export class DividendSyncService {
  private readonly logger = new Logger(DividendSyncService.name);
  private isRunning = false;
  private lastSyncTime: Date | null = null;
  private lastResult: DividendSyncResult | null = null;

  /** Daily FMP request budget for dividends, kept apart from the market sync's budget */
  private readonly DAILY_LIMIT = 150;
  /** Refetch a stock's dividend data when older than this */
  private readonly STALE_DAYS = 14;
  /** Pacing between per-symbol FMP calls */
  private readonly REQUEST_DELAY_MS = 350;
  /** Abort the run when this many symbols fail in a row (endpoint likely down) */
  private readonly MAX_CONSECUTIVE_FAILURES = 10;

  constructor(
    private readonly fmpService: FmpService,
    private readonly dbService: MarketStocksDbService,
    private readonly cacheManager: CacheManagerService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Runs daily at 4 AM UTC, after the 2 AM market sync and 3 AM cleanup.
   */
  @Cron('0 4 * * *', {
    name: 'dividend-data-sync',
    timeZone: 'UTC',
  })
  async handleCron() {
    await this.syncDividends();
  }

  async syncDividends(): Promise<DividendSyncResult> {
    if (this.isRunning) {
      this.logger.warn('Dividend sync already running, skipping...');
      return { synced: 0, failed: 0, skipped: 0 };
    }

    this.isRunning = true;
    const startTime = Date.now();
    const result: DividendSyncResult = { synced: 0, failed: 0, skipped: 0 };

    try {
      this.logger.log('===== Starting dividend data sync =====');

      const stocks = await this.dbService.getStocksNeedingDividendSync(
        this.DAILY_LIMIT,
        this.STALE_DAYS,
      );

      if (stocks.length === 0) {
        this.logger.log('All stocks have fresh dividend data, nothing to sync');
        return result;
      }

      this.logger.log(`Syncing dividend data for ${stocks.length} stocks`);

      let consecutiveFailures = 0;

      for (const stock of stocks) {
        let info: DividendInfo | null = await this.fmpService.getDividendInfo(
          stock.symbol,
        );

        if (!info) {
          info = await this.getFinnhubYieldFallback(stock.symbol);
        }

        if (info) {
          try {
            await this.dbService.updateDividendInfo(stock.symbol, {
              yieldPercent: info.yieldPercent,
              frequency: info.frequency,
              lastAmount: info.lastAmount,
              exDividendDate: info.exDividendDate,
            });
            result.synced++;
            consecutiveFailures = 0;
          } catch (dbError: any) {
            result.failed++;
            this.logger.warn(
              `Failed to store dividend info for ${stock.symbol}: ${dbError?.message}`,
            );
          }
        } else {
          // Both sources failed — do NOT stamp dividend_synced_at, so the
          // stock is retried on the next run (partial-sync philosophy).
          result.failed++;
          consecutiveFailures++;
          if (consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES) {
            this.logger.error(
              `Aborting dividend sync after ${consecutiveFailures} consecutive failures — dividend endpoints appear down`,
            );
            result.skipped = stocks.length - result.synced - result.failed;
            break;
          }
        }

        await this.sleep(this.REQUEST_DELAY_MS);
      }

      // Paginated stock responses are cached under market:* keys
      this.cacheManager.invalidatePattern('^market:');

      const duration = Date.now() - startTime;
      this.lastSyncTime = new Date();
      this.lastResult = result;
      this.logger.log(
        `===== Dividend sync completed in ${duration}ms: ${result.synced} synced, ${result.failed} failed, ${result.skipped} skipped =====`,
      );

      return result;
    } catch (error: any) {
      this.logger.error('Dividend sync encountered an error', {
        error: error?.message,
        stack: error?.stack,
      });
      return result;
    } finally {
      this.isRunning = false;
    }
  }

  getSyncStatus(): {
    isRunning: boolean;
    lastSyncTime: Date | null;
    lastResult: DividendSyncResult | null;
  } {
    return {
      isRunning: this.isRunning,
      lastSyncTime: this.lastSyncTime,
      lastResult: this.lastResult,
    };
  }

  /**
   * Yield-only fallback via Finnhub when FMP fails for a symbol.
   * dividendYieldIndicatedAnnual is already a percent. Frequency and ex-date
   * are unavailable here (Finnhub dividend history is a premium endpoint).
   */
  private async getFinnhubYieldFallback(
    symbol: string,
  ): Promise<DividendInfo | null> {
    const apiKey = this.configService.get<string>('FINNHUB_API_KEY');
    if (!apiKey) return null;

    try {
      const response = await axios.get('https://finnhub.io/api/v1/stock/metric', {
        params: { symbol, metric: 'all', token: apiKey },
        timeout: 10000,
      });

      const yieldRaw = response.data?.metric?.dividendYieldIndicatedAnnual;
      if (yieldRaw === undefined || yieldRaw === null) return null;

      const yieldPercent = Number(yieldRaw);
      if (!Number.isFinite(yieldPercent)) return null;

      return {
        yieldPercent,
        frequency: null,
        lastAmount: null,
        exDividendDate: null,
        isPayer: yieldPercent > 0,
      };
    } catch (error: any) {
      this.logger.debug(
        `Finnhub dividend fallback failed for ${symbol}: ${error?.message}`,
      );
      return null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
