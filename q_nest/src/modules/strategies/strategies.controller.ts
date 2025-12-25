import { Controller, Get, Post, Put, Delete, Body, Param, Query, HttpCode, HttpStatus, UseGuards, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { StrategiesService } from './strategies.service';
import { CreateStrategyDto, ValidateStrategyDto } from './dto/create-strategy.dto';
import { PreBuiltStrategiesService } from './services/pre-built-strategies.service';
import { StrategyPreviewService } from './services/strategy-preview.service';
import { StrategyExecutionService } from './services/strategy-execution.service';
import { PreBuiltSignalsCronjobService } from './services/pre-built-signals-cronjob.service';
import { NewsCronjobService } from '../news/news-cronjob.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { TokenPayload } from '../auth/services/token.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AiInsightsService } from '../../ai-insights/ai-insights.service';

@Controller('strategies')
export class StrategiesController {
  constructor(
    private readonly strategiesService: StrategiesService,
    private readonly preBuiltStrategiesService: PreBuiltStrategiesService,
    private readonly strategyPreviewService: StrategyPreviewService,
    private readonly strategyExecutionService: StrategyExecutionService,
    private readonly preBuiltSignalsCronjobService: PreBuiltSignalsCronjobService,
    private readonly newsCronjobService: NewsCronjobService,
    private readonly prisma: PrismaService,
    private readonly aiInsightsService: AiInsightsService,
  ) {}

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

    const limitNum = limit ? parseInt(limit, 10) : 10;
    
    // Get trending assets
    const assets = await this.preBuiltStrategiesService.getTopTrendingAssets(limitNum, true);
    
    if (assets.length === 0) {
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

    return {
      strategy: {
        id: strategy.strategy_id,
        name: strategy.name,
        description: strategy.description,
      },
      assets: [
        ...assetsWithInsights.map(a => ({
          ...a,
          signal: signalMap.get(a.asset_id) || null,
        })),
        ...remaining,
      ],
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
                return {
                  ...signal,
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
                return { ...signal, realtime_data: null };
              }
            }
            return signal;
          })
        );
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
    @CurrentUser() user?: TokenPayload, // Optional: use if authenticated
  ) {
    const limitNum = limit ? parseInt(limit, 10) : 50;
    const assets = await this.preBuiltStrategiesService.getTopTrendingAssets(limitNum);
    const assetIds = assets.map((a) => a.asset_id);
    return this.strategyPreviewService.previewStrategy(id, assetIds, user?.sub);
  }

  // Preview route for user-created strategies: GET /strategies/:id/preview
  @Get(':id/preview')
  async previewUserStrategy(
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @CurrentUser() user?: TokenPayload, // Optional: use if authenticated
  ) {
    const limitNum = limit ? parseInt(limit, 10) : 50;
    const assets = await this.preBuiltStrategiesService.getTopTrendingAssets(limitNum);
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
}

