import { Controller, Get, Post, Put, Delete, Body, Param, Query, HttpCode, HttpStatus, UseGuards, NotFoundException, ForbiddenException, BadRequestException, InternalServerErrorException, Logger, Req } from '@nestjs/common';
import { Request } from 'express';
import { StrategiesService } from './strategies.service';
import { CreateStrategyDto, ValidateStrategyDto } from './dto/create-strategy.dto';
import { PreBuiltStrategiesService } from './services/pre-built-strategies.service';
import { StockTrendingService } from './services/stock-trending.service';
import { StrategyPreviewService } from './services/strategy-preview.service';
import { StrategyExecutionService } from './services/strategy-execution.service';
import { PreBuiltSignalsCronjobService } from './services/pre-built-signals-cronjob.service';
import { StockSignalsCronjobService } from './services/stock-signals-cronjob.service';
import { CustomStrategyCronjobService } from './services/custom-strategy-cronjob.service';
import { NewsCronjobService } from '../news/news-cronjob.service';
import { NewsService } from '../news/news.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { TokenPayload } from '../auth/services/token.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AiInsightsService } from '../../ai-insights/ai-insights.service';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { FeatureAccessService, FeatureType } from 'src/common/feature-access.service';

@Controller('strategies')
export class StrategiesController {
  private readonly logger = new Logger(StrategiesController.name);
  private readonly pythonApiUrl: string;

  constructor(
    private readonly strategiesService: StrategiesService,
    private readonly preBuiltStrategiesService: PreBuiltStrategiesService,
    private readonly stockTrendingService: StockTrendingService,
    private readonly strategyPreviewService: StrategyPreviewService,
    private readonly strategyExecutionService: StrategyExecutionService,
    private readonly preBuiltSignalsCronjobService: PreBuiltSignalsCronjobService,
    private readonly stockSignalsCronjobService: StockSignalsCronjobService,
    private readonly customStrategyCronjobService: CustomStrategyCronjobService,
    private readonly newsCronjobService: NewsCronjobService,
    private readonly newsService: NewsService,
    private readonly prisma: PrismaService,
    private readonly aiInsightsService: AiInsightsService,
    private readonly configService: ConfigService,
    private readonly featureAccessService: FeatureAccessService,

  ) {
    this.pythonApiUrl = this.configService.get<string>('PYTHON_API_URL') || 'http://localhost:8000/api/v1';
  }

  @Get()
  findAll(@Query('userId') userId?: string, @Query('type') type?: string) {
    if (userId) {
      return this.strategiesService.findByUser(userId);
    }
    if (type) {
      return this.strategiesService.findByType(type);
    }
    return this.strategiesService.findAll();
  }

  // Move specific routes BEFORE the generic :id route
  /**
   * Get all pre-built strategies (admin type)
   * @param asset_type Optional filter: 'crypto' | 'stock'
   * Endpoint: GET /strategies/pre-built?asset_type=crypto
   */
  @Get('pre-built')
  getPreBuiltStrategies(@Query('asset_type') assetType?: 'crypto' | 'stock') {
    return this.preBuiltStrategiesService.getPreBuiltStrategies(assetType);
  }

  @Get('trending-assets')
  getTrendingAssets(
    @Query('limit') limit?: string,
    @Query('realtime') realtime?: string,
  ) {
    const limitNum = limit ? parseInt(limit, 10) : 50;
    const enrichWithRealtime = realtime === 'true' || realtime === '1';
    return this.preBuiltStrategiesService.getTopTrendingAssets(limitNum, enrichWithRealtime);
  }

  /**
   * Get trending assets with AI insights for top 2 per strategy
   * Endpoint: GET /strategies/pre-built/:id/trending-with-insights
   */
  @Get('pre-built/:id/trending-with-insights')
  async getTrendingAssetsWithInsights(
    @Param('id') strategyId: string,
    @Query('limit') limit?: string,
  ) {
    // Verify strategy exists
    const strategy = await this.strategiesService.findOne(strategyId);
    if (!strategy) {
      throw new NotFoundException(`Strategy ${strategyId} not found`);
    }
    if (strategy.type !== 'admin') {
      throw new NotFoundException(`Strategy ${strategyId} is not a pre-built strategy`);
    }

    // Use a very high limit (10000) to effectively get all available stocks
    // This matches the market page behavior which uses limit 500 but we want all stocks
    const limitNum = limit ? parseInt(limit, 10) : 10000;
    this.logger.log(`getTrendingAssetsWithInsights called with limit=${limit}, parsed=${limitNum} for strategy ${strategyId}`);
    
    // Detect if this is a stock strategy by checking the name
    const isStockStrategy = strategy.name?.toLowerCase().includes('(stocks)') || 
                           strategy.name?.toLowerCase().includes('stock');
    
    // Get trending assets based on strategy type
    // Use database cached data (synced by cronjob) - no live API calls
    let assets: any[];
    if (isStockStrategy) {
      this.logger.log(`Fetching stocks for strategy: ${strategy.name} (limit: ${limitNum})`);
      // Use the same data source as market page (market_rankings table via getAllWithAssetId)
      // This ensures we get the same stocks available on the market page
      assets = await this.preBuiltStrategiesService.getTopStocks(limitNum);
      this.logger.log(`Retrieved ${assets.length} stocks from market database`);
    } else {
      assets = await this.preBuiltStrategiesService.getTopTrendingAssets(limitNum, true);
      this.logger.log(`Retrieved ${assets.length} crypto assets`);
    }
    
    if (assets.length === 0) {
      this.logger.warn(`No assets found for strategy ${strategyId}`);
      return { assets: [], insights: [] };
    }

    // Get signals for these assets with this strategy
    const assetIds = assets.map(a => a.asset_id);
    const signals = await this.prisma.strategy_signals.findMany({
      where: {
        strategy_id: strategyId,
        asset_id: { in: assetIds },
        user_id: null,
      },
      include: {
        details: {
          orderBy: { created_at: 'desc' },
          take: 1,
        },
      },
      orderBy: {
        timestamp: 'desc',
      },
    });

    // Create signal map (one signal per asset)
    const signalMap = new Map();
    for (const signal of signals) {
      if (!signalMap.has(signal.asset_id)) {
        signalMap.set(signal.asset_id, {
          signal_id: signal.signal_id,
          action: signal.action,
          confidence: signal.confidence,
          final_score: signal.final_score,
          entry_price: signal.details[0]?.entry_price,
          stop_loss: signal.details[0]?.stop_loss,
          take_profit_1: signal.details[0]?.take_profit_1,
          stop_loss_pct: strategy.stop_loss_value, // Add strategy percentage
          take_profit_pct: strategy.take_profit_value, // Add strategy percentage
          sentiment_score: signal.sentiment_score,
          trend_score: signal.trend_score,
        });
      }
    }

    // Generate AI insights for top 2 assets
    const top2Assets = assets.slice(0, 2);
    const assetsWithInsights = await this.aiInsightsService.generateTrendingAssetsInsights(
      top2Assets,
      strategyId,
      strategy.name,
      signalMap,
      2,
    );

    // Return top 2 with insights + remaining without
    const remaining = assets.slice(2).map(asset => ({
      ...asset,
      hasAiInsight: false,
      signal: signalMap.get(asset.asset_id) || null,
    }));

    const finalAssets = [
      ...assetsWithInsights.map(a => ({
        ...a,
        signal: signalMap.get(a.asset_id) || null,
      })),
      ...remaining,
    ];
    
    this.logger.log(`Returning ${finalAssets.length} assets (${assetsWithInsights.length} with insights, ${remaining.length} without)`);
    
    return {
      strategy: {
        id: strategy.strategy_id,
        name: strategy.name,
        description: strategy.description,
      },
      assets: finalAssets,
    };
  }

  /**
   * Generate AI insight for a specific asset card on-demand
   * Endpoint: POST /strategies/pre-built/:strategyId/assets/:assetId/generate-insight
   */
  @Post('pre-built/:strategyId/assets/:assetId/generate-insight')
  async generateAssetInsight(
    @Param('strategyId') strategyId: string,
    @Param('assetId') assetId: string,
  ) {
    // Verify strategy exists
    const strategy = await this.strategiesService.findOne(strategyId);
    if (!strategy) {
      throw new NotFoundException(`Strategy ${strategyId} not found`);
    }

    // Get asset details from trending_assets
    const asset = await this.prisma.trending_assets.findFirst({
      where: { asset_id: assetId },
      include: { asset: true },
      orderBy: { poll_timestamp: 'desc' },
    });

    if (!asset) {
      throw new NotFoundException(`Asset ${assetId} not found in trending assets`);
    }

    // Get signal for this asset-strategy combination
    const signal = await this.prisma.strategy_signals.findFirst({
      where: {
        strategy_id: strategyId,
        asset_id: assetId,
        user_id: null,
      },
      include: {
        details: {
          orderBy: { created_at: 'desc' },
          take: 1,
        },
      },
      orderBy: {
        timestamp: 'desc',
      },
    });

    // Format asset data
    const assetData = {
      asset_id: asset.asset_id,
      symbol: asset.asset.symbol,
      display_name: asset.asset.display_name,
      price_usd: Number(asset.price_usd),
      price_change_24h: Number(asset.price_change_24h),
      volume_24h: Number(asset.volume_24h),
      trend_score: Number(asset.galaxy_score),
    };

    // Format signal data if available
    const signalData = signal ? {
      signal_id: signal.signal_id,
      action: signal.action,
      confidence: Number(signal.confidence),
      final_score: Number(signal.final_score),
      entry_price: signal.details[0]?.entry_price ? Number(signal.details[0].entry_price) : undefined,
      stop_loss: signal.details[0]?.stop_loss ? Number(signal.details[0].stop_loss) : undefined,
      take_profit_1: signal.details[0]?.take_profit_1 ? Number(signal.details[0].take_profit_1) : undefined,
      sentiment_score: signal.sentiment_score ? Number(signal.sentiment_score) : undefined,
      trend_score: signal.trend_score ? Number(signal.trend_score) : undefined,
    } : undefined;

    // Generate insight
    try {
      const insight = await this.aiInsightsService.generateAssetInsight(
        assetData,
        strategyId,
        strategy.name,
        signalData,
      );

      return {
        asset_id: assetId,
        strategy_id: strategyId,
        insight,
        generated_at: new Date(),
        signal: signalData,
      };
    } catch (error: any) {
      throw new BadRequestException(`Failed to generate insight: ${error.message}`);
    }
  }

  @Get('pre-built/:id/signals')
  async getPreBuiltStrategySignals(
    @Param('id') id: string,
    @Query('latest_only') latestOnly?: string,
    @Query('realtime') realtime?: string,
  ) {
    // Verify strategy exists and is a pre-built strategy
    const strategy = await this.strategiesService.findOne(id);
    if (!strategy) {
      throw new NotFoundException(`Strategy ${id} not found`);
    }
    if (strategy.type !== 'admin') {
      throw new NotFoundException(`Strategy ${id} is not a pre-built strategy`);
    }

    const enrichWithRealtime = realtime === 'true' || realtime === '1';

    // If latest_only=true, return only one signal per asset (latest per asset)
    if (latestOnly === 'true' || latestOnly === '1') {
      const signals = await this.prisma.strategy_signals.findMany({
        where: {
          strategy_id: id,
          user_id: null, // Only system-generated signals
        },
        include: {
          asset: true,
          explanations: {
            orderBy: {
              created_at: 'desc',
            },
            take: 1, // Get latest explanation
          },
          details: {
            orderBy: {
              created_at: 'desc',
            },
            take: 1, // Get latest details
          },
        },
        orderBy: {
          timestamp: 'desc',
        },
        take: 1000, // Fetch enough to dedupe by asset
      });

      // Get latest trending_assets prices for fallback when Binance API fails
      const assetIds = [...new Set(signals.map(s => s.asset_id).filter(Boolean))];
      const trendingPrices = await this.prisma.trending_assets.findMany({
        where: { asset_id: { in: assetIds } },
        orderBy: { poll_timestamp: 'desc' },
        distinct: ['asset_id'],
        select: {
          asset_id: true,
          price_usd: true,
          volume_24h: true,
          price_change_24h: true,
        },
      });
      type TrendingPrice = { asset_id: string; price_usd: any; volume_24h: any; price_change_24h: any };
      const priceMap = new Map<string, TrendingPrice>(trendingPrices.map(p => [p.asset_id, p]));

      // Dedupe: keep only the latest signal per asset
      const seen = new Map<string, any>();
      for (const s of signals) {
        const assetId = s.asset?.asset_id || s.asset_id;
        if (!assetId) continue;
        if (!seen.has(assetId)) {
          // Get database price as fallback
          const dbPrice = priceMap.get(assetId);
          
          // Enrich signal with strategy parameters and database price fallback
          seen.set(assetId, {
            ...s,
            stop_loss: strategy.stop_loss_value,
            take_profit: strategy.take_profit_value,
            // Include database price as fallback for when Binance API returns 0
            price_usd: dbPrice?.price_usd ? Number(dbPrice.price_usd) : null,
            db_volume_24h: dbPrice?.volume_24h ? Number(dbPrice.volume_24h) : null,
            db_price_change_24h: dbPrice?.price_change_24h ? Number(dbPrice.price_change_24h) : null,
          });
        }
      }

      let results = Array.from(seen.values()).sort((a, b) => {
        const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return tb - ta;
      });

      // Enrich with realtime data if requested
      if (enrichWithRealtime) {
        const { BinanceService } = await import('../binance/binance.service');
        const binanceService = new BinanceService();
        
        results = await Promise.all(
          results.map(async (signal) => {
            if (signal.asset?.symbol) {
              try {
                const realtimeData = await binanceService.getEnrichedMarketData(signal.asset.symbol);
                // Check if Binance has valid price data for this symbol
                const isTradeable = realtimeData.price !== null && realtimeData.price > 0;
                
                return {
                  ...signal,
                  is_tradeable: isTradeable,
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
                // Symbol not found on Binance - mark as not tradeable
                return { ...signal, is_tradeable: false, realtime_data: null };
              }
            }
            return { ...signal, is_tradeable: false };
          })
        );
        
        // Filter out non-tradeable assets (not available on Binance)
        results = results.filter(r => r.is_tradeable);
        this.logger.log(`Filtered signals to ${results.length} tradeable assets`);
      }

      return results;
    }

    // Get all signals with explanations (without deduping)
    const signals = await this.prisma.strategy_signals.findMany({
      where: {
        strategy_id: id,
        user_id: null, // Only system-generated signals
      },
      include: {
        asset: true,
        explanations: {
          orderBy: {
            created_at: 'desc',
          },
          take: 1, // Get latest explanation
        },
        details: {
          orderBy: {
            created_at: 'desc',
          },
          take: 1, // Get latest details
        },
      },
      orderBy: {
        timestamp: 'desc',
      },
      take: 50, // Limit to latest 50 signals
    });

    // Enrich all signals with strategy parameters
    return signals.map((s) => ({
      ...s,
      stop_loss: strategy.stop_loss_value,
      take_profit: strategy.take_profit_value,
    }));
  }

  @Get('pre-built/:id/preview')
  async previewStrategy(
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('asset_type') assetType?: string, // 'stock' or 'crypto'
    @CurrentUser() user?: TokenPayload, // Optional: use if authenticated
  ) {
    const limitNum = limit ? parseInt(limit, 10) : 500; // Default to 500 for stocks
    let assets;
    
    // Use stocks from market database if asset_type is 'stock' or if no asset_type specified, try to detect
    if (assetType === 'stock') {
      assets = await this.preBuiltStrategiesService.getTopStocks(limitNum);
    } else {
      // For crypto or default, use trending assets
      assets = await this.preBuiltStrategiesService.getTopTrendingAssets(limitNum);
    }
    
    const assetIds = assets.map((a) => a.asset_id);
    return this.strategyPreviewService.previewStrategy(id, assetIds, user?.sub);
  }

  // Preview route for user-created strategies: GET /strategies/:id/preview
  @Get(':id/preview')
  async previewUserStrategy(
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('asset_type') assetType?: string, // 'stock' or 'crypto'
    @CurrentUser() user?: TokenPayload, // Optional: use if authenticated
  ) {
    const limitNum = limit ? parseInt(limit, 10) : 500; // Default to 500 for stocks
    let assets;
    
    // Use stocks from market database if asset_type is 'stock' or if no asset_type specified, try to detect
    if (assetType === 'stock') {
      assets = await this.preBuiltStrategiesService.getTopStocks(limitNum);
    } else {
      // For crypto or default, use trending assets
      assets = await this.preBuiltStrategiesService.getTopTrendingAssets(limitNum);
    }
    
    const assetIds = assets.map((a) => a.asset_id);
    return this.strategyPreviewService.previewStrategy(id, assetIds, user?.sub);
  }

  // Move this route BEFORE the generic :id route
  @Get(':id/signals')
  async getStrategySignals(
    @Param('id') id: string,
    @Query('latest_only') latestOnly?: string,
  ) {
    // Verify strategy exists and get its parameters
    const strategy = await this.strategiesService.findOne(id);
    if (!strategy) {
      throw new NotFoundException(`Strategy ${id} not found`);
    }

    // If latest_only=true, return only one signal per asset (latest per asset)
    if (latestOnly === 'true' || latestOnly === '1') {
      const signals = await this.prisma.strategy_signals.findMany({
        where: {
          strategy_id: id,
        },
        include: {
          asset: true,
          explanations: {
            orderBy: {
              created_at: 'desc',
            },
            take: 1, // Get latest explanation
          },
        },
        orderBy: {
          timestamp: 'desc',
        },
        take: 1000, // Fetch enough to dedupe by asset
      });

      // Dedupe: keep only the latest signal per asset
      const seen = new Map<string, any>();
      for (const s of signals) {
        const assetId = s.asset?.asset_id || s.asset_id;
        if (!assetId) continue;
        if (!seen.has(assetId)) {
          // Enrich signal with strategy parameters
          seen.set(assetId, {
            ...s,
            stop_loss: strategy.stop_loss_value,
            take_profit: strategy.take_profit_value,
          });
        }
      }

      return Array.from(seen.values()).sort((a, b) => {
        const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return tb - ta;
      });
    }

    // Get all signals with explanations (without deduping)
    const signals = await this.prisma.strategy_signals.findMany({
      where: {
        strategy_id: id,
      },
      include: {
        asset: true,
        explanations: {
          orderBy: {
            created_at: 'desc',
          },
          take: 1, // Get latest explanation
        },
      },
      orderBy: {
        timestamp: 'desc',
      },
      take: 50, // Limit to latest 50 signals
    });

    // Enrich all signals with strategy parameters
    return signals.map((s) => ({
      ...s,
      stop_loss: strategy.stop_loss_value,
      take_profit: strategy.take_profit_value,
    }));
  }

  /**
   * Get available stock symbols for strategy creation
   * Must be placed BEFORE generic :id route to avoid route conflict
   * Endpoint: GET /strategies/available-stocks
   */
  @Get('available-stocks')
  async getAvailableStocks(@Query('search') search?: string, @Query('limit') limit?: string) {
    const limitNum = limit ? parseInt(limit, 10) : 50;
    
    try {
      const whereClause: any = {
        asset_type: 'stock',
      };

      if (search) {
        whereClause.OR = [
          { symbol: { contains: search.toUpperCase() } },
          { name: { contains: search } },
        ];
      }

      const stocks = await this.prisma.assets.findMany({
        where: whereClause,
        select: {
          asset_id: true,
          symbol: true,
          name: true,
          display_name: true,
        },
        take: limitNum,
        orderBy: { symbol: 'asc' },
      });

      return stocks.map(s => ({
        symbol: s.symbol,
        name: s.name || s.display_name || s.symbol,
      }));
    } catch (error) {
      this.logger.error('Error fetching available stocks:', error);
      throw new BadRequestException('Failed to fetch available stocks');
    }
  }

  /**
   * ============================================
   * USER CUSTOM STRATEGY ENDPOINTS (STOCKS & CRYPTO)
   * Must be declared BEFORE @Get(':id') so /my-strategies is not matched as :id
   * ============================================
   */

  /**
   * Get all strategies owned by the current logged-in user
   * @param asset_type Optional filter: 'crypto' | 'stock'
   * Endpoint: GET /strategies/my-strategies?asset_type=crypto
   */
  @UseGuards(JwtAuthGuard)
  @Get('my-strategies')
  async getMyStrategies(
    @CurrentUser() user: TokenPayload,
    @Query('asset_type') assetType?: 'crypto' | 'stock',
  ) {
    if (!user?.sub) {
      throw new BadRequestException('User ID not found in token');
    }
    this.logger.log(`Fetching strategies for user: ${user.sub}, asset_type: ${assetType || 'all'}`);

    try {
      const whereClause: any = {
        user_id: user.sub,
        type: 'user', // Only user-created strategies, not admin/pre-built
      };

      // Filter by asset_type if provided
      if (assetType) {
        whereClause.asset_type = assetType;
      }

      const strategies = await this.prisma.strategies.findMany({
        where: whereClause,
        include: {
          signals: {
            orderBy: { timestamp: 'desc' },
            take: 5, // Last 5 signals per strategy
          },
          _count: {
            select: { signals: true },
          },
        },
        orderBy: { created_at: 'desc' },
      });

      // Calculate performance metrics for each strategy
      const strategiesWithMetrics = await Promise.all(
        strategies.map(async (strategy) => {
          // Get signal stats
          const signalStats = await this.prisma.strategy_signals.groupBy({
            by: ['action'],
            where: { strategy_id: strategy.strategy_id },
            _count: true,
          });

          const buySignals = signalStats.find(s => s.action === 'BUY')?._count || 0;
          const sellSignals = signalStats.find(s => s.action === 'SELL')?._count || 0;
          const holdSignals = signalStats.find(s => s.action === 'HOLD')?._count || 0;

          // Get average confidence
          const avgConfidence = await this.prisma.strategy_signals.aggregate({
            where: { strategy_id: strategy.strategy_id },
            _avg: { confidence: true, final_score: true },
          });

          return {
            ...strategy,
            metrics: {
              total_signals: strategy._count.signals,
              buy_signals: buySignals,
              sell_signals: sellSignals,
              hold_signals: holdSignals,
              avg_confidence: avgConfidence._avg.confidence ? Number(avgConfidence._avg.confidence) : 0,
              avg_score: avgConfidence._avg.final_score ? Number(avgConfidence._avg.final_score) : 0,
            },
          };
        })
      );

      // Serialize to plain JSON-safe objects (Prisma Decimal/Date can break Nest response)
      return JSON.parse(
        JSON.stringify(strategiesWithMetrics, (_, v) => {
          if (v instanceof Date) return v.toISOString();
          if (v != null && typeof v === 'object' && typeof (v as any).toNumber === 'function') return (v as any).toNumber();
          return v;
        }),
      );
    } catch (err: any) {
      this.logger.error(`getMyStrategies failed: ${err?.message}`, err?.stack);
      throw new InternalServerErrorException(
        err?.message?.includes('Invalid') || err?.code === 'P2002' ? err.message : 'Failed to load strategies'
      );
    }
  }

  /**
   * Create a new custom stock strategy for the current user
   * Requires a stock (Alpaca) exchange connection
   * Endpoint: POST /strategies/custom/stocks
   */
  @UseGuards(JwtAuthGuard)
  @Post('custom/stocks')
  @HttpCode(HttpStatus.CREATED)
  async createStockStrategy(
    @Body() dto: CreateStrategyDto,
    @CurrentUser() user: TokenPayload,
    @Req() req: any,
  ) {
    this.logger.log(`Creating custom stock strategy for user: ${user.sub}`);

    // Ensure user ownership
    dto.user_id = user.sub;
    dto.type = 'user' as any; // Force type to 'user'
    dto.asset_type = 'stock' as any; // Force asset_type to 'stock'

    // Validate stock symbols exist (basic validation)
    if (!dto.target_assets || dto.target_assets.length === 0) {
      throw new BadRequestException('At least one target stock symbol is required');
    }

    const canAccess = await this.featureAccessService.canAccessFeature(
    user.sub, 
    FeatureType.CUSTOM_STRATEGIES,
  );

  if (!canAccess.allowed) {
    throw new ForbiddenException(
      `Strategy limit reached. Upgrade your plan to create more strategies.`,
    );
  }

    // Create the strategy
    const strategy = await this.strategiesService.createCustomStrategy(dto);

    this.logger.log(`Created stock strategy ${strategy.strategy_id} for user ${user.sub}`);

     await this.featureAccessService.incrementUsage(
    req.subscriptionUser?.subscription_id,
    req.subscriptionUser?.user_id,
    FeatureType.CUSTOM_STRATEGIES,
  );


    return {
      success: true,
      message: 'Stock strategy created successfully',
      strategy,
    };
  }

  /**
   * Create a new custom crypto strategy for the current user
   * Requires a crypto (Binance) exchange connection
   * Endpoint: POST /strategies/custom/crypto
   */
  @UseGuards(JwtAuthGuard)
  @Post('custom/crypto')
  @HttpCode(HttpStatus.CREATED)
  async createCryptoStrategy(
    @Body() dto: CreateStrategyDto,
    @CurrentUser() user: TokenPayload,
    @Req() req: Request,
  ) {
    this.logger.log(`Creating custom crypto strategy for user: ${user.sub}`);

    // Ensure user ownership
    dto.user_id = user.sub;
    dto.type = 'user' as any; // Force type to 'user'
    dto.asset_type = 'crypto' as any; // Force asset_type to 'crypto'

    // Validate crypto symbols exist (basic validation)
    if (!dto.target_assets || dto.target_assets.length === 0) {
      throw new BadRequestException('At least one target crypto symbol is required');
    }

    // Check feature access
    const canAccess = await this.featureAccessService.canAccessFeature(
      user.sub,
      FeatureType.CUSTOM_STRATEGIES,
    );

    if (!canAccess.allowed) {
      throw new ForbiddenException(
        `Strategy limit reached. Upgrade your plan to create more strategies.`,
      );
    }

    // Create the strategy
    const strategy = await this.strategiesService.createCustomStrategy(dto);

    this.logger.log(`Created crypto strategy ${strategy.strategy_id} for user ${user.sub}`);

    // Increment feature usage
    await this.featureAccessService.incrementUsage(
      req.subscriptionUser?.subscription_id,
      req.subscriptionUser?.user_id,
      FeatureType.CUSTOM_STRATEGIES,
    );

    return {
      success: true,
      message: 'Crypto strategy created successfully',
      strategy,
    };
  }

  /**
   * Get a specific user strategy (with ownership verification)
   * Endpoint: GET /strategies/my-strategies/:id
   */
  @UseGuards(JwtAuthGuard)
  @Get('my-strategies/:id')
  async getMyStrategy(
    @Param('id') strategyId: string,
    @CurrentUser() user: TokenPayload,
  ) {
    const strategy = await this.prisma.strategies.findUnique({
      where: { strategy_id: strategyId },
      include: {
        signals: {
          orderBy: { timestamp: 'desc' },
          take: 20,
          include: {
            asset: true,
            explanations: {
              orderBy: { created_at: 'desc' },
              take: 1,
            },
          },
        },
        parameters: true,
      },
    });

    if (!strategy) {
      throw new NotFoundException(`Strategy ${strategyId} not found`);
    }

    if (strategy.user_id !== user.sub) {
      throw new ForbiddenException('You do not own this strategy');
    }

    return strategy;
  }

  /**
   * Update a user's custom strategy
   * Endpoint: PUT /strategies/my-strategies/:id
   */
  @UseGuards(JwtAuthGuard)
  @Put('my-strategies/:id')
  async updateMyStrategy(
    @Param('id') strategyId: string,
    @Body() updateDto: Partial<CreateStrategyDto>,
    @CurrentUser() user: TokenPayload,
  ) {
    // Verify ownership
    const strategy = await this.prisma.strategies.findUnique({
      where: { strategy_id: strategyId },
    });

    if (!strategy) {
      throw new NotFoundException(`Strategy ${strategyId} not found`);
    }

    if (strategy.user_id !== user.sub) {
      throw new ForbiddenException('You do not own this strategy');
    }

    // Update strategy
    const updated = await this.prisma.strategies.update({
      where: { strategy_id: strategyId },
      data: {
        name: updateDto.name,
        description: updateDto.description,
        risk_level: updateDto.risk_level,
        timeframe: updateDto.timeframe,
        entry_rules: updateDto.entry_rules as any,
        exit_rules: updateDto.exit_rules as any,
        indicators: updateDto.indicators as any,
        stop_loss_value: updateDto.stop_loss_value,
        take_profit_value: updateDto.take_profit_value,
        target_assets: updateDto.target_assets as any,
        is_active: updateDto.is_active,
        updated_at: new Date(),
      },
      include: {
        parameters: true,
      },
    });

    this.logger.log(`Updated strategy ${strategyId} for user ${user.sub}`);

    return {
      success: true,
      message: 'Strategy updated successfully',
      strategy: updated,
    };
  }

  /**
   * Delete a user's custom strategy
   * Endpoint: DELETE /strategies/my-strategies/:id
   */
  @UseGuards(JwtAuthGuard)
  @Delete('my-strategies/:id')
  async deleteMyStrategy(
    @Param('id') strategyId: string,
    @CurrentUser() user: TokenPayload,
  ) {
    // Verify ownership and strategy type
    const strategy = await this.prisma.strategies.findUnique({
      where: { strategy_id: strategyId },
    });

    if (!strategy) {
      throw new NotFoundException(`Strategy ${strategyId} not found`);
    }

    if (strategy.user_id !== user.sub) {
      throw new ForbiddenException('You do not own this strategy');
    }

    // Prevent deletion of pre-built (admin) strategies
    if (strategy.type === 'admin') {
      throw new ForbiddenException('Cannot delete pre-built strategies. Only custom user strategies can be deleted.');
    }

    // Check if this strategy is being used as a template
    const dependentStrategies = await this.prisma.strategies.findMany({
      where: { template_id: strategyId },
      select: { strategy_id: true, name: true },
    });

    if (dependentStrategies.length > 0) {
      throw new BadRequestException(
        `Cannot delete strategy. It is being used as a template by ${dependentStrategies.length} other strategies. Please delete the dependent strategies first.`
      );
    }

    // Use database transaction for atomicity
    await this.prisma.$transaction(async (tx) => {
      // Get all signals for this strategy
      const signals = await tx.strategy_signals.findMany({
        where: { strategy_id: strategyId },
        select: { signal_id: true },
      });
      const signalIds = signals.map(s => s.signal_id);

      // PHASE 1: Delete deepest dependencies first
      if (signalIds.length > 0) {
        // Delete order executions (if any orders reference these signals)
        await tx.order_executions.deleteMany({
          where: {
            order: {
              signal_id: { in: signalIds }
            }
          }
        });

        // Delete orders that reference these signals
        await tx.orders.deleteMany({
          where: { signal_id: { in: signalIds } },
        });

        // Delete auto-trade evaluations
        await tx.auto_trade_evaluations.deleteMany({
          where: { signal_id: { in: signalIds } },
        });

        // Delete signal explanations
        await tx.signal_explanations.deleteMany({
          where: { signal_id: { in: signalIds } },
        });

        // Delete signal details
        await tx.signal_details.deleteMany({
          where: { signal_id: { in: signalIds } },
        });

        // Delete strategy signals
        await tx.strategy_signals.deleteMany({
          where: { strategy_id: strategyId },
        });
      }

      // PHASE 2: Delete strategy-level dependencies
      // Delete strategy execution jobs
      await tx.strategy_execution_jobs.deleteMany({
        where: { strategy_id: strategyId },
      });

      // Delete strategy parameters
      await tx.strategy_parameters.deleteMany({
        where: { strategy_id: strategyId },
      });

      // PHASE 3: Finally delete the strategy itself
      await tx.strategies.delete({
        where: { strategy_id: strategyId },
      });
    });

    this.logger.log(`Successfully deleted strategy ${strategyId} and all related data for user ${user.sub}`);

    return {
      success: true,
      message: 'Strategy and all related data deleted successfully',
    };
  }

  /**
   * Generate signals for a user's custom strategy (supports both stock and crypto)
   * Uses cached market data from the database for fast processing (no real-time API calls)
   * Endpoint: POST /strategies/my-strategies/:id/generate-signals
   */
  @UseGuards(JwtAuthGuard)
  @Post('my-strategies/:id/generate-signals')
  @HttpCode(HttpStatus.OK)
  async generateMyStrategySignals(
    @Param('id') strategyId: string,
    @CurrentUser() user: TokenPayload,
  ) {
    this.logger.log(`Generating signals for strategy ${strategyId} by user ${user.sub}`);

    // Verify ownership
    const strategy = await this.prisma.strategies.findUnique({
      where: { strategy_id: strategyId },
    });

    if (!strategy) {
      throw new NotFoundException(`Strategy ${strategyId} not found`);
    }

    if (strategy.user_id !== user.sub) {
      throw new ForbiddenException('You do not own this strategy');
    }

    // Get target assets
    const targetAssets = (strategy.target_assets as string[]) || [];
    if (targetAssets.length === 0) {
      throw new BadRequestException('Strategy has no target assets. Please add at least one asset to your strategy.');
    }

    // Determine asset type from strategy (default to 'crypto' for user strategies)
    const assetType = strategy.asset_type || 'crypto';
    this.logger.log(`Strategy asset type: ${assetType}, target assets: ${targetAssets.join(', ')}`);

    // Ensure assets exist in database - first try with type filter
    let assets = await this.prisma.assets.findMany({
      where: {
        symbol: { in: targetAssets },
        asset_type: assetType,
      },
    });

    // If no assets found, try without type filter (assets might exist with different type)
    if (assets.length === 0) {
      assets = await this.prisma.assets.findMany({
        where: {
          symbol: { in: targetAssets },
        },
      });
    }

    if (assets.length === 0) {
      // Try to create assets for the symbols
      this.logger.warn(`No assets found for symbols: ${targetAssets.join(', ')}. Creating them...`);
      
      for (const symbol of targetAssets) {
        await this.prisma.assets.upsert({
          where: { symbol },
          create: {
            symbol,
            name: symbol,
            display_name: symbol,
            asset_type: assetType,
          },
          update: {},
        });
      }

      // Re-fetch the newly created assets
      assets = await this.prisma.assets.findMany({
        where: {
          symbol: { in: targetAssets },
          asset_type: assetType,
        },
      });

      if (assets.length === 0) {
        throw new BadRequestException('Could not find or create assets for the specified symbols');
      }
    }

    this.logger.log(`Starting immediate signal generation for ${assets.length} assets`);
    
    // Ensure strategy is active
    if (!strategy.is_active) {
      await this.prisma.strategies.update({
        where: { strategy_id: strategyId },
        data: { is_active: true },
      });
    }

    // Generate signals immediately using StrategyExecutionService
    const generatedSignals = [];
    const errors = [];

    for (const asset of assets) {
      try {
        this.logger.log(`Generating signal for asset ${asset.symbol} (${asset.asset_id})`);
        
        const signal = await this.strategyExecutionService.executeStrategy(
          strategyId,
          asset.asset_id,
          false // Don't generate LLM explanation for manual generation
        );

        if (signal) {
          generatedSignals.push(signal);
          this.logger.log(`Successfully generated signal for ${asset.symbol}: ${signal.action}`);
        }
      } catch (error: any) {
        const errorMsg = `Failed to generate signal for ${asset.symbol}: ${error?.message}`;
        this.logger.error(errorMsg);
        errors.push(errorMsg);
      }
    }

    // Get the most recent signals for this strategy (including newly generated ones)
    const allSignals = await this.prisma.strategy_signals.findMany({
      where: {
        strategy_id: strategyId,
      },
      include: {
        asset: true,
        details: true,
      },
      orderBy: {
        timestamp: 'desc',
      },
      take: 50, // Increased to show all recent signals
    });

    this.logger.log(`Completed signal generation: ${generatedSignals.length} signals generated, ${errors.length} errors`);

    return {
      success: true,
      message: `Generated ${generatedSignals.length} signals immediately for ${assets.length} assets. ${errors.length > 0 ? `${errors.length} errors occurred.` : 'All signals generated successfully.'}`,
      scheduled: false,
      signalsGenerated: generatedSignals.length,
      totalSignals: allSignals.length,
      signals: allSignals.map(s => ({
        signal_id: s.signal_id,
        asset_id: s.asset_id,
        symbol: s.asset?.symbol,
        action: s.action,
        confidence: s.confidence,
        final_score: s.final_score,
        sentiment_score: s.sentiment_score,
        trend_score: s.trend_score,
        fundamental_score: s.fundamental_score,
        liquidity_score: s.liquidity_score,
        event_risk_score: s.event_risk_score,
        timestamp: s.timestamp,
        details: s.details[0] ? {
          entry_price: s.details[0].entry_price,
          stop_loss: s.details[0].stop_loss,
          take_profit_1: s.details[0].take_profit_1,
        } : null,
      })),
      errors: errors,
    };
  }

  /**
   * Get signals for a user's custom strategy
   * Endpoint: GET /strategies/my-strategies/:id/signals
   * 
   * Matches the pre-built signals format for frontend compatibility
   */
  @UseGuards(JwtAuthGuard)
  @Get('my-strategies/:id/signals')
  async getMyStrategySignals(
    @Param('id') strategyId: string,
    @CurrentUser() user: TokenPayload,
    @Query('limit') limit?: string,
    @Query('latest_only') latestOnly?: string,
    @Query('realtime') realtime?: string,
  ) {
    // Verify ownership
    const strategy = await this.prisma.strategies.findUnique({
      where: { strategy_id: strategyId },
    });

    if (!strategy) {
      throw new NotFoundException(`Strategy ${strategyId} not found`);
    }

    if (strategy.user_id !== user.sub) {
      throw new ForbiddenException('You do not own this strategy');
    }

    const limitNum = limit ? parseInt(limit, 10) : 50;
    const enrichWithRealtime = realtime === 'true' || realtime === '1';

    // If latest_only=true, return only one signal per asset (latest per asset) - same as pre-built
    if (latestOnly === 'true' || latestOnly === '1') {
      // Get target assets from strategy to filter signals
      const targetAssets = (strategy.target_assets as string[]) || [];
      
      // Build where clause - filter by target assets if specified
      let whereClause: any = {
        strategy_id: strategyId,
      };
      
      // If strategy has specific target assets, only return signals for those assets
      if (targetAssets.length > 0) {
        // Get asset IDs for target symbols
        const targetAssetRecords = await this.prisma.assets.findMany({
          where: {
            symbol: { in: targetAssets },
            asset_type: strategy.asset_type || 'crypto',
          },
          select: { asset_id: true, symbol: true },
        });
        
        const targetAssetIds = targetAssetRecords.map(a => a.asset_id);
        
        if (targetAssetIds.length > 0) {
          whereClause.asset_id = { in: targetAssetIds };
          this.logger.log(`Filtering signals to target assets: ${targetAssets.join(', ')} (${targetAssetIds.length} asset IDs)`);
        } else {
          this.logger.warn(`No assets found for target symbols: ${targetAssets.join(', ')}`);
          // Return empty array if target assets don't exist in database
          return [];
        }
      }
      
      const signals = await this.prisma.strategy_signals.findMany({
        where: whereClause,
        include: {
          asset: true,
          explanations: {
            orderBy: { created_at: 'desc' },
            take: 1,
          },
          details: {
            orderBy: { created_at: 'desc' },
            take: 1,
          },
        },
        orderBy: {
          timestamp: 'desc',
        },
        take: 1000, // Fetch enough to dedupe by asset
      });

      // Get latest trending_assets prices for fallback
      const assetIds = [...new Set(signals.map(s => s.asset_id).filter(Boolean))];
      const trendingPrices = await this.prisma.trending_assets.findMany({
        where: { asset_id: { in: assetIds } },
        orderBy: { poll_timestamp: 'desc' },
        distinct: ['asset_id'],
        select: {
          asset_id: true,
          price_usd: true,
          volume_24h: true,
          price_change_24h: true,
        },
      });
      type TrendingPrice = { asset_id: string; price_usd: any; volume_24h: any; price_change_24h: any };
      const priceMap = new Map<string, TrendingPrice>(trendingPrices.map(p => [p.asset_id, p]));

      // Dedupe: keep only the latest signal per asset
      const seen = new Map<string, any>();
      for (const s of signals) {
        const assetId = s.asset?.asset_id || s.asset_id;
        if (!assetId) continue;
        if (!seen.has(assetId)) {
          const dbPrice = priceMap.get(assetId);
          seen.set(assetId, {
            ...s,
            stop_loss: strategy.stop_loss_value,
            take_profit: strategy.take_profit_value,
            price_usd: dbPrice?.price_usd ? Number(dbPrice.price_usd) : null,
            db_volume_24h: dbPrice?.volume_24h ? Number(dbPrice.volume_24h) : null,
            db_price_change_24h: dbPrice?.price_change_24h ? Number(dbPrice.price_change_24h) : null,
          });
        }
      }

      let results = Array.from(seen.values()).sort((a, b) => {
        const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return tb - ta;
      });

      // Enrich with realtime data if requested (same as pre-built)
      if (enrichWithRealtime) {
        this.logger.log(`Enriching ${results.length} signals with realtime data`);
        
        // Check if this is a stock strategy - don't use Binance for stocks
        const isStockStrategy = strategy.asset_type === 'stock';
        
        if (isStockStrategy) {
          this.logger.warn(`Skipping realtime enrichment for stock strategy - Binance API only supports crypto`);
          // For stock strategies, mark all as tradeable but without realtime data
          results = results.map(r => ({
            ...r,
            is_tradeable: true,
            realtime_data: null,
            fallback_reason: 'stock_strategy_no_realtime_data',
            note: 'Stock strategies use database prices only - realtime=true parameter ignored'
          }));
        } else {
          // Original crypto enrichment logic
          const { BinanceService } = await import('../binance/binance.service');
          const binanceService = new BinanceService();
          
          let realtimeFailureCount = 0;
          let networkErrorCount = 0;
          
          results = await Promise.all(
            results.map(async (signal) => {
              if (signal.asset?.symbol) {
                try {
                  const realtimeData = await binanceService.getEnrichedMarketData(signal.asset.symbol);
                  const isTradeable = realtimeData.price !== null && realtimeData.price > 0;
                  
                  if (!isTradeable) {
                    this.logger.warn(`Asset ${signal.asset.symbol} not tradeable on Binance`);
                    realtimeFailureCount++;
                  }
                  
                  return {
                    ...signal,
                    is_tradeable: isTradeable,
                    realtime_data: isTradeable ? {
                      price: realtimeData.price,
                      priceChangePercent: realtimeData.priceChangePercent,
                      high24h: realtimeData.high24h,
                      low24h: realtimeData.low24h,
                      volume24h: realtimeData.volume24h,
                      quoteVolume24h: realtimeData.quoteVolume24h,
                    } : null,
                    // Keep database prices as fallback
                    fallback_reason: !isTradeable ? 'not_tradeable_on_binance' : null,
                  };
                } catch (error: any) {
                  this.logger.error(`Binance API error for ${signal.asset.symbol}:`, error.message);
                  networkErrorCount++;
                  
                  // Return signal with database data as fallback
                  return { 
                    ...signal, 
                    is_tradeable: false, 
                    realtime_data: null,
                    fallback_reason: 'binance_api_error',
                    error_details: error.message,
                  };
                }
              }
              return { 
                ...signal, 
                is_tradeable: false,
                fallback_reason: 'no_symbol',
              };
            })
          );
          
          this.logger.log(`Realtime enrichment results: ${results.length} total, ${realtimeFailureCount} not tradeable, ${networkErrorCount} API errors`);
          
          // Only filter out if we have some tradeable results, otherwise keep all with database data
          const tradeableResults = results.filter(r => r.is_tradeable);
          
          if (tradeableResults.length === 0) {
            // If no tradeable results, return all with database data as fallback
            this.logger.warn(`No tradeable assets found on Binance, returning ${results.length} signals with database data`);
            results = results.map(r => ({
              ...r,
              is_tradeable: true, // Mark as tradeable to show in UI
              realtime_data: null, // But no realtime data
              fallback_mode: true,
            }));
          } else if (tradeableResults.length < results.length * 0.5) {
            // If less than 50% are tradeable, might be API issues - include some database fallbacks
            this.logger.warn(`Only ${tradeableResults.length}/${results.length} assets tradeable on Binance, including database fallbacks`);
            const nonTradeableWithDb = results.filter(r => !r.is_tradeable && r.price_usd);
            results = [...tradeableResults, ...nonTradeableWithDb.slice(0, Math.min(5, nonTradeableWithDb.length))];
          } else {
            // Normal case - use only tradeable results
            results = tradeableResults;
          }
        }
        
        this.logger.log(`Final filtered custom signals: ${results.length} assets`);
      }

      return results;
    }

    // Get all signals with explanations (without deduping) - same format as pre-built
    // Apply same target assets filtering as latest_only case
    const targetAssets = (strategy.target_assets as string[]) || [];
    
    let whereClause: any = {
      strategy_id: strategyId,
    };
    
    // If strategy has specific target assets, only return signals for those assets
    if (targetAssets.length > 0) {
      // Get asset IDs for target symbols
      const targetAssetRecords = await this.prisma.assets.findMany({
        where: {
          symbol: { in: targetAssets },
          asset_type: strategy.asset_type || 'crypto',
        },
        select: { asset_id: true, symbol: true },
      });
      
      const targetAssetIds = targetAssetRecords.map(a => a.asset_id);
      
      if (targetAssetIds.length > 0) {
        whereClause.asset_id = { in: targetAssetIds };
        this.logger.log(`Filtering all signals to target assets: ${targetAssets.join(', ')} (${targetAssetIds.length} asset IDs)`);
      } else {
        this.logger.warn(`No assets found for target symbols: ${targetAssets.join(', ')}`);
        // Return empty array if target assets don't exist in database
        return [];
      }
    }
    
    const signals = await this.prisma.strategy_signals.findMany({
      where: whereClause,
      include: {
        asset: true,
        explanations: {
          orderBy: { created_at: 'desc' },
          take: 1,
        },
        details: {
          orderBy: { created_at: 'desc' },
          take: 1,
        },
      },
      orderBy: {
        timestamp: 'desc',
      },
      take: limitNum,
    });

    // Enrich all signals with strategy parameters (same as pre-built)
    return signals.map((s) => ({
      ...s,
      stop_loss: strategy.stop_loss_value,
      take_profit: strategy.take_profit_value,
    }));
  }

  /**
   * Debug endpoint to diagnose why signals might be empty
   * Endpoint: GET /strategies/my-strategies/:id/debug
   */
  @UseGuards(JwtAuthGuard)
  @Get('my-strategies/:id/debug')
  async debugMyStrategySignals(
    @Param('id') strategyId: string,
    @CurrentUser() user: TokenPayload,
  ) {
    // Verify ownership
    const strategy = await this.prisma.strategies.findUnique({
      where: { strategy_id: strategyId },
    });

    if (!strategy) {
      throw new NotFoundException(`Strategy ${strategyId} not found`);
    }

    if (strategy.user_id !== user.sub) {
      throw new ForbiddenException('You do not own this strategy');
    }

    // Get strategy details
    const targetAssets = (strategy.target_assets as string[]) || [];
    const assetType = strategy.asset_type || 'crypto';

    // Check assets in database
    const assetsInDb = await this.prisma.assets.findMany({
      where: {
        symbol: { in: targetAssets },
        asset_type: assetType,
      },
    });

    // Check existing signals
    const existingSignals = await this.prisma.strategy_signals.findMany({
      where: { strategy_id: strategyId },
      include: { asset: true },
      orderBy: { timestamp: 'desc' },
      take: 10,
    });

    // Check how many signals would be filtered by target_assets
    const targetAssetIds = assetsInDb.map(a => a.asset_id);
    const filteredSignals = existingSignals.filter(s => 
      targetAssetIds.length === 0 || targetAssetIds.includes(s.asset_id)
    );

    // Check recent signal generation attempts
    const last24Hours = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentSignals = filteredSignals.filter(s => 
      s.timestamp && new Date(s.timestamp) > last24Hours
    );

    // Get unique asset symbols from all signals vs filtered signals
    const allSignalSymbols = [...new Set(existingSignals.map(s => s.asset?.symbol).filter(Boolean))];
    const filteredSignalSymbols = [...new Set(filteredSignals.map(s => s.asset?.symbol).filter(Boolean))];

    // Test Binance API connectivity for diagnosis
    let binanceApiStatus = 'unknown';
    let binanceTestResults = [];
    
    try {
      const { BinanceService } = await import('../binance/binance.service');
      const binanceService = new BinanceService();
      
      // Test a few common symbols
      const testSymbols = ['BTC', 'ETH', 'BNB'];
      const testPromises = testSymbols.map(async (symbol) => {
        try {
          const data = await binanceService.getEnrichedMarketData(symbol);
          return { symbol, status: 'success', tradeable: data.price !== null };
        } catch (error) {
          return { symbol, status: 'error', error: error.message };
        }
      });
      
      binanceTestResults = await Promise.all(testPromises);
      const successCount = binanceTestResults.filter(r => r.status === 'success').length;
      
      if (successCount === testSymbols.length) {
        binanceApiStatus = 'healthy';
      } else if (successCount > 0) {
        binanceApiStatus = 'partial';
      } else {
        binanceApiStatus = 'failed';
      }
    } catch (error) {
      binanceApiStatus = 'error';
      binanceTestResults = [{ error: error.message }];
    }

    return {
      strategy: {
        name: strategy.name,
        asset_type: assetType,
        is_active: strategy.is_active,
        target_assets: targetAssets,
        entry_rules: strategy.entry_rules,
        engine_weights: strategy.engine_weights,
      },
      assets_analysis: {
        requested_symbols: targetAssets,
        found_in_database: assetsInDb.map(a => ({ symbol: a.symbol, asset_id: a.asset_id })),
        missing_symbols: targetAssets.filter(symbol => 
          !assetsInDb.some(asset => asset.symbol === symbol)
        ),
      },
      signals_analysis: {
        total_signals_ever: existingSignals.length,
        signals_for_target_assets: filteredSignals.length,
        recent_signals_24h: recentSignals.length,
        last_signal_time: existingSignals[0]?.timestamp || null,
        signal_actions: this.getSignalDistribution(existingSignals),
        target_asset_actions: this.getSignalDistribution(filteredSignals),
        all_signal_symbols: allSignalSymbols,
        target_signal_symbols: filteredSignalSymbols,
        signals_filtered_out: existingSignals.length - filteredSignals.length,
      },
      binance_api_status: {
        status: binanceApiStatus,
        test_results: binanceTestResults,
        note: 'realtime=true depends on Binance API - failures here cause empty signals',
      },
      potential_issues: this.identifyPotentialIssues(strategy, assetsInDb, existingSignals, binanceApiStatus),
    };
  }

  private getSignalDistribution(signals: any[]) {
    const distribution = { BUY: 0, SELL: 0, HOLD: 0 };
    signals.forEach(signal => {
      if (distribution[signal.action] !== undefined) {
        distribution[signal.action]++;
      }
    });
    return distribution;
  }

  private identifyPotentialIssues(strategy: any, assetsInDb: any[], signals: any[], binanceApiStatus?: string) {
    const issues = [];
    
    if (!strategy.is_active) {
      issues.push("Strategy is not active");
    }
    
    if (!strategy.target_assets || strategy.target_assets.length === 0) {
      issues.push("No target assets defined");
    }
    
    if (assetsInDb.length === 0) {
      issues.push("None of the target assets exist in database");
    }
    
    if (assetsInDb.length < strategy.target_assets?.length) {
      issues.push(`Only ${assetsInDb.length}/${strategy.target_assets?.length} target assets found in database`);
    }
    
    if (signals.length === 0) {
      issues.push("No signals have ever been generated for this strategy");
    }
    
    // Stock-specific advice about realtime parameter
    const isStockStrategy = strategy.asset_type === 'stock';
    if (isStockStrategy) {
      issues.push("📈 This is a STOCK strategy - don't use realtime=true parameter (Binance API only supports crypto)");
      issues.push("✅ For stocks, use: .../signals?latest_only=true (without realtime=true)");
    } else {
      // Check Binance API issues (major cause of empty signals with realtime=true)
      if (binanceApiStatus === 'failed') {
        issues.push("🚨 Binance API is completely unavailable - realtime=true will return empty results");
      } else if (binanceApiStatus === 'partial') {
        issues.push("⚠️ Binance API has partial failures - realtime=true may return fewer results");
      } else if (binanceApiStatus === 'error') {
        issues.push("❌ Binance API connection error - realtime=true may fail");
      }
    }
    
    // Check if entry rules are too restrictive
    const entryRules = strategy.entry_rules || [];
    const restrictiveRules = entryRules.filter(rule => 
      (rule.field === 'final_score' && rule.operator === '>' && rule.value > 0.8) ||
      (rule.field === 'confidence' && rule.operator === '>' && rule.value > 0.9)
    );
    
    if (restrictiveRules.length > 0) {
      issues.push("Entry rules might be too restrictive (final_score > 0.8 or confidence > 0.9)");
    }
    
    // Add info about signal filtering
    if (strategy.target_assets && strategy.target_assets.length > 0) {
      issues.push(`✅ NEW: Signals endpoint now filters to target_assets only (${strategy.target_assets.join(', ')})`);
      issues.push("📏 Check signals_analysis.signals_filtered_out to see how many old signals were excluded");
    }
    
    // Add specific advice for empty signals issue
    if (signals.length > 0 && !isStockStrategy && binanceApiStatus !== 'healthy') {
      issues.push("💡 Try calling the API without realtime=true parameter to get database-only results");
    }
    
    if (issues.length === 0) {
      issues.push("No obvious issues detected - check backend logs for detailed errors");
    }
    
    return issues;
  }

  /**
   * Get trending assets with insights for a custom strategy
   * Works the same as pre-built endpoint but uses strategy's target_assets
   * If target_assets is null/empty, returns all top 50 trending assets
   * 
   * Endpoint: GET /strategies/my-strategies/:id/trending-with-insights
   */
  @UseGuards(JwtAuthGuard)
  @Get('my-strategies/:id/trending-with-insights')
  async getCustomStrategyTrendingWithInsights(
    @Param('id') strategyId: string,
    @CurrentUser() user: TokenPayload,
    @Query('limit') limit?: string,
  ) {
    // Verify ownership
    const strategy = await this.prisma.strategies.findUnique({
      where: { strategy_id: strategyId },
    });

    if (!strategy) {
      throw new NotFoundException(`Strategy ${strategyId} not found`);
    }

    if (strategy.user_id !== user.sub) {
      throw new ForbiddenException('You do not own this strategy');
    }

    const limitNum = limit ? parseInt(limit, 10) : 50;
    const targetAssets = (strategy.target_assets as string[]) || [];
    const assetType = strategy.asset_type || 'crypto';
    const isStockStrategy = assetType === 'stock';

    this.logger.log(`getCustomStrategyTrendingWithInsights: strategy=${strategy.name}, targetAssets=${targetAssets.length}, type=${assetType}`);

    // Get trending assets based on strategy type
    let allAssets: any[];
    if (isStockStrategy) {
      allAssets = await this.preBuiltStrategiesService.getTopStocks(limitNum);
    } else {
      allAssets = await this.preBuiltStrategiesService.getTopTrendingAssets(limitNum, true);
    }

    // Filter to target assets if specified, otherwise use all
    let assets = targetAssets.length > 0
      ? allAssets.filter(a => targetAssets.includes(a.symbol))
      : allAssets;

    // If target assets don't match any trending, try to find them in the assets table
    if (assets.length === 0 && targetAssets.length > 0) {
      const dbAssets = await this.prisma.assets.findMany({
        where: { symbol: { in: targetAssets } },
      });
      
      // Enrich with trending data if available
      const trendingMap = new Map(allAssets.map(a => [a.symbol, a]));
      assets = dbAssets.map(a => ({
        ...a,
        ...(trendingMap.get(a.symbol) || {}),
      }));
    }

    if (assets.length === 0) {
      this.logger.warn(`No assets found for custom strategy ${strategyId}`);
      return { 
        strategy: {
          id: strategy.strategy_id,
          name: strategy.name,
          description: strategy.description,
        },
        assets: [], 
      };
    }

    // Get signals for these assets with this strategy
    const assetIds = assets.map(a => a.asset_id).filter(Boolean);
    const signals = await this.prisma.strategy_signals.findMany({
      where: {
        strategy_id: strategyId,
        asset_id: { in: assetIds },
      },
      include: {
        details: {
          orderBy: { created_at: 'desc' },
          take: 1,
        },
      },
      orderBy: {
        timestamp: 'desc',
      },
    });

    // Create signal map (one signal per asset)
    const signalMap = new Map();
    for (const signal of signals) {
      if (!signalMap.has(signal.asset_id)) {
        signalMap.set(signal.asset_id, {
          signal_id: signal.signal_id,
          action: signal.action,
          confidence: signal.confidence,
          final_score: signal.final_score,
          entry_price: signal.details[0]?.entry_price,
          stop_loss: signal.details[0]?.stop_loss,
          take_profit_1: signal.details[0]?.take_profit_1,
          stop_loss_pct: strategy.stop_loss_value,
          take_profit_pct: strategy.take_profit_value,
          sentiment_score: signal.sentiment_score,
          trend_score: signal.trend_score,
        });
      }
    }

    // Generate AI insights for top 2 assets (same as pre-built)
    const top2Assets = assets.slice(0, 2);
    const assetsWithInsights = await this.aiInsightsService.generateTrendingAssetsInsights(
      top2Assets,
      strategyId,
      strategy.name || 'Custom Strategy',
      signalMap,
      2,
    );

    // Return top 2 with insights + remaining without
    const remaining = assets.slice(2).map(asset => ({
      ...asset,
      hasAiInsight: false,
      signal: signalMap.get(asset.asset_id) || null,
    }));

    const finalAssets = [
      ...assetsWithInsights.map(a => ({
        ...a,
        signal: signalMap.get(a.asset_id) || null,
      })),
      ...remaining,
    ];
    
    this.logger.log(`Returning ${finalAssets.length} assets for custom strategy (${assetsWithInsights.length} with insights)`);
    
    return {
      strategy: {
        id: strategy.strategy_id,
        name: strategy.name,
        description: strategy.description,
      },
      assets: finalAssets,
    };
  }

  /**
   * Toggle strategy active status
   * Endpoint: POST /strategies/my-strategies/:id/toggle-active
   */
  @UseGuards(JwtAuthGuard)
  @Post('my-strategies/:id/toggle-active')
  @HttpCode(HttpStatus.OK)
  async toggleStrategyActive(
    @Param('id') strategyId: string,
    @CurrentUser() user: TokenPayload,
  ) {
    // Verify ownership
    const strategy = await this.prisma.strategies.findUnique({
      where: { strategy_id: strategyId },
    });

    if (!strategy) {
      throw new NotFoundException(`Strategy ${strategyId} not found`);
    }

    if (strategy.user_id !== user.sub) {
      throw new ForbiddenException('You do not own this strategy');
    }

    // Toggle active status
    const updated = await this.prisma.strategies.update({
      where: { strategy_id: strategyId },
      data: {
        is_active: !strategy.is_active,
        updated_at: new Date(),
      },
    });

    return {
      success: true,
      message: `Strategy ${updated.is_active ? 'activated' : 'deactivated'}`,
      is_active: updated.is_active,
    };
  }

  // Generic :id route must come AFTER specific routes (e.g. my-strategies)
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.strategiesService.findOne(id);
  }

  @Post()
  create(@Body() createStrategyDto: any) {
    return this.strategiesService.create(createStrategyDto);
  }

  @Post('custom')
  @HttpCode(HttpStatus.CREATED)
  createCustom(@Body() createStrategyDto: CreateStrategyDto) {
    return this.strategiesService.createCustomStrategy(createStrategyDto);
  }

  @Post('validate')
  @HttpCode(HttpStatus.OK)
  validate(@Body() validateStrategyDto: ValidateStrategyDto) {
    return this.strategiesService.validateStrategy(validateStrategyDto);
  }

  /**
   * Close unprotected positions (positions without bracket orders/OCO sell orders)
   * This is a safety endpoint to close positions that don't have proper exit logic
   * 
   * Endpoint: POST /strategies/close-unprotected-positions
   */
  @Post('close-unprotected-positions')
  @HttpCode(HttpStatus.OK)
  async closeUnprotectedPositions() {
    this.logger.log('Manual trigger: Close unprotected positions');
    
    try {
      // Import AlpacaPaperTradingService dynamically to avoid circular dependency
      const { AlpacaPaperTradingService } = await import('../alpaca-paper-trading/alpaca-paper-trading.service');
      const alpacaService = new AlpacaPaperTradingService(this.configService);
      
      // Get all positions
      const positions = await alpacaService.getPositions();
      
      if (!positions || positions.length === 0) {
        return {
          success: true,
          message: 'No open positions found',
          closed: [],
        };
      }
      
      // Get all orders with nested bracket legs
      const allOrders = await alpacaService.getOrders({ 
        status: 'all',
        nested: true
      });
      
      // Build set of symbols with active sell orders
      const symbolsWithSellOrders = new Set<string>();
      
      for (const order of allOrders) {
        // Check bracket legs
        if (order.order_class === 'bracket' && order.legs && order.legs.length > 0) {
          const hasActiveSellLegs = order.legs.some((leg: any) => 
            leg.side === 'sell' && ['new', 'held', 'accepted', 'pending_new'].includes(leg.status)
          );
          if (hasActiveSellLegs) {
            symbolsWithSellOrders.add(order.symbol);
          }
        }
        
        // Check standalone sell orders
        if (order.side === 'sell' && ['new', 'held', 'accepted', 'pending_new'].includes(order.status)) {
          symbolsWithSellOrders.add(order.symbol);
        }
      }
      
      // Find unprotected positions
      const unprotectedPositions = positions.filter((pos: any) => 
        !symbolsWithSellOrders.has(pos.symbol)
      );
      
      if (unprotectedPositions.length === 0) {
        return {
          success: true,
          message: 'All positions are protected with sell orders',
          total_positions: positions.length,
          protected: positions.length,
          unprotected: 0,
          closed: [],
        };
      }
      
      // Close unprotected positions
      const closedPositions = [];
      const failedPositions = [];
      
      for (const position of unprotectedPositions) {
        try {
          const closeOrder = await alpacaService.placeOrder({
            symbol: position.symbol,
            qty: parseFloat(position.qty),
            side: 'sell',
            type: 'market',
            time_in_force: 'day',
          });
          
          closedPositions.push({
            symbol: position.symbol,
            qty: position.qty,
            entry_price: position.avg_entry_price,
            close_price: position.current_price,
            pl: position.unrealized_pl,
            pl_percent: position.unrealized_plpc,
            order_id: closeOrder.id,
          });
          
          // Log to database
          await this.prisma.auto_trade_logs.create({
            data: {
              session_id: 'MANUAL_CLOSE_UNPROTECTED',
              event_type: 'POSITION_CLOSED',
              message: `Closed unprotected position: ${position.symbol}`,
              metadata: {
                symbol: position.symbol,
                qty: position.qty,
                entry_price: position.avg_entry_price,
                close_price: position.current_price,
                pl: position.unrealized_pl,
                pl_percent: position.unrealized_plpc,
                order_id: closeOrder.id,
                reason: 'No bracket orders or sell orders found',
              } as any,
            },
          });
          
          // Rate limit: 500ms between orders
          await new Promise(resolve => setTimeout(resolve, 500));
          
        } catch (error: any) {
          this.logger.error(`Failed to close ${position.symbol}: ${error.message}`);
          failedPositions.push({
            symbol: position.symbol,
            error: error.message,
          });
        }
      }
      
      return {
        success: true,
        message: `Closed ${closedPositions.length} unprotected position(s)`,
        total_positions: positions.length,
        protected: positions.length - unprotectedPositions.length,
        unprotected: unprotectedPositions.length,
        closed: closedPositions,
        failed: failedPositions,
      };
      
    } catch (error: any) {
      this.logger.error(`Failed to close unprotected positions: ${error.message}`);
      throw new BadRequestException(`Failed to close unprotected positions: ${error.message}`);
    }
  }

  @Get(':id/rules')
  getRules(@Param('id') id: string) {
    return this.strategiesService.findOne(id).then((strategy) => {
      if (!strategy) {
        return null;
      }
      return {
        entry_rules: strategy.entry_rules,
        exit_rules: strategy.exit_rules,
        indicators: strategy.indicators,
        timeframe: strategy.timeframe,
      };
    });
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() updateStrategyDto: any) {
    return this.strategiesService.update(id, updateStrategyDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.strategiesService.delete(id);
  }

  @Post(':id/parameters')
  createParameter(@Param('id') id: string, @Body() parameterDto: any) {
    return this.strategiesService.createParameter(id, parameterDto);
  }

  @Put('parameters/:parameterId')
  updateParameter(@Param('parameterId') parameterId: string, @Body() parameterDto: any) {
    return this.strategiesService.updateParameter(parameterId, parameterDto);
  }

  @Delete('parameters/:parameterId')
  removeParameter(@Param('parameterId') parameterId: string) {
    return this.strategiesService.deleteParameter(parameterId);
  }

  @Post('pre-built/:id/use')
  @HttpCode(HttpStatus.CREATED)
  usePreBuiltStrategy(
    @Param('id') id: string,
    @Body() body: { targetAssets?: string[]; config?: any; userId?: string },
  ) {
    // Use userId from body if provided, otherwise null (for testing)
    const userId = body.userId || null;
    return this.strategiesService.usePreBuiltStrategy(
      id,
      userId,
      body.targetAssets || [],
      body.config,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  activateStrategy(
    @Param('id') id: string,
    @CurrentUser() user: TokenPayload,
  ) {
    return this.strategiesService.activateStrategy(id, user.sub);
  }

  @Post(':id/generate-signals')
  @HttpCode(HttpStatus.OK)
  async generateSignals(
    @Param('id') id: string,
    @Body() body: { assetIds?: string[]; limit?: number },
  ) {
    // Verify strategy exists
    const strategy = await this.strategiesService.findOne(id);
    if (!strategy) {
      throw new NotFoundException(`Strategy ${id} not found`);
    }

    // Get asset IDs
    let assetIds: string[];
    if (body.assetIds && body.assetIds.length > 0) {
      assetIds = body.assetIds;
    } else {
      // Use trending assets if not provided
      const limit = body.limit || 10;
      const assets = await this.preBuiltStrategiesService.getTopTrendingAssets(limit);
      assetIds = assets.map((a) => a.asset_id);
    }

    // Generate signals with LLM explanations
    return this.strategyExecutionService.executeStrategyOnAssets(id, assetIds);
  }

  /**
   * Manual trigger for sentiment aggregation (for debugging)
   * This will immediately process all active assets through the sentiment engine
   */
  @Post('trigger-sentiment-aggregation')
  async triggerSentimentAggregation() {
    return this.newsCronjobService.triggerManualAggregation();
  }

  /**
   * Manual trigger for pre-built signals generation (for testing/debugging)
   * This will immediately generate signals for all pre-built strategies
   */
  @Post('trigger-pre-built-signals')
  @HttpCode(HttpStatus.OK)
  async triggerPreBuiltSignals(@Body() body?: { connectionId?: string }) {
    return this.preBuiltSignalsCronjobService.triggerManualGeneration(body || undefined);
  }

  /**
   * Manual trigger for stock signals generation (for testing/debugging)
   * This will immediately generate signals for all stock-specific strategies
   */
  @Post('trigger-stock-signals')
  @HttpCode(HttpStatus.OK)
  async triggerStockSignals(@Body() body?: { connectionId?: string }) {
    return this.stockSignalsCronjobService.triggerManualGeneration(body || undefined);
  }

  /**
   * Sync trending stocks from Finnhub into the database
   * This fetches the latest trending stocks and stores them for signal generation
   */
  @Post('sync-trending-stocks')
  @HttpCode(HttpStatus.OK)
  async syncTrendingStocks() {
    return this.stockTrendingService.syncTrendingStocksFromFinnhub();
  }

  /**
   * Seed popular stocks directly (fallback if Finnhub is slow/unavailable)
   * This adds AAPL, MSFT, GOOGL, TSLA, etc. to the database without API calls
   */
  @Post('seed-popular-stocks')
  @HttpCode(HttpStatus.OK)
  async seedPopularStocks() {
    return this.stockTrendingService.seedPopularStocks();
  }

  /**
   * Sync all stock market data from Alpaca API
   * This refreshes trending_assets with real-time OHLCV data
   */
  @Post('sync-alpaca-market-data')
  @HttpCode(HttpStatus.OK)
  async syncAlpacaMarketData() {
    return this.stockTrendingService.syncMarketDataFromAlpaca();
  }

  /**
   * Get stocks for Top Trades page
   * Data is served from database (synced by cronjob every 20 minutes)
   * Uses the same data source as the market page (market_rankings table)
   * 
   * @param limit Number of stocks to return (default: 500 to match market page)
   * @param realtime If 'true', force fetch live data from Alpaca (slower, use sparingly)
   * 
   * Endpoint: GET /strategies/stocks/top-trades
   */
  @Get('stocks/top-trades')
  async getStocksForTopTrades(
    @Query('limit') limit?: string,
    @Query('realtime') realtime?: string,
  ) {
    const limitNum = limit ? parseInt(limit, 10) : 500;
    const forceRealtime = realtime === 'true' || realtime === '1';
    return this.stockTrendingService.getStocksForTopTrades(limitNum, forceRealtime);
  }

  /**
   * Get real-time market data for a specific stock
   * Endpoint: GET /strategies/stocks/:symbol/market-data
   */
  @Get('stocks/:symbol/market-data')
  async getStockMarketData(@Param('symbol') symbol: string) {
    const data = await this.stockTrendingService.getStockMarketData(symbol);
    if (!data) {
      throw new NotFoundException(`Stock ${symbol} not found`);
    }
    return data;
  }

  /**
   * Test stock engines using news from database (no external API calls)
   * This endpoint is for testing/debugging the sentiment engine output
   * 
   * @param symbol Stock symbol (e.g., AAPL, TSLA, GOOGL)
   * @param limit Number of news items to use (default: 10)
   * @returns Engine scores and detailed output
   */
  @Get('test-stock-engines/:symbol')
  async testStockEngines(
    @Param('symbol') symbol: string,
    @Query('limit') limit?: string,
  ) {
    const newsLimit = limit ? parseInt(limit, 10) : 10;
    const symbolUpper = symbol.toUpperCase();
    
    this.logger.log(`Testing stock engines for ${symbolUpper} with ${newsLimit} news items from DB`);
    
    try {
      // 1. Fetch news from database (no API call)
      const newsData = await this.newsService.getRecentStockNewsFromDB(symbolUpper, newsLimit);
      
      if (!newsData.news_items || newsData.news_items.length === 0) {
        return {
          symbol: symbolUpper,
          error: 'No news found in database for this stock',
          suggestion: 'Run the news cronjob first or check if this stock exists in the database',
          metadata: newsData.metadata,
        };
      }
      
      // 2. Format news as text_data for Python sentiment engine
      const textData = newsData.news_items.map(item => ({
        text: item.title + (item.description ? ' ' + item.description : ''),
        source: 'database',
        news_type: 'formal',
        original_sentiment: item.sentiment, // Include pre-calculated sentiment for comparison
      }));
      
      this.logger.debug(`Formatted ${textData.length} news items for sentiment analysis`);
      
      // 3. Call Python /signals/generate with pre-fetched news and skip_external_apis flag
      const response = await axios.post(`${this.pythonApiUrl}/signals/generate`, {
        strategy_id: 'test_stock_engines',
        asset_id: symbolUpper,
        asset_type: 'stock',
        strategy_data: {
          entry_rules: [],
          exit_rules: [],
          timeframe: '1d',
          risk_level: 'medium',
        },
        market_data: {
          asset_type: 'stock',
          price: 100.0, // Placeholder
          volume_24h: 50000000, // Placeholder
        },
        text_data: textData, // Pre-fetched news from DB
        skip_external_apis: true, // Skip Finnhub/StockNewsAPI calls
      }, {
        timeout: 120000, // 2 minute timeout for FinBERT processing
      });
      
      // 4. Return detailed engine output
      return {
        symbol: symbolUpper,
        news_count: textData.length,
        news_source: 'database',
        news_freshness: newsData.metadata?.freshness || 'unknown',
        last_news_update: newsData.metadata?.last_updated_at,
        
        // Engine results
        final_score: response.data.final_score,
        action: response.data.action,
        confidence: response.data.confidence,
        
        // Individual engine scores
        engine_scores: {
          sentiment: response.data.engine_scores?.sentiment?.score || 0,
          trend: response.data.engine_scores?.trend?.score || 0,
          fundamental: response.data.engine_scores?.fundamental?.score || 0,
          liquidity: response.data.engine_scores?.liquidity?.score || 0,
          event_risk: response.data.engine_scores?.event_risk?.score || 0,
        },
        
        // Detailed sentiment analysis
        sentiment_details: response.data.metadata?.engine_details?.sentiment || {},
        
        // News items used
        news_items: newsData.news_items.map(item => ({
          title: item.title,
          source: item.source,
          published_at: item.published_at,
          db_sentiment: item.sentiment, // Pre-calculated sentiment from DB
        })),
        
        // Full response for debugging
        full_response: response.data,
      };
      
    } catch (error: any) {
      this.logger.error(`Error testing stock engines for ${symbolUpper}: ${error.message}`);
      
      if (axios.isAxiosError(error)) {
        return {
          symbol: symbolUpper,
          error: 'Failed to call Python API',
          details: error.response?.data || error.message,
          suggestion: 'Make sure Python API is running on ' + this.pythonApiUrl,
        };
      }
      
      throw new BadRequestException(`Failed to test stock engines: ${error.message}`);
    }
  }
}

