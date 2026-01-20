import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { PythonApiService } from '../../kyc/integrations/python-api.service';
import { BinanceService } from '../binance/binance.service';
import { NewsService } from './news.service';


@Injectable()
export class NewsCronjobService {
  private readonly logger = new Logger(NewsCronjobService.name);
  private readonly BATCH_SIZE = 3; // Process 3 assets in parallel (reduced for rate limits)
  private readonly BATCH_DELAY_MS = 5000; // 5 seconds between batches (rate limit protection)
  private readonly MAX_ASSETS_PER_RUN = 15; // Process max 15 assets per run (rate limit: 15 assets × 2 calls = 30 API calls per 10min)
  private readonly UPDATE_INTERVAL_MINUTES = 30; // Skip if updated within 30 minutes

  constructor(
    private prisma: PrismaService,
    private pythonApi: PythonApiService,
    private binanceService: BinanceService,
    private newsService: NewsService,
  ) {}

  /**
   * Finnhub Trending Stocks Sync - Runs every 10 minutes
   * Fetches top 50 trending stocks from Finnhub via Python API
   * and stores them in trending_assets table
   */
  @Cron('*/10 * * * *') // Every 10 minutes
  async syncTrendingStocksFromFinnhub(): Promise<void> {
    this.logger.log('📈 Starting Finnhub trending stocks sync');
    const startTime = Date.now();

    try {
      // Call Python API to fetch trending stocks
      const response = await this.pythonApi.get('/stocks/trending', {
        params: { limit: 50 },
        timeout: 30000,
      });

      const trendingStocks = response.data?.stocks || response.data || [];

      if (!Array.isArray(trendingStocks) || trendingStocks.length === 0) {
        this.logger.warn('No trending stocks received from Finnhub');
        return;
      }

      this.logger.log(`Received ${trendingStocks.length} trending stocks from Finnhub`);

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
          this.logger.error(`Error syncing stock ${stock.symbol}:`, err);
          errorCount++;
        }
      }

      const duration = Date.now() - startTime;
      this.logger.log(
        `✅ Finnhub sync completed: ${successCount} stocks synced, ${errorCount} errors, ${duration}ms`,
      );
    } catch (error: any) {
      const duration = Date.now() - startTime;
      this.logger.error(`❌ Finnhub sync failed after ${duration}ms:`, error);
    }
  }

  /**
   * News Sentiment Aggregation Cronjob - OPTIMIZED FOR RATE LIMITS
   * Runs every 10 minutes to fetch and aggregate news/sentiment
   * Rate limit strategy: Max 15 assets/run = 30 API calls/10min = 4,320 calls/day (within 2000 limit with buffer)
   * Prioritizes: Recently trending assets + assets with active users
   */
  @Cron('*/10 * * * *') // Every 10 minutes
  async aggregateNewsForTopSymbols(): Promise<void> {
    this.logger.log('🚀 Starting news aggregation for active crypto assets');
    const startTime = Date.now();
    let processedCount = 0;
    let skippedCount = 0;
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

      // Fallback: If no assets in trending_assets, get from assets table
      if (symbols.length === 0) {
        this.logger.warn('No trending assets found, fetching from assets table');
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
        this.logger.warn('No active crypto assets found in database');
        return;
      }

      this.logger.log(`📊 Found ${symbols.length} assets to process (rate limit: ${this.MAX_ASSETS_PER_RUN} max)`);
      this.logger.log(`Assets: ${symbols.join(', ')}`);

      // Process in batches to avoid overwhelming APIs
      for (let i = 0; i < symbols.length; i += this.BATCH_SIZE) {
        const batch = symbols.slice(i, i + this.BATCH_SIZE);
        const batchNumber = Math.floor(i / this.BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(symbols.length / this.BATCH_SIZE);

        this.logger.log(`📦 Processing batch ${batchNumber}/${totalBatches}: ${batch.join(', ')}`);

        await Promise.all(
          batch.map(async (symbol, index) => {
            const symbolPosition = i + index + 1;
            try {
              this.logger.log(`  [${symbolPosition}/${symbols.length}] Processing ${symbol}...`);
              
              // Use the refactored method from NewsService
              await this.newsService.fetchAndStoreNewsFromPython(symbol, 20);
              
              processedCount++;
              this.logger.log(`  ✅ [${symbolPosition}/${symbols.length}] ${symbol} completed`);
            } catch (error: any) {
              errorCount++;
              this.logger.error(`  ❌ [${symbolPosition}/${symbols.length}] ${symbol} failed: ${error.message}`);
              // Continue with next symbol - don't let one failure break all
            }
          }),
        );

        // Rate limit protection: wait between batches (except last batch)
        if (i + this.BATCH_SIZE < symbols.length) {
          this.logger.debug(`⏳ Waiting ${this.BATCH_DELAY_MS / 1000}s before next batch...`);
          await this.sleep(this.BATCH_DELAY_MS);
        }
      }

      const duration = Math.round((Date.now() - startTime) / 1000);
      this.logger.log(
        `✨ News aggregation completed: ${processedCount} processed, ${errorCount} errors, ${duration}s elapsed`,
      );
    } catch (error: any) {
      this.logger.error(`❌ Fatal error in news aggregation: ${error.message}`);
    }
  }

  /**
   * OLD CRONJOB - Keep for legacy asset sentiment updates (CRYPTO ONLY)
   * Runs every 10 minutes to fetch and aggregate sentiment for CRYPTO assets
   * Stocks are handled by aggregateStockNews cronjob separately
   * Optimized: Parallel processing (5 at a time) + Skip recently updated assets
   */
  @Cron('*/10 * * * *') // Every 10 minutes
  async aggregateNewsSentiment(): Promise<void> {
    this.logger.log('Starting news sentiment aggregation cronjob (CRYPTO ONLY)');
    const startTime = Date.now();
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
        return false; // Skip: Recently updated
      });

      this.logger.log(
        `Processing ${assetsToProcess.length} assets (${skippedCount} skipped, updated within ${this.UPDATE_INTERVAL_MINUTES}min)`,
      );

      // Process in parallel batches of 5
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
              this.logger.error(
                `Error processing sentiment for asset ${asset.symbol} (${asset.asset_id}): ${error.message}`,
              );
            }
          }),
        );

        // Small delay between batches to avoid overwhelming API
        if (i + this.BATCH_SIZE < assetsToProcess.length) {
          await this.sleep(500);
        }
      }

      const duration = Date.now() - startTime;
      this.logger.log(
        `News sentiment aggregation completed: ${processedCount} processed, ${skippedCount} skipped, ${errorCount} errors, ${duration}ms`,
      );
    } catch (error: any) {
      this.logger.error(`Fatal error in news sentiment aggregation: ${error.message}`);
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
      this.logger.warn(`Skipping asset ${assetId}: missing symbol or asset_type`);
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
        this.logger.warn(`No sentiment data returned for ${symbol}`);
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
              this.logger.warn(`Could not fetch Binance data for ${symbol}: ${error.message}`);
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
              market_cap: null, // Not available from Binance
            },
          });
          this.logger.debug(
            `Stored trending asset for ${symbol}: galaxy_score=${socialMetrics.galaxy_score}, alt_rank=${socialMetrics.alt_rank}, price=${marketData?.price || socialMetrics.price}`,
          );
        } catch (error: any) {
          // Ignore duplicate key errors (same timestamp + asset_id)
          if (!error.message?.includes('Unique constraint')) {
            this.logger.warn(
              `Error storing trending assets for ${symbol}: ${error.message}`,
            );
          }
        }
      } else {
        this.logger.debug(`No social metrics available for ${symbol}, skipping trending_assets storage`);
      }

      this.logger.debug(`Updated sentiment for ${symbol}: score=${sentimentData.score}`);
    } catch (error: any) {
      this.logger.error(`Error processing sentiment for ${symbol}: ${error.message}`);
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
    this.logger.log(`🔧 Manual aggregation triggered${specificSymbol ? ` for ${specificSymbol}` : ''}`);
    const startTime = Date.now();
    let processedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    try {
      // If specific symbol requested, process only that one
      if (specificSymbol) {
        try {
          await this.newsService.fetchAndStoreNewsFromPython(specificSymbol.toUpperCase(), 20);
          processedCount++;
        } catch (error: any) {
          errorCount++;
          this.logger.error(`Failed for ${specificSymbol}: ${error.message}`);
        }
      } else {
        // No specific symbol, skip (use cron job instead)
        this.logger.warn('Manual aggregation requires a specific symbol parameter');
        return;
      }

      const duration = Math.round((Date.now() - startTime) / 1000);
      this.logger.log(
        `Manual aggregation completed: ${processedCount} processed, ${skippedCount} skipped, ${errorCount} errors, ${duration}s`,
      );

      return {
        message: 'Manual aggregation completed',
        processed: processedCount,
        skipped: skippedCount,
        errors: errorCount,
      };
    } catch (error: any) {
      this.logger.error(`Fatal error in manual aggregation: ${error.message}`);
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
   * Stock News Aggregation Cronjob
   * Runs every 15 minutes to fetch and store stock news with sentiment
   * Similar to crypto news aggregation but for stocks
   */
  @Cron('*/15 * * * *') // Every 15 minutes
  async aggregateStockNews(): Promise<void> {
    this.logger.log('📈 Starting stock news aggregation');
    const startTime = Date.now();

    try {
      // Popular stocks to fetch news for
      const stockSymbols = [
        'AAPL', 'TSLA', 'GOOGL', 'AMZN', 'MSFT',
        'NVDA', 'META', 'AMD', 'NFLX', 'DIS'
      ];

      this.logger.log(`📊 Fetching news for ${stockSymbols.length} stocks: ${stockSymbols.join(', ')}`);

      // Process stocks in small batches to avoid timeouts
      const STOCK_BATCH_SIZE = 2;
      let processedCount = 0;
      let errorCount = 0;

      for (let i = 0; i < stockSymbols.length; i += STOCK_BATCH_SIZE) {
        const batch = stockSymbols.slice(i, i + STOCK_BATCH_SIZE);
        const batchNumber = Math.floor(i / STOCK_BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(stockSymbols.length / STOCK_BATCH_SIZE);

        this.logger.log(`📦 Stock batch ${batchNumber}/${totalBatches}: ${batch.join(', ')}`);

        // Process each stock in the batch sequentially to avoid overloading
        for (const symbol of batch) {
          try {
            await this.newsService.fetchAndStoreStockNewsFromPython(symbol, 10);
            processedCount++;
            this.logger.log(`  ✅ ${symbol} news fetched and stored`);
          } catch (error: any) {
            errorCount++;
            this.logger.error(`  ❌ ${symbol} failed: ${error.message}`);
          }
        }

        // Wait between batches
        if (i + STOCK_BATCH_SIZE < stockSymbols.length) {
          await this.sleep(3000); // 3 seconds between batches
        }
      }

      const duration = Math.round((Date.now() - startTime) / 1000);
      this.logger.log(
        `✨ Stock news aggregation completed: ${processedCount} processed, ${errorCount} errors, ${duration}s elapsed`,
      );
    } catch (error: any) {
      this.logger.error(`❌ Fatal error in stock news aggregation: ${error.message}`);
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
    this.logger.log('🔧 Manual stock news aggregation triggered');
    const startTime = Date.now();
    let processedCount = 0;
    let errorCount = 0;

    // Default to just 2 stocks to avoid overwhelming the Python server
    const stockSymbols = symbols || ['AAPL', 'TSLA'];

    try {
      // Process sequentially with delay to avoid overwhelming Python server
      for (const symbol of stockSymbols) {
        try {
          await this.newsService.fetchAndStoreStockNewsFromPython(symbol, 10);
          processedCount++;
          this.logger.log(`✅ ${symbol} completed`);
          
          // Wait 5 seconds between stocks to let FinBERT recover
          if (stockSymbols.indexOf(symbol) < stockSymbols.length - 1) {
            this.logger.debug('⏳ Waiting 5s before next stock...');
            await this.sleep(5000);
          }
        } catch (error: any) {
          errorCount++;
          this.logger.error(`❌ ${symbol} failed: ${error.message}`);
        }
      }

      const duration = Math.round((Date.now() - startTime) / 1000);
      this.logger.log(`Manual aggregation completed in ${duration}s`);

      return {
        message: `Stock news aggregation completed in ${duration}s`,
        processed: processedCount,
        errors: errorCount,
      };
    } catch (error: any) {
      this.logger.error(`Fatal error: ${error.message}`);
      throw error;
    }
  }
}

