import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { PythonApiService } from '../../kyc/integrations/python-api.service';

@Injectable()
export class NewsCronjobService {
  private readonly logger = new Logger(NewsCronjobService.name);

  constructor(
    private prisma: PrismaService,
    private pythonApi: PythonApiService,
  ) {}

  /**
   * News Sentiment Aggregation Cronjob
   * Runs every 10 minutes to fetch and aggregate sentiment for all active assets
   */
  @Cron('*/10 * * * *') // Every 10 minutes
  async aggregateNewsSentiment(): Promise<void> {
    this.logger.log('Starting news sentiment aggregation cronjob');
    const startTime = Date.now();
    let processedCount = 0;
    let errorCount = 0;

    try {
      // Get all active assets
      const assets = await this.prisma.assets.findMany({
        where: { is_active: true },
      });

      this.logger.log(`Processing ${assets.length} active assets`);

      for (const asset of assets) {
        try {
          await this.processAssetSentiment(asset.asset_id, asset.symbol, asset.asset_type);
          processedCount++;
        } catch (error: any) {
          errorCount++;
          this.logger.error(
            `Error processing sentiment for asset ${asset.symbol} (${asset.asset_id}): ${error.message}`,
          );
          // Continue processing other assets
        }
      }

      const duration = Date.now() - startTime;
      this.logger.log(
        `News sentiment aggregation completed: ${processedCount} processed, ${errorCount} errors, ${duration}ms`,
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

