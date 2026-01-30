import { Controller, Get, Post, Put, Delete, Body, Param, Query, HttpCode, HttpStatus, UseGuards, NotFoundException, ForbiddenException, BadRequestException, Logger } from '@nestjs/common';
import { StrategiesService } from './strategies.service';
import { CreateStrategyDto, ValidateStrategyDto } from './dto/create-strategy.dto';
import { PreBuiltStrategiesService } from './services/pre-built-strategies.service';
import { StockTrendingService } from './services/stock-trending.service';
import { StrategyPreviewService } from './services/strategy-preview.service';
import { StrategyExecutionService } from './services/strategy-execution.service';
import { PreBuiltSignalsCronjobService } from './services/pre-built-signals-cronjob.service';
import { StockSignalsCronjobService } from './services/stock-signals-cronjob.service';
import { NewsCronjobService } from '../news/news-cronjob.service';
import { NewsService } from '../news/news.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { TokenPayload } from '../auth/services/token.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AiInsightsService } from '../../ai-insights/ai-insights.service';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

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
    private readonly newsCronjobService: NewsCronjobService,
    private readonly newsService: NewsService,
    private readonly prisma: PrismaService,
    private readonly aiInsightsService: AiInsightsService,
    private readonly configService: ConfigService,
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
  @Get('pre-built')
  getPreBuiltStrategies() {
    return this.preBuiltStrategiesService.getPreBuiltStrategies();
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

  // Generic :id route should come AFTER specific routes
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

