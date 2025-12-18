import { Injectable, Logger } from '@nestjs/common';
import { PythonApiService } from '../../../kyc/integrations/python-api.service';
import { PrismaService } from '../../../prisma/prisma.service';

@Injectable()
export class StrategyPreviewService {
  private readonly logger = new Logger(StrategyPreviewService.name);
  private marketDataCache: Map<
    string,
    { data: any; timestamp: number }
  > = new Map();
  private readonly CACHE_TTL = 60 * 1000; // 1 minute

  constructor(
    private pythonApi: PythonApiService,
    private prisma: PrismaService,
  ) {}

  /**
   * Preview strategy on multiple assets (without storing signals)
   */
  async previewStrategy(
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
        // Get market data (with caching)
        const marketData = await this.getMarketData(asset.asset_id);

        // Prepare strategy data
        const strategyData = {
          entry_rules: strategy.entry_rules,
          exit_rules: strategy.exit_rules,
          indicators: strategy.indicators,
          timeframe: strategy.timeframe,
          engine_weights:
            strategy.engine_weights || {
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

        // Enrich signal with market data and strategy defaults when generator omits values
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
          // Additional fields for frontend preview: entry/exit, prices, profit, win rate, volume, insights
          entry: signal.entry ?? signal.entry_price ?? signal.suggested_entry ?? (marketData.price ?? null),
          entry_price: parsedEntry ?? null,
          stop_loss: stopLossPct ?? null,
          stop_loss_price: signal.stop_loss_price ?? signal.stopLossPrice ?? computedStopLossPrice ?? null,
          take_profit: takeProfitPct ?? null,
          take_profit_price: signal.take_profit_price ?? signal.takeProfitPrice ?? computedTakeProfitPrice ?? null,
          changePercent: signal.changePercent ?? signal.change_pct ?? signal.profit ?? null,
          winRate: signal.winRate ?? signal.win_rate ?? signal.win_pct ?? null,
          volume: signal.volume ?? signal.market_volume ?? marketData.volume_24h ?? null,
          insights: signal.insights ?? signal.reasons ?? [],
          // include strategy rules so frontend preview has entry/exit criteria
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

  /**
   * Get market data for asset (with caching)
   */
  private async getMarketData(assetId: string): Promise<any> {
    const cacheKey = `market-${assetId}`;
    const cached = this.marketDataCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.data;
    }

    // Get latest trending asset data
    const trendingAsset = await this.prisma.trending_assets.findFirst({
      where: {
        asset_id: assetId,
      },
      orderBy: {
        poll_timestamp: 'desc',
      },
    });

    const marketData = {
      price: trendingAsset ? Number(trendingAsset.price_usd || 0) : 0,
      volume_24h: trendingAsset
        ? Number(trendingAsset.market_volume || 0)
        : 0,
      asset_type: 'crypto', // Default, will be overridden if asset has type
    };

    // Get asset type
    const asset = await this.prisma.assets.findUnique({
      where: {
        asset_id: assetId,
      },
      select: {
        asset_type: true,
      },
    });

    if (asset?.asset_type) {
      marketData.asset_type = asset.asset_type;
    }

    // Cache the data
    this.marketDataCache.set(cacheKey, {
      data: marketData,
      timestamp: Date.now(),
    });

    // Clean up old cache entries
    this.cleanupCache();

    return marketData;
  }

  /**
   * Clean up old cache entries
   */
  private cleanupCache(): void {
    const now = Date.now();
    for (const [key, value] of this.marketDataCache.entries()) {
      if (now - value.timestamp >= this.CACHE_TTL * 2) {
        this.marketDataCache.delete(key);
      }
    }
  }
}

