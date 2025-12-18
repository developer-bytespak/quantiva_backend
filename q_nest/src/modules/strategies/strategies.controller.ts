import { Controller, Get, Post, Put, Delete, Body, Param, Query, HttpCode, HttpStatus, UseGuards, NotFoundException, ForbiddenException } from '@nestjs/common';
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
  getTrendingAssets(@Query('limit') limit?: string) {
    const limitNum = limit ? parseInt(limit, 10) : 50;
    return this.preBuiltStrategiesService.getTopTrendingAssets(limitNum);
  }

  @Get('pre-built/:id/signals')
  async getPreBuiltStrategySignals(
    @Param('id') id: string,
    @Query('latest_only') latestOnly?: string,
  ) {
    // Verify strategy exists and is a pre-built strategy
    const strategy = await this.strategiesService.findOne(id);
    if (!strategy) {
      throw new NotFoundException(`Strategy ${id} not found`);
    }
    if (strategy.type !== 'admin') {
      throw new NotFoundException(`Strategy ${id} is not a pre-built strategy`);
    }

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

