import { Controller, Get, Post, Put, Delete, Body, Param, Query, HttpCode, HttpStatus, UseGuards, NotFoundException, ForbiddenException } from '@nestjs/common';
import { StrategiesService } from './strategies.service';
import { CreateStrategyDto, ValidateStrategyDto } from './dto/create-strategy.dto';
import { PreBuiltStrategiesService } from './services/pre-built-strategies.service';
import { StrategyPreviewService } from './services/strategy-preview.service';
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
    private readonly prisma: PrismaService, // Add this
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

  @Get('pre-built/:id/preview')
  async previewStrategy(
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    const limitNum = limit ? parseInt(limit, 10) : 50;
    const assets = await this.preBuiltStrategiesService.getTopTrendingAssets(limitNum);
    const assetIds = assets.map((a) => a.asset_id);
    return this.strategyPreviewService.previewStrategy(id, assetIds);
  }

  // Move this route BEFORE the generic :id route
  @UseGuards(JwtAuthGuard)
  @Get(':id/signals')
  async getStrategySignals(
    @Param('id') id: string,
    @CurrentUser() user: TokenPayload,
  ) {
    // Verify strategy belongs to user
    const strategy = await this.strategiesService.findOne(id);
    if (!strategy) {
      throw new NotFoundException(`Strategy ${id} not found`);
    }
    if (strategy.user_id !== user.sub) {
      throw new ForbiddenException(`Strategy ${id} does not belong to user`);
    }

    // Get signals with explanations
    return this.prisma.strategy_signals.findMany({
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

  @UseGuards(JwtAuthGuard)
  @Post('pre-built/:id/use')
  @HttpCode(HttpStatus.CREATED)
  usePreBuiltStrategy(
    @Param('id') id: string,
    @CurrentUser() user: TokenPayload,
    @Body() body: { targetAssets: string[]; config?: any },
  ) {
    return this.strategiesService.usePreBuiltStrategy(
      id,
      user.sub, // Extract user ID from JWT token
      body.targetAssets,
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
}

