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
    // Ensure index exists to speed up the DISTINCT ON query
    try {
      await this.prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS idx_trending_asset_poll ON trending_assets (asset_id, poll_timestamp DESC)`,
      );
    } catch (err: any) {
      this.logger.debug(`Failed to create index idx_trending_asset_poll: ${err?.message || err}`);
    }

    // Use a Postgres DISTINCT ON query to get the latest row per asset_id,
    // then order those latest rows by poll_timestamp DESC and limit.
    try {
      const rows: any[] = await this.prisma.$queryRawUnsafe(`
        SELECT * FROM (
          SELECT DISTINCT ON (asset_id) asset_id, galaxy_score, alt_rank, social_score, price_usd, poll_timestamp
          FROM trending_assets
          ORDER BY asset_id, poll_timestamp DESC
        ) s
        ORDER BY s.poll_timestamp DESC
        LIMIT ${limit}
      `);

      if (!rows || rows.length === 0) return [];

      const assetIds = rows.map((r) => r.asset_id);
      const assets = await this.prisma.assets.findMany({ where: { asset_id: { in: assetIds } } });
      const assetsMap = new Map<string, any>();
      for (const a of assets) assetsMap.set(a.asset_id, a);

      return rows.map((ta) => {
        const asset = assetsMap.get(ta.asset_id) || ta.asset;
        return {
          asset_id: ta.asset_id,
          symbol: asset?.symbol || 'UNKNOWN',
          asset_type: asset?.asset_type || 'crypto',
          galaxy_score: ta.galaxy_score,
          alt_rank: ta.alt_rank,
          social_score: ta.social_score,
          price_usd: ta.price_usd,
          poll_timestamp: ta.poll_timestamp,
        };
      });
    } catch (err: any) {
      this.logger.warn(`Error running DISTINCT ON trending query: ${err?.message || err}`);
      return [];
    }
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

        // Enrich preview with market data fallbacks similar to strategy-preview
        const entryPrice = signal.entryPrice ?? signal.entry_price ?? signal.entry ?? marketData.price ?? null;
        const stopLossPct = signal.stop_loss ?? signal.stopLoss ?? strategy.stop_loss_value ?? null;
        const takeProfitPct = signal.take_profit ?? signal.takeProfit ?? strategy.take_profit_value ?? null;

        const parsedEntry = entryPrice !== null ? Number(entryPrice) : null;
        const parsedStopLoss = stopLossPct != null ? Number(stopLossPct) : null;
        const parsedTakeProfit = takeProfitPct != null ? Number(takeProfitPct) : null;

        const computedStopLossPrice = parsedEntry != null && parsedStopLoss != null && !isNaN(parsedEntry) && !isNaN(parsedStopLoss)
          ? parsedEntry * (1 - parsedStopLoss / 100)
          : null;
        const computedTakeProfitPrice = parsedEntry != null && parsedTakeProfit != null && !isNaN(parsedEntry) && !isNaN(parsedTakeProfit)
          ? parsedEntry * (1 + parsedTakeProfit / 100)
          : null;

        results.push({
          asset_id: asset.asset_id,
          symbol: asset.symbol,
          asset_type: asset.asset_type,
          action: signal.action,
          final_score: signal.final_score,
          confidence: signal.confidence,
          engine_scores: signal.engine_scores,
          // Additional fields for frontend preview
          entry: signal.entry ?? signal.entry_price ?? signal.suggested_entry ?? (marketData.price ?? null),
          entry_price: parsedEntry ?? null,
          stop_loss: stopLossPct ?? null,
          stop_loss_price: signal.stop_loss_price ?? signal.stopLossPrice ?? computedStopLossPrice ?? null,
          take_profit: takeProfitPct ?? null,
          take_profit_price: signal.take_profit_price ?? signal.takeProfitPrice ?? computedTakeProfitPrice ?? null,
          changePercent: signal.changePercent ?? signal.change_pct ?? signal.profit ?? null,
          winRate: signal.winRate ?? signal.win_rate ?? signal.win_pct ?? null,
          volume: signal.volume ?? signal.market_volume ?? marketData.price ?? null,
          insights: signal.insights ?? signal.reasons ?? [],
          // include strategy-level rules so preview response matches strategy object
          entry_rules: strategy.entry_rules ?? null,
          exit_rules: strategy.exit_rules ?? null,
          breakdown: signal.breakdown ?? null,
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

