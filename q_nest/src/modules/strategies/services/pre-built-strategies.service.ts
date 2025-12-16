import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { StrategyType, RiskLevel } from '@prisma/client';
import { PRE_BUILT_STRATEGIES } from '../data/pre-built-strategies';
import { PythonApiService } from '../../../kyc/integrations/python-api.service';

@Injectable()
export class PreBuiltStrategiesService implements OnModuleInit {
  private readonly logger = new Logger(PreBuiltStrategiesService.name);

  constructor(
    private prisma: PrismaService,
    private pythonApi: PythonApiService,
  ) {}

  async onModuleInit() {
    // Seed pre-built strategies on module initialization
    await this.seedPreBuiltStrategies();
  }

  /**
   * Seed pre-built strategies into database
   */
  async seedPreBuiltStrategies(): Promise<void> {
    this.logger.log('Seeding pre-built strategies...');

    for (const template of PRE_BUILT_STRATEGIES) {
      // Check if strategy already exists
      const existing = await this.prisma.strategies.findFirst({
        where: {
          name: template.name,
          type: 'admin',
        },
      });

      if (existing) {
        this.logger.debug(`Strategy ${template.name} already exists, skipping`);
        continue;
      }

      // Create strategy
      await this.prisma.strategies.create({
        data: {
          name: template.name,
          type: 'admin',
          description: template.description,
          risk_level: template.risk_level as RiskLevel,
          engine_weights: template.engine_weights as any,
          entry_rules: template.entry_rules as any,
          exit_rules: template.exit_rules as any,
          stop_loss_value: template.stop_loss_value,
          take_profit_value: template.take_profit_value,
          is_active: true,
        },
      });

      this.logger.log(`Created pre-built strategy: ${template.name}`);
    }

    this.logger.log('Pre-built strategies seeding completed');
  }

  /**
   * Get all pre-built strategies (admin type)
   */
  async getPreBuiltStrategies() {
    return this.prisma.strategies.findMany({
      where: {
        type: 'admin',
        is_active: true,
      },
      orderBy: {
        created_at: 'asc',
      },
    });
  }

  /**
   * Get top N trending assets
   */
  async getTopTrendingAssets(limit: number = 20) {
    // Get all trending assets (all rows, not grouped)
    const allTrendingAssets = await this.prisma.trending_assets.findMany({
      include: {
        asset: true, // Include asset relation if it exists
      },
      orderBy: [
        {
          poll_timestamp: 'desc', // Get latest entries first
        },
      ],
      take: limit, // Apply limit directly
    });

    this.logger.log(`Found ${allTrendingAssets.length} trending asset records (limit: ${limit})`);

    if (allTrendingAssets.length === 0) {
      return [];
    }

    // Get all unique asset IDs to fetch asset info in bulk
    const assetIds = [...new Set(allTrendingAssets.map((ta) => ta.asset_id))];
    const assetsMap = new Map();
    
    // Fetch all assets in one query
    const assets = await this.prisma.assets.findMany({
      where: {
        asset_id: { in: assetIds },
      },
    });
    
    this.logger.log(`Found ${assets.length} matching assets in assets table`);
    
    // Create a map for quick lookup
    for (const asset of assets) {
      assetsMap.set(asset.asset_id, asset);
    }

    // Return all trending assets with asset info
    return allTrendingAssets.map((ta) => {
      const asset = assetsMap.get(ta.asset_id) || ta.asset; // Use fetched asset or included asset
      return {
        asset_id: ta.asset_id,
        symbol: asset?.symbol || 'UNKNOWN',
        asset_type: asset?.asset_type || 'crypto',
        galaxy_score: ta.galaxy_score,
        alt_rank: ta.alt_rank,
        social_score: ta.social_score,
        price_usd: ta.price_usd,
        poll_timestamp: ta.poll_timestamp, // Include timestamp so you can see when each was polled
      };
    });
  }

  /**
   * Preview strategy on multiple assets (without storing signals)
   */
  async previewStrategyOnAssets(
    strategyId: string,
    assetIds: string[],
  ): Promise<any[]> {
    // Get strategy
    const strategy = await this.prisma.strategies.findUnique({
      where: {
        strategy_id: strategyId,
      },
    });

    if (!strategy) {
      throw new Error(`Strategy ${strategyId} not found`);
    }

    // Get assets
    const assets = await this.prisma.assets.findMany({
      where: {
        asset_id: {
          in: assetIds,
        },
      },
    });

    const results: any[] = [];

    // Preview strategy on each asset
    for (const asset of assets) {
      try {
        // Get market data
        const marketData = {
          price: 0,
          volume_24h: 0,
          asset_type: asset.asset_type || 'crypto',
        };

        // Get latest trending asset data if available
        const trendingAsset = await this.prisma.trending_assets.findFirst({
          where: {
            asset_id: asset.asset_id,
          },
          orderBy: {
            poll_timestamp: 'desc',
          },
        });

        if (trendingAsset) {
          marketData.price = Number(trendingAsset.price_usd || 0);
        }

        // Prepare strategy data
        const strategyData = {
          entry_rules: strategy.entry_rules,
          exit_rules: strategy.exit_rules,
          indicators: strategy.indicators,
          timeframe: strategy.timeframe,
          engine_weights: strategy.engine_weights || {
            sentiment: 0.35,
            trend: 0.25,
            fundamental: 0.15,
            event_risk: 0.15,
            liquidity: 0.1,
          },
          stop_loss_value: strategy.stop_loss_value,
          take_profit_value: strategy.take_profit_value,
        };

        // Call Python API to generate signal (preview only, not stored)
        const signal = await this.pythonApi.generateSignal(
          strategyId,
          asset.asset_id,
          {
            strategy_data: strategyData,
            market_data: marketData,
          },
        );

        results.push({
          asset_id: asset.asset_id,
          symbol: asset.symbol,
          asset_type: asset.asset_type,
          action: signal.action,
          final_score: signal.final_score,
          confidence: signal.confidence,
          engine_scores: signal.engine_scores,
        });
      } catch (error: any) {
        this.logger.warn(
          `Error previewing strategy on asset ${asset.symbol}: ${error.message}`,
        );
        // Continue with next asset
        results.push({
          asset_id: asset.asset_id,
          symbol: asset.symbol,
          asset_type: asset.asset_type,
          error: error.message,
        });
      }
    }

    return results;
  }
}

