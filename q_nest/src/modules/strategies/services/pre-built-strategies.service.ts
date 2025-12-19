import { Injectable, Logger, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { StrategyType, RiskLevel } from '@prisma/client';
import { PRE_BUILT_STRATEGIES } from '../data/pre-built-strategies';
import { PythonApiService } from '../../../kyc/integrations/python-api.service';
import { ExchangesService } from '../../exchanges/exchanges.service';
import { BinanceService } from '../../binance/binance.service';

@Injectable()
export class PreBuiltStrategiesService implements OnModuleInit {
  private readonly logger = new Logger(PreBuiltStrategiesService.name);

  constructor(
    private prisma: PrismaService,
    private pythonApi: PythonApiService,
    @Inject(forwardRef(() => ExchangesService))
    private exchangesService: ExchangesService,
    private binanceService: BinanceService,
  ) { }

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
   * Get top N trending assets with Tier-1 Trend Ranking
   * 
   * Ranking formula:
   * trend_score = (galaxy_score × 0.4) + ((100 − alt_rank) × 0.3) + (social_score × 0.3)
   * 
   * Includes:
   * - Trend direction (UP/DOWN/STABLE) by comparing with previous poll
   * - Volume surge detection (NORMAL/VOLUME_SURGE/MASSIVE_SURGE)
   * - Realtime OHLCV data from Binance
   */
  async getTopTrendingAssets(limit: number = 20, enrichWithRealtime: boolean = true) {
  try {
    const rows: any[] = await this.prisma.$queryRawUnsafe(`
      SELECT DISTINCT ON (ta.asset_id)
        ta.asset_id,
        ta.galaxy_score,
        ta.alt_rank,
        ta.social_score,
        ta.price_usd,
        ta.market_volume,
        ta.poll_timestamp
      FROM trending_assets ta
      WHERE
        ta.galaxy_score IS NOT NULL
        AND ta.alt_rank IS NOT NULL
        AND ta.alt_rank < 300
        AND ta.price_usd IS NOT NULL
        AND ta.market_volume > 10000000
      ORDER BY
        ta.asset_id,
        ta.price_usd DESC
    `);

    if (!rows.length) return [];

    const assetIds = rows.map(r => r.asset_id);

    const assets = await this.prisma.assets.findMany({
      where: {
        asset_id: { in: assetIds },
        asset_type: 'crypto',
        NOT: {
          symbol: {
            in: [
              'USDT','USDC','DAI','PYUSD','USD1',
              'WBETH','STETH','CBBTC','FBTC',
              'XAUT','PAXG'
            ]
          }
        }
      }
    });

    const assetMap = new Map<string, any>(assets.map(a => [a.asset_id, a]));

    const baseResults = rows
      .filter(r => assetMap.has(r.asset_id))
      .slice(0, limit)
      .map(r => {
        const asset = assetMap.get(r.asset_id)!;
        return {
          asset_id: r.asset_id,
          symbol: asset.symbol,
          asset_type: asset.asset_type,
          galaxy_score: Number(r.galaxy_score),
          alt_rank: Number(r.alt_rank),
          social_score: Number(r.social_score ?? 0),
          price_usd: Number(r.price_usd),
          market_volume: Number(r.market_volume),
          poll_timestamp: r.poll_timestamp,
        };
      });

    // Enrich with realtime Binance data if requested
    if (enrichWithRealtime) {
      const enrichedResults = await Promise.all(
        baseResults.map(async (asset) => {
          try {
            const realtimeData = await this.binanceService.getEnrichedMarketData(asset.symbol);
            return {
              ...asset,
              realtime_data: {
                price: realtimeData.price,
                priceChangePercent: realtimeData.priceChangePercent,
                high24h: realtimeData.high24h,
                low24h: realtimeData.low24h,
                volume24h: realtimeData.volume24h,
                quoteVolume24h: realtimeData.quoteVolume24h,
              },
            };
          } catch (error: any) {
            this.logger.warn(`Could not fetch realtime data for ${asset.symbol}: ${error.message}`);
            return { ...asset, realtime_data: null };
          }
        })
      );
      return enrichedResults;
    }

    return baseResults;

  } catch (err: any) {
    this.logger.warn(`Trending assets error: ${err?.message || err}`);
    return [];
  }
}

  /**
   * Process preview for a single asset (extracted for parallel processing)
   */
  private async processAssetPreview(
    strategyId: string,
    asset: any,
    strategyData: any,
    strategy: any,
    connectionId: string | null,
    exchange: string,
  ): Promise<any> {
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

    // Call Python API to generate signal (preview only, not stored)
    // Pass asset symbol for OHLCV fetching (Python services need symbol, not UUID)
    // Use longer timeout for preview (60s) to handle slow external APIs
    const assetSymbol = asset.symbol || asset.asset_id;
    const signal = await this.pythonApi.post(
      '/api/v1/signals/generate',
      {
        strategy_id: strategyId,
        asset_id: asset.asset_id,
        asset_type: marketData.asset_type || 'crypto',
        connection_id: connectionId, // Automatically fetched from database if userId available
        exchange: exchange,
        asset_symbol: assetSymbol,
        strategy_data: {
          ...strategyData,
          user_id: strategy.user_id, // Pass user_id for logging/debugging
        },
        market_data: marketData,
      },
      { timeout: 60000 }, // 60 seconds for preview operations
    ).then((response) => response.data);

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

    return {
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
    };
  }

  /**
   * Preview strategy on multiple assets (without storing signals)
   */
  async previewStrategyOnAssets(
    strategyId: string,
    assetIds: string[],
    userId?: string, // Optional: current user ID for connection lookup
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

    // Get user's active connection once (shared across all assets)
    // Try userId parameter first (current user), then strategy.user_id
    let connectionId: string | null = null;
    let exchange: string = 'binance';
    const userIdToTry = userId || strategy.user_id;
    try {
      if (userIdToTry) {
        const activeConnection = await this.exchangesService.getActiveConnection(userIdToTry);
        connectionId = activeConnection.connection_id;
        exchange = activeConnection.exchange?.name?.toLowerCase() || 'binance';
        this.logger.debug(`Preview: Using connection ${connectionId} for exchange ${exchange} (user: ${userIdToTry})`);
      }
    } catch (error: any) {
      this.logger.debug(
        `Preview: Could not get active connection for user ${userIdToTry}: ${error.message}. OHLCV data may not be available.`,
      );
    }

    // Prepare strategy data once (shared across all assets)
    const strategyData = {
      entry_rules: strategy.entry_rules || [],
      exit_rules: strategy.exit_rules || [],
      indicators: strategy.indicators || [],
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

    // Process assets in parallel batches to avoid timeout
    // Batch size: 3 assets at a time to reduce per-batch time and avoid rate limits
    const BATCH_SIZE = 3;
    const TIMEOUT_MS = 60000; // 60 seconds per asset (matches Python API timeout for preview)

    for (let i = 0; i < assets.length; i += BATCH_SIZE) {
      const batchStartTime = Date.now();
      const batch = assets.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(assets.length / BATCH_SIZE);
      
      this.logger.log(`Processing batch ${batchNum}/${totalBatches} (${batch.length} assets)`);
      
      const batchResults = await Promise.allSettled(
        batch.map(async (asset) => {
          // Wrap in timeout to prevent hanging
          return Promise.race([
            this.processAssetPreview(
              strategyId,
              asset,
              strategyData,
              strategy,
              connectionId,
              exchange,
            ),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Asset processing timeout')), TIMEOUT_MS),
            ),
          ]);
        }),
      );

      // Process batch results
      for (let j = 0; j < batchResults.length; j++) {
        const result = batchResults[j];
        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          const asset = batch[j];
          this.logger.warn(
            `Error previewing strategy on asset ${asset.symbol}: ${result.reason?.message || result.reason}`,
          );
          results.push({
            asset_id: asset.asset_id,
            symbol: asset.symbol,
            asset_type: asset.asset_type,
            error: result.reason?.message || 'Processing failed',
          });
        }
      }

      const batchDuration = Date.now() - batchStartTime;
      this.logger.log(`Batch ${batchNum} completed in ${batchDuration}ms`);

      // Small delay between batches to avoid overwhelming APIs
      if (i + BATCH_SIZE < assets.length) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    return results;
  }
}

