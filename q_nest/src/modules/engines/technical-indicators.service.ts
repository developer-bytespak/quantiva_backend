import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { PythonApiService } from '../../kyc/integrations/python-api.service';

@Injectable()
export class TechnicalIndicatorsService {
  private readonly logger = new Logger(TechnicalIndicatorsService.name);

  constructor(
    private prisma: PrismaService,
    private pythonApi: PythonApiService,
  ) {}

  /**
   * Technical Indicators Snapshot Cronjob
   * Runs daily at 11:00 AM to snapshot technical indicators for all active assets
   */
  @Cron('0 11 * * *') // Daily at 11:00 AM
  async snapshotTechnicalIndicators(): Promise<void> {
    this.logger.log('Starting technical indicators snapshot cronjob');
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
          await this.processAssetTechnicalIndicators(asset.asset_id, asset.symbol, asset.asset_type);
          processedCount++;
        } catch (error: any) {
          errorCount++;
          this.logger.error(
            `Error snapshotting technical indicators for asset ${asset.symbol} (${asset.asset_id}): ${error.message}`,
          );
          // Continue processing other assets
        }
      }

      const duration = Date.now() - startTime;
      this.logger.log(
        `Technical indicators snapshot completed: ${processedCount} processed, ${errorCount} errors, ${duration}ms`,
      );
    } catch (error: any) {
      this.logger.error(`Fatal error in technical indicators snapshot: ${error.message}`);
    }
  }

  /**
   * Process technical indicators for a single asset
   */
  private async processAssetTechnicalIndicators(
    assetId: string,
    symbol: string | null,
    assetType: string | null,
  ): Promise<void> {
    if (!symbol || !assetType) {
      this.logger.warn(`Skipping asset ${assetId}: missing symbol or asset_type`);
      return;
    }

    try {
      // Call Python API to get technical analysis
      // We'll use the signals endpoint which includes technical engine
      const response = await this.pythonApi.post('/api/v1/signals/generate', {
        strategy_id: null,
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
      const technicalData = signalData.engine_scores?.trend;

      if (!technicalData || !technicalData.metadata) {
        this.logger.warn(`No technical data returned for ${symbol}`);
        return;
      }

      const metadata = technicalData.metadata || {};
      const indicators = metadata.indicators || {};
      const metricDate = new Date();

      // Store each technical indicator
      const indicatorMetrics = [
        { type: 'ma20', value: indicators.ma20 },
        { type: 'ma50', value: indicators.ma50 },
        { type: 'ma200', value: indicators.ma200 },
        { type: 'rsi_14', value: indicators.rsi_14 },
        { type: 'rsi_30', value: indicators.rsi_30 },
        { type: 'macd', value: indicators.macd },
        { type: 'macd_signal', value: indicators.macd_signal },
        { type: 'macd_hist', value: indicators.macd_hist },
        { type: 'atr', value: indicators.atr },
        { type: 'current_price', value: indicators.current_price },
        { type: 'roc', value: indicators.roc },
      ];

      for (const metric of indicatorMetrics) {
        if (metric.value !== null && metric.value !== undefined) {
          await this.prisma.asset_metrics.create({
            data: {
              asset_id: assetId,
              metric_date: metricDate,
              metric_type: metric.type,
              metric_value: metric.value,
              source: 'technical_engine',
              metadata: {
                indicators: indicators,
                timeframes: metadata.timeframes || {},
                data_points: metadata.data_points,
                data_freshness_hours: metadata.data_freshness_hours,
                multi_timeframe: metadata.multi_timeframe || false,
              },
            },
          });
        }
      }

      this.logger.debug(`Snapshotted technical indicators for ${symbol}`);
    } catch (error: any) {
      this.logger.error(`Error snapshotting technical indicators for ${symbol}: ${error.message}`);
      throw error;
    }
  }
}

