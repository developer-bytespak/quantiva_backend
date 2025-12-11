import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { PythonApiService } from '../../kyc/integrations/python-api.service';

@Injectable()
export class SentimentEmaService {
  private readonly logger = new Logger(SentimentEmaService.name);

  constructor(
    private prisma: PrismaService,
    private pythonApi: PythonApiService,
  ) {}

  /**
   * Sentiment EMA State Update Cronjob
   * Runs every hour to update EMA states for all assets with sentiment data
   */
  @Cron(CronExpression.EVERY_HOUR)
  async updateEmaStates(): Promise<void> {
    this.logger.log('Starting sentiment EMA state update cronjob');
    const startTime = Date.now();
    let processedCount = 0;
    let errorCount = 0;

    try {
      // Get all assets that have sentiment data (from trending_news)
      const assetsWithSentiment = await this.prisma.trending_news.findMany({
        select: {
          asset_id: true,
        },
        distinct: ['asset_id'],
        take: 1000, // Limit to prevent timeout
      });

      const assetIds = [...new Set(assetsWithSentiment.map((n) => n.asset_id))];

      this.logger.log(`Processing ${assetIds.length} assets with sentiment data`);

      // Get asset details
      const assets = await this.prisma.assets.findMany({
        where: {
          asset_id: { in: assetIds },
          is_active: true,
        },
      });

      for (const asset of assets) {
        try {
          await this.processAssetEmaState(asset.asset_id, asset.symbol, asset.asset_type);
          processedCount++;
        } catch (error: any) {
          errorCount++;
          this.logger.error(
            `Error updating EMA state for asset ${asset.symbol} (${asset.asset_id}): ${error.message}`,
          );
          // Continue processing other assets
        }
      }

      const duration = Date.now() - startTime;
      this.logger.log(
        `Sentiment EMA state update completed: ${processedCount} processed, ${errorCount} errors, ${duration}ms`,
      );
    } catch (error: any) {
      this.logger.error(`Fatal error in sentiment EMA state update: ${error.message}`);
    }
  }

  /**
   * Process EMA state for a single asset
   */
  private async processAssetEmaState(
    assetId: string,
    symbol: string | null,
    assetType: string | null,
  ): Promise<void> {
    if (!symbol || !assetType) {
      this.logger.warn(`Skipping asset ${assetId}: missing symbol or asset_type`);
      return;
    }

    try {
      // Call Python API to get current sentiment with EMA state
      const response = await this.pythonApi.post('/api/v1/sentiment/analyze', {
        asset_id: symbol,
        asset_type: assetType,
      });

      const sentimentData = response.data;

      if (!sentimentData || !sentimentData.metadata) {
        this.logger.warn(`No sentiment metadata returned for ${symbol}`);
        return;
      }

      const metadata = sentimentData.metadata || {};
      const emaData = metadata.ema || {};

      // Extract EMA values
      const emaValue = emaData.ema_score ?? sentimentData.score ?? 0;
      const momentum = emaData.momentum ?? 0;
      const rawScore = emaData.raw_score ?? sentimentData.score ?? 0;

      // Use symbol as asset_id for sentiment_ema_state (it uses VarChar, not UUID)
      const assetIdentifier = symbol;

      // Upsert into sentiment_ema_state table
      await this.prisma.sentiment_ema_state.upsert({
        where: {
          asset_id: assetIdentifier,
        },
        update: {
          ema_value: emaValue,
          momentum: momentum,
          raw_score: rawScore,
          last_timestamp: new Date(),
          metadata: {
            ema: emaData,
            sentiment: metadata.overall_sentiment,
            confidence: sentimentData.confidence,
            total_texts: metadata.total_texts,
          },
        },
        create: {
          asset_id: assetIdentifier,
          ema_value: emaValue,
          momentum: momentum,
          raw_score: rawScore,
          last_timestamp: new Date(),
          metadata: {
            ema: emaData,
            sentiment: metadata.overall_sentiment,
            confidence: sentimentData.confidence,
            total_texts: metadata.total_texts,
          },
        },
      });

      this.logger.debug(
        `Updated EMA state for ${symbol}: ema=${emaValue}, momentum=${momentum}`,
      );
    } catch (error: any) {
      this.logger.error(`Error updating EMA state for ${symbol}: ${error.message}`);
      throw error;
    }
  }
}

