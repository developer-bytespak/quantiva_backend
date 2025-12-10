import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { PythonApiService } from '../../kyc/integrations/python-api.service';

@Injectable()
export class EngineScoresService {
  private readonly logger = new Logger(EngineScoresService.name);

  constructor(
    private prisma: PrismaService,
    private pythonApi: PythonApiService,
  ) {}

  /**
   * Engine Scores Snapshot Cronjob
   * Runs every 6 hours to snapshot all engine scores for all active assets
   */
  @Cron('0 */6 * * *') // Every 6 hours
  async snapshotEngineScores(): Promise<void> {
    this.logger.log('Starting engine scores snapshot cronjob');
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
          await this.processAssetEngineScores(asset.asset_id, asset.symbol, asset.asset_type);
          processedCount++;
        } catch (error: any) {
          errorCount++;
          this.logger.error(
            `Error snapshotting engine scores for asset ${asset.symbol} (${asset.asset_id}): ${error.message}`,
          );
          // Continue processing other assets
        }
      }

      const duration = Date.now() - startTime;
      this.logger.log(
        `Engine scores snapshot completed: ${processedCount} processed, ${errorCount} errors, ${duration}ms`,
      );
    } catch (error: any) {
      this.logger.error(`Fatal error in engine scores snapshot: ${error.message}`);
    }
  }

  /**
   * Process engine scores for a single asset
   */
  private async processAssetEngineScores(
    assetId: string,
    symbol: string | null,
    assetType: string | null,
  ): Promise<void> {
    if (!symbol || !assetType) {
      this.logger.warn(`Skipping asset ${assetId}: missing symbol or asset_type`);
      return;
    }

    try {
      // Call Python API to generate signal (which runs all engines)
      // Use minimal strategy data for snapshot
      const response = await this.pythonApi.post('/api/v1/signals/generate', {
        strategy_id: null, // System snapshot, not tied to a strategy
        asset_id: symbol,
        asset_type: assetType,
        strategy_data: {
          entry_rules: [],
          exit_rules: [],
          indicators: [],
        },
        market_data: {
          asset_type: assetType,
        },
      });

      const signalData = response.data;

      if (!signalData || !signalData.engine_scores) {
        this.logger.warn(`No engine scores returned for ${symbol}`);
        return;
      }

      const engineScores = signalData.engine_scores || {};
      const metadata = signalData.metadata || {};

      // Extract all engine scores
      const sentimentScore = engineScores.sentiment?.score ?? null;
      const trendScore = engineScores.trend?.score ?? null;
      const fundamentalScore = engineScores.fundamental?.score ?? null;
      const liquidityScore = engineScores.liquidity?.score ?? null;
      const eventRiskScore = engineScores.event_risk?.score ?? null;

      // Store in strategy_signals table as a snapshot (strategy_id = null, action = HOLD)
      await this.prisma.strategy_signals.create({
        data: {
          strategy_id: null, // System snapshot
          user_id: null, // System snapshot
          asset_id: assetId,
          timestamp: new Date(),
          final_score: signalData.final_score ?? null,
          action: 'HOLD', // Snapshot, not a trading signal
          confidence: signalData.confidence ?? null,
          sentiment_score: sentimentScore,
          trend_score: trendScore,
          fundamental_score: fundamentalScore,
          liquidity_score: liquidityScore,
          event_risk_score: eventRiskScore,
          engine_metadata: {
            sentiment: engineScores.sentiment?.metadata || {},
            trend: engineScores.trend?.metadata || {},
            fundamental: engineScores.fundamental?.metadata || {},
            liquidity: engineScores.liquidity?.metadata || {},
            event_risk: engineScores.event_risk?.metadata || {},
            fusion: metadata,
          },
        },
      });

      this.logger.debug(`Snapshotted engine scores for ${symbol}`);
    } catch (error: any) {
      this.logger.error(`Error snapshotting engine scores for ${symbol}: ${error.message}`);
      throw error;
    }
  }
}

