import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { PythonApiService } from '../../kyc/integrations/python-api.service';
import { BinanceService } from '../binance/binance.service';

@Injectable()
export class NewsCronjobService {
  private readonly logger = new Logger(NewsCronjobService.name);
  private readonly BATCH_SIZE = 5; // Process 5 assets in parallel
  private readonly UPDATE_INTERVAL_MINUTES = 30; // Skip if updated within 30 minutes

  constructor(
    private prisma: PrismaService,
    private pythonApi: PythonApiService,
    private binanceService: BinanceService,
  ) {}

  /**
   * News Sentiment Aggregation Cronjob
   * Runs every 10 minutes to fetch and aggregate sentiment for assets
   * Optimized: Parallel processing (5 at a time) + Skip recently updated assets
   */
  @Cron('*/10 * * * *') // Every 10 minutes
  async aggregateNewsSentiment(): Promise<void> {
    this.logger.log('Starting news sentiment aggregation cronjob (optimized)');
    const startTime = Date.now();
    let processedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    try {
      // Calculate cutoff time (30 minutes ago)
      const cutoffTime = new Date(Date.now() - this.UPDATE_INTERVAL_MINUTES * 60 * 1000);

      // Get all active assets with their latest trending_assets record
      const assets = await this.prisma.assets.findMany({
        where: { is_active: true },
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
   * Same optimizations as cronjob: parallel + skip recently updated
   */
  async triggerManualAggregation(): Promise<{
    message: string;
    processed: number;
    skipped: number;
    errors: number;
  }> {
    this.logger.log('Manual sentiment aggregation triggered (optimized)');
    const startTime = Date.now();
    let processedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    try {
      // Calculate cutoff time
      const cutoffTime = new Date(Date.now() - this.UPDATE_INTERVAL_MINUTES * 60 * 1000);

      // Get assets with their latest trending_assets record
      const assets = await this.prisma.assets.findMany({
        where: { is_active: true },
        include: {
          trending_assets: {
            orderBy: { poll_timestamp: 'desc' },
            take: 1,
          },
        },
      });

      // Filter: Skip recently updated
      const assetsToProcess = assets.filter((asset) => {
        const latestPoll = asset.trending_assets?.[0]?.poll_timestamp;
        if (!latestPoll || latestPoll < cutoffTime) {
          return true;
        }
        skippedCount++;
        return false;
      });

      this.logger.log(
        `Manual: Processing ${assetsToProcess.length} assets (${skippedCount} skipped)`,
      );

      // Process in parallel batches
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
                `Error processing sentiment for asset ${asset.symbol}: ${error.message}`,
              );
            }
          }),
        );

        if (i + this.BATCH_SIZE < assetsToProcess.length) {
          await this.sleep(500);
        }
      }

      const duration = Date.now() - startTime;
      this.logger.log(
        `Manual aggregation completed: ${processedCount} processed, ${skippedCount} skipped, ${errorCount} errors, ${duration}ms`,
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
}

