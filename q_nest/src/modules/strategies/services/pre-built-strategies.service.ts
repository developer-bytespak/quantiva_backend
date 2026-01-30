import { Injectable, Logger, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { StrategyType, RiskLevel } from '@prisma/client';
import { PRE_BUILT_STRATEGIES } from '../data/pre-built-strategies';
import { PythonApiService } from '../../../kyc/integrations/python-api.service';
import { ExchangesService } from '../../exchanges/exchanges.service';
import { BinanceService } from '../../binance/binance.service';
import { MarketStocksDbService } from '../../stocks-market/services/market-stocks-db.service';

@Injectable()
export class PreBuiltStrategiesService implements OnModuleInit {
  private readonly logger = new Logger(PreBuiltStrategiesService.name);

  constructor(
    private prisma: PrismaService,
    private pythonApi: PythonApiService,
    @Inject(forwardRef(() => ExchangesService))
    private exchangesService: ExchangesService,
    private binanceService: BinanceService,
    private marketStocksDbService: MarketStocksDbService,
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
   * - Comprehensive market data from database (price, 24h change, volume, high/low)
   * - Asset display name and logo URL (cached)
   * - Optional realtime OHLCV data from Binance
   * - Only returns assets tradeable on Binance (when enrichWithRealtime=true)
   */
  async getTopTrendingAssets(limit: number = 20, enrichWithRealtime: boolean = true) {
    try {
      // Fetch more from DB to account for filtering out non-Binance tradeable assets
      // Typically ~60-70% of LunarCrush trending coins are on Binance
      const dbLimit = enrichWithRealtime ? Math.ceil(limit * 2) : limit;
      
      const rows: any[] = await this.prisma.$queryRaw`
        SELECT DISTINCT ON (ta.asset_id)
          ta.asset_id,
          ta.galaxy_score,
          ta.alt_rank,
          ta.social_score,
          ta.price_usd,
          ta.market_volume,
          ta.volume_24h,
          ta.price_change_24h,
          ta.price_change_24h_usd,
          ta.market_cap,
          ta.high_24h,
          ta.low_24h,
          ta.poll_timestamp,
          a.symbol,
          a.name,
          a.display_name,
          a.logo_url,
          a.coingecko_id,
          a.asset_type,
          a.market_cap_rank
        FROM trending_assets ta
        INNER JOIN assets a ON ta.asset_id = a.asset_id
        WHERE
          ta.galaxy_score IS NOT NULL
          AND ta.alt_rank IS NOT NULL
          AND ta.alt_rank < 300
          AND ta.price_usd IS NOT NULL
          AND ta.market_volume > 10000000
          AND a.asset_type = 'crypto'
          AND a.symbol NOT IN (
            'USDT','USDC','DAI','PYUSD','USD1',
            'WBETH','STETH','CBBTC','FBTC',
            'XAUT','PAXG'
          )
        ORDER BY
          ta.asset_id,
          ta.poll_timestamp DESC
        LIMIT ${dbLimit}
      `;

    if (!rows.length) return [];

    // Transform to response format with all DB fields
    let baseResults = rows.map(r => ({
      asset_id: r.asset_id,
      symbol: r.symbol,
      name: r.display_name || r.name || r.symbol,
      logo_url: r.logo_url,
      coingecko_id: r.coingecko_id,
      asset_type: r.asset_type,
      price_usd: Number(r.price_usd),
      price_change_24h: Number(r.price_change_24h || 0),
      price_change_24h_usd: Number(r.price_change_24h_usd || 0),
      market_cap: Number(r.market_cap || 0),
      volume_24h: Number(r.volume_24h || r.market_volume || 0),
      high_24h: Number(r.high_24h || 0),
      low_24h: Number(r.low_24h || 0),
      galaxy_score: Number(r.galaxy_score),
      alt_rank: Number(r.alt_rank),
      social_score: Number(r.social_score || 0),
      market_volume: Number(r.market_volume),
      market_cap_rank: r.market_cap_rank,
      poll_timestamp: r.poll_timestamp,
    }));

    // Enrich with realtime Binance data if requested (overrides DB values)
    if (enrichWithRealtime) {
      const enrichedResults = await Promise.all(
        baseResults.map(async (asset) => {
          try {
            const realtimeData = await this.binanceService.getEnrichedMarketData(asset.symbol);
            // Check if Binance returned valid data (null means symbol not found/tradeable)
            const isTradeable = realtimeData.price !== null && realtimeData.price > 0;
            
            return {
              ...asset,
              // Mark as tradeable if Binance has valid price data
              is_tradeable: isTradeable,
              // Override with fresh realtime data (keep DB values if Binance returns null)
              price_usd: realtimeData.price ?? asset.price_usd,
              price_change_24h: realtimeData.priceChangePercent ?? asset.price_change_24h,
              volume_24h: realtimeData.volume24h ?? asset.volume_24h,
              high_24h: realtimeData.high24h ?? asset.high_24h,
              low_24h: realtimeData.low24h ?? asset.low_24h,
              realtime_data: isTradeable ? {
                price: realtimeData.price,
                priceChangePercent: realtimeData.priceChangePercent,
                high24h: realtimeData.high24h,
                low24h: realtimeData.low24h,
                volume24h: realtimeData.volume24h,
                quoteVolume24h: realtimeData.quoteVolume24h,
              } : null,
            };
          } catch (error: any) {
            this.logger.warn(`Could not fetch realtime data for ${asset.symbol}: ${error.message}`);
            // Asset is not tradeable on Binance
            return { ...asset, is_tradeable: false, realtime_data: null };
          }
        })
      );
      
      // Filter out non-tradeable assets (coins not on Binance) and apply original limit
      const tradeableResults = enrichedResults
        .filter(a => a.is_tradeable)
        .slice(0, limit);
      this.logger.log(`Filtered ${enrichedResults.length} assets to ${tradeableResults.length} tradeable on Binance (limit: ${limit})`);
      
      return tradeableResults;
    }

    return baseResults;

  } catch (err: any) {
    this.logger.error(`Trending assets error: ${err?.message || err}`);
    return [];
  }
}

  /**
   * Get top N stocks from market database (for stocks connection)
   * Uses the same data source as the market page
   */
  async getTopStocks(limit: number = 500) {
    try {
      const stocks = await this.marketStocksDbService.getAllWithAssetId(limit);
      
      // Transform to match the format expected by preview endpoints
      return stocks.map(stock => ({
        asset_id: stock.asset_id,
        symbol: stock.symbol,
        name: stock.name,
        display_name: stock.name,
        asset_type: 'stock',
        sector: stock.sector,
        price_usd: stock.price,
        market_cap: stock.marketCap,
        volume_24h: stock.volume24h,
        price_change_24h: stock.changePercent24h,
        price_change_24h_usd: stock.change24h,
        market_cap_rank: stock.rank,
      }));
    } catch (error: any) {
      this.logger.error(`Failed to get top stocks: ${error?.message || error}`);
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
    const assetSymbol = asset.symbol || asset.asset_id;
    const signal = await this.pythonApi.post(
      '/api/v1/signals/generate',
      {
        strategy_id: strategyId,
        asset_id: asset.asset_id,
        asset_type: marketData.asset_type || 'crypto',
        connection_id: connectionId,
        exchange: exchange,
        asset_symbol: assetSymbol,
        strategy_data: {
          ...strategyData,
          user_id: strategy.user_id,
        },
        market_data: marketData,
      },
      { timeout: 20000 }, // 20s – typical 2–8s; fail fast on slow assets
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

    // Process assets in parallel batches to reduce total response time
    const BATCH_SIZE = 12;
    const TIMEOUT_MS = 20000; // 20 seconds per asset (fail fast; Python typically 2–8s)

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

      // Brief pause between batches to avoid overwhelming Python/exchange APIs
      if (i + BATCH_SIZE < assets.length) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    return results;
  }
}

