import { Injectable, Inject, forwardRef, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { StrategyType, RiskLevel } from '@prisma/client';
import { CreateStrategyDto } from './dto/create-strategy.dto';
import { StrategyValidationService } from './services/strategy-validation.service';

@Injectable()
export class StrategiesService {
  private strategyScheduler: any; // Will be injected if available
  private readonly logger = new Logger(StrategiesService.name);

  constructor(
    private prisma: PrismaService,
    private validationService: StrategyValidationService,
  ) {}

  setStrategyScheduler(scheduler: any) {
    this.strategyScheduler = scheduler;
  }

  async findAll() {
    return this.prisma.strategies.findMany({
      include: {
        user: true,
        parameters: true,
        signals: {
          select: {
            signal_id: true,
            strategy_id: true,
            asset_id: true,
            timestamp: true,
            action: true,
            final_score: true,
          },
          orderBy: { timestamp: 'desc' },
          take: 10, // Limit to latest 10 signals per strategy
        },
      },
    });
  }

  async findOne(id: string) {
    return this.prisma.strategies.findUnique({
      where: { strategy_id: id },
      include: {
        user: true,
        parameters: true,
        signals: {
          select: {
            signal_id: true,
            strategy_id: true,
            user_id: true,
            asset_id: true,
            timestamp: true,
            final_score: true,
            action: true,
            confidence: true,
            sentiment_score: true,
            trend_score: true,
            fundamental_score: true,
            liquidity_score: true,
            event_risk_score: true,
            macro_score: true,
            volatility_score: true,
            engine_metadata: true,
          },
          orderBy: { timestamp: 'desc' },
          take: 50, // Limit to latest 50 signals
        },
      },
    });
  }

  async findByUser(userId: string) {
    return this.prisma.strategies.findMany({
      where: { user_id: userId },
      include: {
        parameters: true,
        signals: true,
      },
    });
  }

  async findByType(type: string) {
    return this.prisma.strategies.findMany({
      where: { type: type as any },
      include: {
        user: true,
        parameters: true,
      },
    });
  }

  async create(data: {
    user_id?: string;
    name?: string;
    type: StrategyType;
    description?: string;
    risk_level: RiskLevel;
    auto_trade_threshold?: number;
    is_active?: boolean;
  }) {
    return this.prisma.strategies.create({
      data: {
        user_id: data.user_id,
        name: data.name,
        type: data.type,
        description: data.description,
        risk_level: data.risk_level,
        auto_trade_threshold: data.auto_trade_threshold,
        is_active: data.is_active,
      },
      include: {
        user: true,
        parameters: true,
      },
    });
  }

  async createCustomStrategy(dto: CreateStrategyDto) {
    // Validate strategy (skip validation if using field-based rules)
    const hasFieldBasedRules = dto.entry_rules?.some(r => r.field) || dto.exit_rules?.some(r => r.field);
    
    if (!hasFieldBasedRules) {
      const validation = await this.validationService.validateStrategy(dto);
      if (!validation.valid) {
        throw new BadRequestException({ message: 'Strategy validation failed', errors: validation.errors });
      }
    }

    // Parse rules
    const parsedRules = this.validationService.parseStrategyRules(dto);

    // Create strategy with all fields including engine_weights
    const strategy = await this.prisma.strategies.create({
      data: {
        user_id: dto.user_id,
        name: dto.name,
        type: dto.type,
        asset_type: dto.asset_type || 'crypto', // Default to crypto if not specified
        description: dto.description,
        risk_level: dto.risk_level,
        timeframe: dto.timeframe,
        entry_rules: parsedRules.entry_rules as any,
        exit_rules: parsedRules.exit_rules as any,
        indicators: parsedRules.indicators as any,
        engine_weights: dto.engine_weights as any, // Add engine weights for score-based strategies
        stop_loss_type: dto.stop_loss_type,
        stop_loss_value: dto.stop_loss_value,
        take_profit_type: dto.take_profit_type,
        take_profit_value: dto.take_profit_value,
        schedule_cron: dto.schedule_cron,
        target_assets: dto.target_assets as any,
        auto_trade_threshold: dto.auto_trade_threshold,
        is_active: dto.is_active ?? true,
      },
      include: {
        user: true,
        parameters: true,
      },
    });

    // Schedule strategy if active and has cron expression
    if (strategy.is_active && strategy.schedule_cron && this.strategyScheduler) {
      try {
        await this.strategyScheduler.scheduleStrategy(strategy.strategy_id);
      } catch (error) {
        // Log error but don't fail strategy creation
        console.error(`Failed to schedule strategy ${strategy.strategy_id}:`, error);
      }
    }

    return strategy;
  }

  async validateStrategy(dto: CreateStrategyDto | import('./dto/create-strategy.dto').ValidateStrategyDto) {
    return this.validationService.validateStrategy(dto as any);
  }

  async parseStrategyRules(dto: CreateStrategyDto) {
    return this.validationService.parseStrategyRules(dto);
  }

  async update(id: string, data: {
    name?: string;
    description?: string;
    risk_level?: RiskLevel;
    auto_trade_threshold?: number;
    is_active?: boolean;
    schedule_cron?: string;
  }) {
    const strategy = await this.prisma.strategies.update({
      where: { strategy_id: id },
      data,
    });

    // Reschedule if active status or cron changed
    if (this.strategyScheduler && (data.is_active !== undefined || data.schedule_cron !== undefined)) {
      try {
        // Unschedule first
        await this.strategyScheduler.unscheduleStrategy(id);
        
        // Reschedule if active
        if (strategy.is_active && strategy.schedule_cron) {
          await this.strategyScheduler.scheduleStrategy(id);
        }
      } catch (error) {
        console.error(`Failed to reschedule strategy ${id}:`, error);
      }
    }

    return strategy;
  }

  async delete(id: string) {
    return this.prisma.strategies.delete({
      where: { strategy_id: id },
    });
  }

  async createParameter(strategyId: string, data: {
    name?: string;
    value?: string;
  }) {
    return this.prisma.strategy_parameters.create({
      data: {
        strategy_id: strategyId,
        ...data,
      },
    });
  }

  async updateParameter(parameterId: string, data: {
    name?: string;
    value?: string;
  }) {
    return this.prisma.strategy_parameters.update({
      where: { parameter_id: parameterId },
      data,
    });
  }

  async deleteParameter(parameterId: string) {
    return this.prisma.strategy_parameters.delete({
      where: { parameter_id: parameterId },
    });
  }

  /**
   * Use a pre-built strategy (create user strategy from template)
   */
  async usePreBuiltStrategy(
    templateId: string,
    userId: string | null,
    targetAssets: string[],
    config?: {
      name?: string;
      schedule_cron?: string;
      auto_trade_threshold?: number;
    },
  ) {
    // Get template strategy
    const template = await this.prisma.strategies.findUnique({
      where: {
        strategy_id: templateId,
      },
    });

    if (!template) {
      throw new Error(`Template strategy ${templateId} not found`);
    }

    if (template.type !== 'admin') {
      throw new Error(`Strategy ${templateId} is not a pre-built template`);
    }

    // Create user strategy from template
    const strategy = await this.prisma.strategies.create({
      data: {
        user_id: userId,
        name: config?.name || `${template.name} (Custom)`,
        type: 'user',
        asset_type: template.asset_type || 'crypto', // Inherit asset_type from template
        description: template.description,
        risk_level: template.risk_level,
        timeframe: template.timeframe,
        entry_rules: template.entry_rules ? JSON.parse(JSON.stringify(template.entry_rules)) : null,
        exit_rules: template.exit_rules ? JSON.parse(JSON.stringify(template.exit_rules)) : null,
        indicators: template.indicators ? JSON.parse(JSON.stringify(template.indicators)) : null,
        stop_loss_type: 'percentage',
        stop_loss_value: template.stop_loss_value,
        take_profit_type: 'percentage',
        take_profit_value: template.take_profit_value,
        schedule_cron: config?.schedule_cron || template.schedule_cron,
        target_assets: targetAssets as any,
        engine_weights: template.engine_weights ? JSON.parse(JSON.stringify(template.engine_weights)) : null,
        template_id: templateId,
        auto_trade_threshold: config?.auto_trade_threshold || template.auto_trade_threshold,
        is_active: false, // User must activate manually
      },
      include: {
        user: true,
        parameters: true,
      },
    });

    return strategy;
  }

  /**
   * Get all pre-built strategies
   * @param assetType Optional filter by asset type ('crypto' | 'stock')
   */
  async getPreBuiltStrategies(assetType?: 'crypto' | 'stock') {
    const whereClause: any = {
      type: 'admin',
      is_active: true,
    };

    if (assetType) {
      whereClause.asset_type = assetType;
    }

    return this.prisma.strategies.findMany({
      where: whereClause,
      orderBy: {
        created_at: 'asc',
      },
    });
  }

  /**
   * Activate a strategy
   */
  async activateStrategy(strategyId: string, userId: string) {
    // Verify strategy belongs to user
    const strategy = await this.prisma.strategies.findUnique({
      where: {
        strategy_id: strategyId,
      },
    });

    if (!strategy) {
      throw new Error(`Strategy ${strategyId} not found`);
    }

    if (strategy.user_id !== userId) {
      throw new Error(`Strategy ${strategyId} does not belong to user ${userId}`);
    }

    // Validate strategy
    if (!strategy.target_assets || (strategy.target_assets as any[]).length === 0) {
      throw new Error('Strategy must have at least one target asset');
    }

    // Activate strategy
    const updated = await this.prisma.strategies.update({
      where: {
        strategy_id: strategyId,
      },
      data: {
        is_active: true,
      },
    });

    // Schedule strategy if has cron expression
    if (updated.schedule_cron && this.strategyScheduler) {
      try {
        await this.strategyScheduler.scheduleStrategy(strategyId);
      } catch (error) {
        this.logger.error(`Failed to schedule strategy ${strategyId}:`, error);
      }
    }

    return updated;
  }
}

