import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { PythonApiService } from '../../../kyc/integrations/python-api.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { ExchangesService } from '../../exchanges/exchanges.service';
import { BinanceService } from '../../binance/binance.service';

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
    @Inject(forwardRef(() => ExchangesService))
    private exchangesService: ExchangesService,
    private binanceService: BinanceService,
  ) {}

  /**
   * Preview strategy on multiple assets (without storing signals)
   */
  async previewStrategy(
    strategyId: string,
    assetIds: string[],
    userId?: string, // Optional: current user ID for connection lookup
  ): Promise<any[]> {
    const startTime = Date.now();
    this.logger.log(`Preview started for strategy ${strategyId} with ${assetIds.length} assets`);
    
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
              userId,
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

    const totalDuration = Date.now() - startTime;
    this.logger.log(`Preview completed for strategy ${strategyId}: ${results.length} results in ${totalDuration}ms`);
    return results;
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
    userId?: string,
  ): Promise<any> {
    // Get market data (with caching)
    const marketData = await this.getMarketData(asset.asset_id);

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
          user_id: userId || strategy.user_id, // Pass user_id for logging/debugging
        },
        market_data: marketData,
      },
      { timeout: 60000 }, // 60 seconds for preview operations
    ).then((response) => response.data);

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

    // Try to enrich with live Binance data (realtime OHLCV)
    let liveTradeMetrics: any = null;
    let realtimeMarketData: any = null;
    
    try {
      // Fetch realtime market data from Binance
      realtimeMarketData = await this.binanceService.getEnrichedMarketData(asset.symbol);
      this.logger.debug(`Fetched realtime market data for ${asset.symbol}: price=${realtimeMarketData.price}`);
      
      // Use realtime price as entry if not already set
      const effectiveEntry = parsedEntry && parsedEntry > 0 ? parsedEntry : realtimeMarketData.price;
      
      if (effectiveEntry && effectiveEntry > 0 && parsedStopLoss && parsedTakeProfit) {
        liveTradeMetrics = await this.binanceService.calculateTradeMetrics(
          asset.symbol,
          effectiveEntry,
          parsedStopLoss,
          parsedTakeProfit,
        );
        this.logger.debug(`Calculated trade metrics for ${asset.symbol} with realtime data`);
      }
    } catch (error: any) {
      this.logger.warn(`Could not fetch realtime data for ${asset.symbol}: ${error.message}`);
      // Continue with computed values if Binance fetch fails
    }

    // Use live data if available, otherwise use computed values
    const finalStopLoss = liveTradeMetrics?.stop_loss ?? computedStopLossPrice ?? null;
    const finalTakeProfit = liveTradeMetrics?.exit ?? computedTakeProfitPrice ?? null;
    const finalVolume = liveTradeMetrics?.volume ?? realtimeMarketData?.volume24h ?? signal.volume ?? signal.market_volume ?? marketData.volume_24h ?? null;
    const finalProfit = liveTradeMetrics?.profit_percent ?? signal.changePercent ?? signal.change_pct ?? signal.profit ?? null;
    const finalExt = liveTradeMetrics?.extension_percent ?? signal.changePercent ?? signal.change_pct ?? null;
    const finalCurrentPrice = liveTradeMetrics?.current_price ?? realtimeMarketData?.price ?? marketData.price ?? null;
    const finalEntry = liveTradeMetrics?.entry ?? parsedEntry ?? realtimeMarketData?.price ?? marketData.price ?? null;

    return {
      asset_id: asset.asset_id,
      symbol: asset.symbol,
      asset_type: asset.asset_type,
      action: signal.action,
      final_score: signal.final_score,
      confidence: signal.confidence,
      engine_scores: signal.engine_scores,
      // Additional fields for frontend preview: entry/exit, prices, profit, win rate, volume, insights
      entry: finalEntry,
      entry_price: finalEntry,
      ext: finalExt ?? null,
      stop_loss: stopLossPct ?? null,
      stop_loss_price: finalStopLoss ?? null,
      take_profit: takeProfitPct ?? null,
      take_profit_price: finalTakeProfit ?? null,
      changePercent: signal.changePercent ?? signal.change_pct ?? signal.profit ?? null,
      winRate: signal.winRate ?? signal.win_rate ?? signal.win_pct ?? null,
      volume: finalVolume ?? null,
      profit: finalProfit ?? null,
      current_price: finalCurrentPrice,
      risk_reward_ratio: liveTradeMetrics?.risk_reward_ratio ?? null,
      // Include realtime market data
      realtime_data: realtimeMarketData ? {
        price: realtimeMarketData.price,
        priceChangePercent: realtimeMarketData.priceChangePercent,
        high24h: realtimeMarketData.high24h,
        low24h: realtimeMarketData.low24h,
        volume24h: realtimeMarketData.volume24h,
      } : null,
      insights: signal.insights ?? signal.reasons ?? [],
      // include strategy rules so frontend preview has entry/exit criteria
      entry_rules: strategy.entry_rules ?? null,
      exit_rules: strategy.exit_rules ?? null,
      breakdown: signal.breakdown ?? null,
    };
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

