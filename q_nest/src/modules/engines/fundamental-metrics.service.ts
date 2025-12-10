import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { PythonApiService } from '../../kyc/integrations/python-api.service';

@Injectable()
export class FundamentalMetricsService {
  private readonly logger = new Logger(FundamentalMetricsService.name);

  constructor(
    private prisma: PrismaService,
    private pythonApi: PythonApiService,
  ) {}

  /**
   * Fundamental Metrics Update Cronjob
   * Runs daily at 10:00 AM to update fundamental metrics for all crypto assets
   */
  @Cron('0 10 * * *') // Daily at 10:00 AM
  async updateFundamentalMetrics(): Promise<void> {
    this.logger.log('Starting fundamental metrics update cronjob');
    const startTime = Date.now();
    let processedCount = 0;
    let errorCount = 0;

    try {
      // Get all crypto assets
      const assets = await this.prisma.assets.findMany({
        where: {
          is_active: true,
          asset_type: 'crypto',
        },
      });

      this.logger.log(`Processing ${assets.length} crypto assets`);

      for (const asset of assets) {
        try {
          await this.processAssetFundamentalMetrics(asset.asset_id, asset.symbol);
          processedCount++;
        } catch (error: any) {
          errorCount++;
          this.logger.error(
            `Error updating fundamental metrics for asset ${asset.symbol} (${asset.asset_id}): ${error.message}`,
          );
          // Continue processing other assets
        }
      }

      const duration = Date.now() - startTime;
      this.logger.log(
        `Fundamental metrics update completed: ${processedCount} processed, ${errorCount} errors, ${duration}ms`,
      );
    } catch (error: any) {
      this.logger.error(`Fatal error in fundamental metrics update: ${error.message}`);
    }
  }

  /**
   * Process fundamental metrics for a single asset
   */
  private async processAssetFundamentalMetrics(assetId: string, symbol: string | null): Promise<void> {
    if (!symbol) {
      this.logger.warn(`Skipping asset ${assetId}: missing symbol`);
      return;
    }

    try {
      // Call Python API to get fundamental analysis
      // We'll use the signals endpoint which includes fundamental engine
      const response = await this.pythonApi.post('/api/v1/signals/generate', {
        strategy_id: null,
        asset_id: symbol,
        asset_type: 'crypto',
        strategy_data: {
          entry_rules: [],
          exit_rules: [],
          indicators: [],
        },
        market_data: {
          asset_type: 'crypto',
        },
      });

      const signalData = response.data;
      const fundamentalData = signalData.engine_scores?.fundamental;

      if (!fundamentalData || !fundamentalData.metadata) {
        this.logger.warn(`No fundamental data returned for ${symbol}`);
        return;
      }

      const metadata = fundamentalData.metadata || {};
      const metricDate = new Date();

      // Store each fundamental metric
      const metrics = [
        {
          type: 'galaxy_score',
          value: metadata.galaxy_score,
          source: 'lunarcrush',
        },
        {
          type: 'dev_activity',
          value: metadata.developer_activity,
          source: 'coingecko',
        },
        {
          type: 'tokenomics_score',
          value: metadata.tokenomics_score,
          source: 'coingecko',
        },
        {
          type: 'alt_rank',
          value: metadata.alt_rank,
          source: 'lunarcrush',
        },
        {
          type: 'github_forks',
          value: metadata.github_forks,
          source: 'coingecko',
        },
        {
          type: 'github_stars',
          value: metadata.github_stars,
          source: 'coingecko',
        },
        {
          type: 'dilution_risk',
          value: metadata.dilution_risk,
          source: 'coingecko',
        },
        {
          type: 'fdv_mc_ratio',
          value: metadata.fdv_mc_ratio,
          source: 'coingecko',
        },
      ];

      for (const metric of metrics) {
        if (metric.value !== null && metric.value !== undefined) {
          await this.prisma.asset_metrics.create({
            data: {
              asset_id: assetId,
              metric_date: metricDate,
              metric_type: metric.type,
              metric_value: metric.value,
              source: metric.source,
              metadata: {
                score_breakdown: metadata.score_breakdown,
                code_changes_4w: metadata.code_changes_4w,
                circulating_supply: metadata.circulating_supply,
                max_supply: metadata.max_supply,
              },
            },
          });
        }
      }

      this.logger.debug(`Updated fundamental metrics for ${symbol}`);
    } catch (error: any) {
      this.logger.error(`Error updating fundamental metrics for ${symbol}: ${error.message}`);
      throw error;
    }
  }
}

