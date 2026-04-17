import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { PythonApiService } from '../../kyc/integrations/python-api.service';
import { BinanceService } from '../binance/binance.service';
import { NewsService } from './news.service';

@Injectable()
export class NewsCronjobService {
  private readonly logger = new Logger(NewsCronjobService.name);
  private readonly BATCH_SIZE = 3;
  private readonly BATCH_DELAY_MS = 5000;
  private readonly MAX_ASSETS_PER_RUN = 15;
  private readonly UPDATE_INTERVAL_MINUTES = 30;

  constructor(
    private prisma: PrismaService,
    private pythonApi: PythonApiService,
    private binanceService: BinanceService,
    private newsService: NewsService,
    private config: ConfigService,
  ) {}

  private get cronsEnabled(): boolean {
    return this.config.get('ENABLE_CRONS') !== 'false';
  }

  /**
   * Finnhub Trending Stocks Sync - Runs every 10 minutes
   * Fetches top 50 trending stocks from Finnhub via Python API
   * and stores them in trending_assets table
   */
  @Cron('*/10 * * * *') // Every 10 minutes
  async syncTrendingStocksFromFinnhub(): Promise<void> {
    if (!this.cronsEnabled) return;
    try {
      const response = await this.pythonApi.get('/stocks/trending', {
        params: { limit: 50 },
        timeout: 30000,
      });

      const trendingStocks = response.data?.stocks || response.data || [];

      if (!Array.isArray(trendingStocks) || trendingStocks.length === 0) {
        return;
      }

      let successCount = 0;
      let errorCount = 0;

      // Process each stock
      for (const stock of trendingStocks) {
        try {
          const symbol = stock.symbol?.toUpperCase();
          if (!symbol) {
            errorCount++;
            continue;
          }

          // Find or create asset
          let asset = await this.prisma.assets.findFirst({
            where: {
              symbol: symbol,
              asset_type: 'stock',
            },
          });

          if (!asset) {
            // Create new stock asset
            asset = await this.prisma.assets.create({
              data: {
                symbol: symbol,
                name: stock.name || symbol,
                display_name: stock.name || symbol,
                asset_type: 'stock',
                is_active: true,
                first_seen_at: new Date(),
                last_seen_at: new Date(),
              },
            });
          } else {
            // Update last seen timestamp
            await this.prisma.assets.update({
              where: { asset_id: asset.asset_id },
              data: { last_seen_at: new Date() },
            });
          }

          // Insert or update trending_assets entry
          const pollTimestamp = new Date();

          await this.prisma.trending_assets.upsert({
            where: {
              poll_timestamp_asset_id: {
                poll_timestamp: pollTimestamp,
                asset_id: asset.asset_id,
              },
            },
            create: {
              poll_timestamp: pollTimestamp,
              asset_id: asset.asset_id,
              price_usd: stock.price || null,
              price_change_24h: stock.change_percent || null,
              market_volume: stock.volume || null,
              volume_24h: stock.volume || null,
              high_24h: stock.high || null,
              low_24h: stock.low || null,
              trend_rank: stock.mention_count || null,
            },
            update: {
              price_usd: stock.price || null,
              price_change_24h: stock.change_percent || null,
              market_volume: stock.volume || null,
              volume_24h: stock.volume || null,
              high_24h: stock.high || null,
              low_24h: stock.low || null,
              trend_rank: stock.mention_count || null,
            },
          });

          successCount++;
        } catch (err: any) {
          errorCount++;
        }
      }
    } catch (error: any) {
      // Fatal sync failure - silent
    }
  }

  /**
   * News Sentiment Aggregation Cronjob - DISABLED (was: every 10 min, 15 assets × 2 calls).
   * The per-coin loop burned ~4,320 LunarCrush calls/day (plan cap is 2,000). Replaced by
   * the bulk `aggregateGeneralCryptoNews` cron further down that calls
   * LunarCrush /public/topic/cryptocurrency/news/v1 once per run.
   * Method body kept so the manual trigger (`triggerManualAggregation`) still works.
   */
  // @Cron('*/10 * * * *') // DISABLED - see comment above
  async aggregateNewsForTopSymbols(): Promise<void> {
    let processedCount = 0;
    let errorCount = 0;

    try {
      // Get active assets from database, ordered by recent activity
      const activeAssets = await this.prisma.trending_assets.findMany({
        where: {
          asset: {
            is_active: true,
            asset_type: 'crypto',
          },
        },
        include: {
          asset: {
            select: {
              symbol: true,
              asset_type: true,
            },
          },
        },
        orderBy: {
          poll_timestamp: 'desc', // Most recently updated first
        },
        distinct: ['asset_id'],
        take: this.MAX_ASSETS_PER_RUN * 2, // Get 2x to filter duplicates
      });

      // Extract unique symbols
      const symbolsSet = new Set<string>();
      const symbols: string[] = [];
      
      for (const asset of activeAssets) {
        const symbol = asset.asset?.symbol;
        if (symbol && !symbolsSet.has(symbol) && asset.asset?.asset_type === 'crypto') {
          symbolsSet.add(symbol);
          symbols.push(symbol);
          if (symbols.length >= this.MAX_ASSETS_PER_RUN) break;
        }
      }

      if (symbols.length === 0) {
        const allAssets = await this.prisma.assets.findMany({
          where: {
            is_active: true,
            asset_type: 'crypto',
          },
          orderBy: {
            symbol: 'asc',
          },
          take: this.MAX_ASSETS_PER_RUN,
        });
        symbols.push(...allAssets.map(a => a.symbol));
      }

      if (symbols.length === 0) {
        return;
      }

      for (let i = 0; i < symbols.length; i += this.BATCH_SIZE) {
        const batch = symbols.slice(i, i + this.BATCH_SIZE);

        await Promise.all(
          batch.map(async (symbol) => {
            try {
              await this.newsService.fetchAndStoreNewsFromPython(symbol, 20);
              processedCount++;
            } catch (error: any) {
              errorCount++;
            }
          }),
        );

        if (i + this.BATCH_SIZE < symbols.length) {
          await this.sleep(this.BATCH_DELAY_MS);
        }
      }
    } catch (error: any) {
      // Fatal error - silent
    }
  }

  /**
   * Bulk general-crypto news aggregation — every 30 minutes.
   *
   * Replaces the two disabled per-coin crons above. Makes a SINGLE LunarCrush
   * call (via Python `/api/v1/news/crypto/general`, which internally hits
   * `/public/topic/cryptocurrency/news/v1`) and upserts rows into
   * `trending_news` linked to a synthetic "__GENERAL__" asset. The frontend
   * AI-insights page reads this feed through `getAllNewsFromDB()` exactly
   * as before.
   *
   * Budget impact: 1 LunarCrush call × 48 runs/day = 48 calls/day, vs. the
   * ~18,700/day the two disabled crons consumed.
   */
  @Cron('*/30 * * * *') // Every 30 minutes
  async aggregateGeneralCryptoNews(): Promise<void> {
    if (!this.cronsEnabled) return;
    try {
      const result = await this.newsService.refreshGeneralCryptoNewsFeed(50);
      this.logger.log(
        `[aggregateGeneralCryptoNews] fetched=${result.fetched} inserted=${result.inserted} skipped=${result.skipped}`,
      );
    } catch (error: any) {
      this.logger.error(
        `[aggregateGeneralCryptoNews] failed: ${error?.message || error}`,
      );
    }
  }

  /**
   * Per-asset sentiment aggregation - DISABLED (was: every 10 min, ALL crypto assets).
   * This cron iterated every active crypto asset and triggered a per-coin LunarCrush
   * fetch inside the sentiment engine, burning ~14,400 calls/day on its own. Replaced
   * by the bulk `snapshotSocialMetricsBulk` cron that hits /public/coins/list/v1 once
   * every 6 hours. Method body kept for potential manual invocation.
   */
  // @Cron('*/10 * * * *') // DISABLED - see comment above
  async aggregateNewsSentiment(): Promise<void> {
    let processedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    try {
      // Calculate cutoff time (30 minutes ago)
      const cutoffTime = new Date(Date.now() - this.UPDATE_INTERVAL_MINUTES * 60 * 1000);

      // Get CRYPTO assets only (stocks handled by aggregateStockNews)
      const assets = await this.prisma.assets.findMany({
        where: { 
          is_active: true,
          asset_type: 'crypto', // Only crypto assets
        },
        include: {
          trending_assets: {
            orderBy: { poll_timestamp: 'desc' },
            take: 1,
          },
        },
      });

      // Filter: Skip assets updated within the interval
      const assetsToProcess = assets.filter((asset) => {
        const latestPoll = asset.trending_assets?.[0]?.poll_timestamp;
        if (!latestPoll || latestPoll < cutoffTime) {
          return true; // Process: No recent data
        }
        skippedCount++;
        return false;
      });

      for (let i = 0; i < assetsToProcess.length; i += this.BATCH_SIZE) {
        const batch = assetsToProcess.slice(i, i + this.BATCH_SIZE);

        await Promise.all(
          batch.map(async (asset) => {
            try {
              await this.processAssetSentiment(
                asset.asset_id,
                asset.symbol,
                asset.asset_type,
              );
              processedCount++;
            } catch (error: any) {
              errorCount++;
            }
          }),
        );

        if (i + this.BATCH_SIZE < assetsToProcess.length) {
          await this.sleep(500);
        }
      }
    } catch (error: any) {
      // Fatal error - silent
    }
  }

  /**
   * Bulk social-metrics snapshot — every 6 hours.
   *
   * Fires ONE LunarCrush call (via Python `/api/v1/market/social-bulk`,
   * which internally hits `/public/coins/list/v1`) that returns metrics for
   * the whole coin universe. For each symbol we have locally as an active
   * crypto asset, we write a `trending_assets` row with the fresh galaxy /
   * alt_rank / price / market_cap numbers. Python also warms its per-symbol
   * in-memory cache so the engines stop hitting LunarCrush for social data.
   *
   * Budget impact: 1 call × 4 runs/day = 4 LunarCrush calls/day. Replaces
   * the per-asset `fetch_social_metrics` loop that burned hundreds/day.
   */
  @Cron('0 */6 * * *') // Every 6 hours on the hour
  async snapshotSocialMetricsBulk(): Promise<void> {
    if (!this.cronsEnabled) return;
    try {
      const response = await this.pythonApi.post<{
        count: number;
        fetched_at: string;
        metrics?: Record<string, any>;
      }>(
        '/api/v1/market/social-bulk',
        { include_metrics: true },
        { timeout: 120000 },
      );

      const metricsMap = response.data?.metrics || {};
      const symbols = Object.keys(metricsMap);
      if (symbols.length === 0) {
        this.logger.warn('[snapshotSocialMetricsBulk] empty metrics map; skipping');
        return;
      }

      // Only snapshot for assets already in our DB
      const assets = await this.prisma.assets.findMany({
        where: {
          asset_type: 'crypto',
          is_active: true,
          symbol: { in: symbols },
        },
        select: { asset_id: true, symbol: true },
      });

      const pollTimestamp = new Date();
      let written = 0;
      let errors = 0;

      for (const asset of assets) {
        if (!asset.symbol) continue;
        const m = metricsMap[asset.symbol.toUpperCase()];
        if (!m) continue;

        try {
          await this.prisma.trending_assets.create({
            data: {
              poll_timestamp: new Date(pollTimestamp.getTime() + written),
              asset_id: asset.asset_id,
              galaxy_score: m.galaxy_score ?? null,
              alt_rank: m.alt_rank ?? null,
              social_score: m.social_score ?? null,
              market_volume: m.volume_24h ?? null,
              price_usd: m.price ?? null,
              price_change_24h: m.price_change_24h ?? null,
              volume_24h: m.volume_24h ?? null,
              market_cap: m.market_cap ?? null,
            },
          });
          written++;
        } catch (err: any) {
          // Most likely a unique-key collision on (poll_timestamp, asset_id)
          errors++;
        }
      }

      this.logger.log(
        `[snapshotSocialMetricsBulk] bulk=${response.data?.count ?? 0} matched=${assets.length} written=${written} errors=${errors}`,
      );
    } catch (error: any) {
      this.logger.error(
        `[snapshotSocialMetricsBulk] failed: ${error?.message || error}`,
      );
    }
  }

  /**
   * Process sentiment for a single asset
   */
  private async processAssetSentiment(
    assetId: string,
    symbol: string | null,
    assetType: string | null,
  ): Promise<void> {
    if (!symbol || !assetType) {
      return;
    }

    try {
      // Call Python API to analyze sentiment
      const response = await this.pythonApi.post('/api/v1/sentiment/analyze', {
        asset_id: symbol,
        asset_type: assetType,
      });

      const sentimentData = response.data;

      if (!sentimentData || sentimentData.score === undefined) {
        return;
      }

      // Extract metadata
      const metadata = sentimentData.metadata || {};
      const emaData = metadata.ema || {};
      const latestArticle = this.extractLatestArticle(metadata);

      // Map source to enum
      const sourceEnum = this.mapSourceToEnum(metadata.news_source, assetType);
      
      // Map sentiment label to enum
      const sentimentLabelEnum = this.mapSentimentToEnum(metadata.overall_sentiment);

      // Create new record in trending_news table (tracking sentiment over time)
      const pollTimestamp = new Date();

      await this.prisma.trending_news.create({
        data: {
          poll_timestamp: pollTimestamp,
          asset_id: assetId,
          news_sentiment: sentimentData.score,
          news_score: sentimentData.score,
          news_volume: metadata.total_texts || 0,
          heading: latestArticle?.title || null,
          news_detail: metadata,
          source: sourceEnum as any, // Type assertion until Prisma client is regenerated
          article_url: latestArticle?.url || null,
          published_at: latestArticle?.published_at
            ? new Date(latestArticle.published_at)
            : null,
          sentiment_label: sentimentLabelEnum as any, // Type assertion until Prisma client is regenerated
          metadata: {
            ema: emaData,
            momentum: emaData.momentum,
            layer_breakdown: metadata.layer_breakdown,
            keyword_analysis: metadata.keyword_analysis,
            market_signals: metadata.market_signals,
          },
        } as any, // Type assertion until Prisma client is regenerated after migration
      });

      // Store market metrics in trending_assets table for top trades discovery
      const socialMetrics = metadata.social_metrics || {};
      if (Object.keys(socialMetrics).length > 0) {
        try {
          // Fetch enriched market data from Binance
          let marketData = null;
          if (symbol && assetType === 'crypto') {
            try {
              marketData = await this.binanceService.getEnrichedMarketData(symbol);
            } catch (error: any) {
              // Skip Binance fetch
            }
          }

          await this.prisma.trending_assets.create({
            data: {
              poll_timestamp: pollTimestamp,
              asset_id: assetId,
              galaxy_score: socialMetrics.galaxy_score || null,
              alt_rank: socialMetrics.alt_rank || null,
              social_score: socialMetrics.social_score || null,
              market_volume: socialMetrics.volume_24h || null,
              price_usd: socialMetrics.price || (marketData ? marketData.price : null),
              // New market data fields
              price_change_24h: marketData?.priceChangePercent || null,
              price_change_24h_usd: marketData ? (marketData.price * (marketData.priceChangePercent / 100)) : null,
              volume_24h: marketData?.volume24h || socialMetrics.volume_24h || null,
              high_24h: marketData?.high24h || null,
              low_24h: marketData?.low24h || null,
              market_cap: null,
            },
          });
        } catch (error: any) {
          if (!error.message?.includes('Unique constraint')) {
            // Skip storage error
          }
        }
      }

    } catch (error: any) {
      throw error;
    }
  }

  /**
   * Extract latest article from metadata
   */
  private extractLatestArticle(metadata: any): any {
    // Try to get latest article from individual_ml_results or other sources
    const mlResults = metadata.individual_ml_results || [];
    if (mlResults.length > 0) {
      // Return the first result (assuming they're sorted by date)
      return {
        title: mlResults[0].source || 'News Article',
        url: null,
        published_at: null,
      };
    }
    return null;
  }

  /**
   * Manually trigger sentiment aggregation (for debugging/testing)
   * Enhanced with symbol-specific refresh
   */
  async triggerManualAggregation(specificSymbol?: string): Promise<{
    message: string;
    processed: number;
    skipped: number;
    errors: number;
  }> {
    let processedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    try {
      if (specificSymbol) {
        try {
          await this.newsService.fetchAndStoreNewsFromPython(specificSymbol.toUpperCase(), 20);
          processedCount++;
        } catch (error: any) {
          errorCount++;
        }
      } else {
        return {
          message: 'Manual aggregation requires a specific symbol',
          processed: 0,
          skipped: 0,
          errors: 0,
        };
      }

      return {
        message: 'Manual aggregation completed',
        processed: processedCount,
        skipped: skippedCount,
        errors: errorCount,
      };
    } catch (error: any) {
      throw error;
    }
  }

  /**
   * Map source string to NewsSource enum
   * Only supports StockNewsAPI and LunarCrush
   */
  private mapSourceToEnum(source: string, assetType: string | null): any {
    if (!source) {
      // Default based on asset type
      return assetType === 'stock' ? 'StockNewsAPI' : 'LunarCrush';
    }
    
    const sourceLower = source.toLowerCase();
    
    if (sourceLower.includes('stock_news') || sourceLower.includes('stocknews') || sourceLower.includes('stock_news_api')) {
      return 'StockNewsAPI';
    } else if (sourceLower.includes('lunarcrush') || sourceLower.includes('lunar')) {
      return 'LunarCrush';
    } else {
      // Default based on asset type if source doesn't match
      return assetType === 'stock' ? 'StockNewsAPI' : 'LunarCrush';
    }
  }

  /**
   * Sleep utility for delays between batches
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Map sentiment string to SentimentLabel enum
   */
  private mapSentimentToEnum(sentiment: string): any {
    if (!sentiment) return null;
    
    const sentimentLower = sentiment.toLowerCase();
    
    if (sentimentLower === 'positive') {
      return 'positive';
    } else if (sentimentLower === 'negative') {
      return 'negative';
    } else if (sentimentLower === 'neutral') {
      return 'neutral';
    }
    
    return null;
  }

  // ============== STOCK NEWS CRONJOB ==============

  /**
   * Stock News Aggregation Cronjob — every 30 minutes, 30 symbols.
   *
   * Combined with the Python-side 2-hour cache, only symbols whose cache
   * has expired actually hit StockNewsAPI. In steady state: ~2-3 symbols
   * per run × 48 runs/day = ~100-150 real API calls/day.
   *
   * Expanded from 10 → 30 popular US stocks to give the AI insights and
   * sentiment engines broader stock market coverage.
   */
  @Cron('*/30 * * * *')
  async aggregateStockNews(): Promise<void> {
    if (!this.cronsEnabled) return;

    const stockSymbols = [
      // Mega-cap tech
      'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA',
      // Other mega-cap
      'BRK.B', 'JPM', 'V', 'JNJ', 'UNH', 'WMT', 'PG',
      // Growth / popular
      'AMD', 'NFLX', 'DIS', 'PYPL', 'SQ', 'SHOP', 'COIN',
      // Energy / industrial
      'XOM', 'CVX', 'BA',
      // Finance / health
      'GS', 'MS', 'PFE', 'ABBV',
      // ETFs (broad market indicators)
      'SPY', 'QQQ',
    ];

    const STOCK_BATCH_SIZE = 3;
    let processedCount = 0;
    let errorCount = 0;

    try {
      for (let i = 0; i < stockSymbols.length; i += STOCK_BATCH_SIZE) {
        const batch = stockSymbols.slice(i, i + STOCK_BATCH_SIZE);

        for (const symbol of batch) {
          try {
            await this.newsService.fetchAndStoreStockNewsFromPython(symbol, 10);
            processedCount++;
          } catch (error: any) {
            errorCount++;
          }
        }

        if (i + STOCK_BATCH_SIZE < stockSymbols.length) {
          await this.sleep(3000);
        }
      }

      this.logger.log(
        `[aggregateStockNews] processed=${processedCount} errors=${errorCount}`,
      );
    } catch (error: any) {
      this.logger.error(`[aggregateStockNews] failed: ${error?.message || error}`);
    }
  }

  /**
   * Manually trigger stock news aggregation
   * Default is just 2 stocks to avoid timeouts during testing
   */
  async triggerStockNewsAggregation(symbols?: string[]): Promise<{
    message: string;
    processed: number;
    errors: number;
  }> {
    const startTime = Date.now();
    let processedCount = 0;
    let errorCount = 0;
    const stockSymbols = symbols || ['AAPL', 'TSLA'];

    try {
      for (const symbol of stockSymbols) {
        try {
          await this.newsService.fetchAndStoreStockNewsFromPython(symbol, 10);
          processedCount++;
          if (stockSymbols.indexOf(symbol) < stockSymbols.length - 1) {
            await this.sleep(5000);
          }
        } catch (error: any) {
          errorCount++;
        }
      }

      const duration = Math.round((Date.now() - startTime) / 1000);
      return {
        message: `Stock news aggregation completed in ${duration}s`,
        processed: processedCount,
        errors: errorCount,
      };
    } catch (error: any) {
      throw error;
    }
  }

  /**
   * Delete Old News - Runs once daily at 2:00 AM
   * Deletes all trending_news records older than 7 days
   * Helps maintain database size and performance
   */
  @Cron('0 2 * * *') // Every day at 2:00 AM
  async deleteOldNews(): Promise<void> {
    if (!this.cronsEnabled) return;
    try {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      await this.prisma.trending_news.deleteMany({
        where: {
          poll_timestamp: { lt: sevenDaysAgo },
        },
      });
    } catch (error: any) {
      // Don't throw - let the cron continue to next run
    }
  }
}

