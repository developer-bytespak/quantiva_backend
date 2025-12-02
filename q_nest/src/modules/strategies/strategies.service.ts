import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { StrategyType, RiskLevel } from '@prisma/client';
import { CreateStrategyDto } from './dto/create-strategy.dto';
import { StrategyValidationService } from './services/strategy-validation.service';

@Injectable()
export class StrategiesService {
  private strategyScheduler: any; // Will be injected if available

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
        signals: true,
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
          include: { asset: true },
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
    // Validate strategy
    const validation = await this.validationService.validateStrategy(dto);
    if (!validation.valid) {
      throw new Error(`Strategy validation failed: ${validation.errors.join(', ')}`);
    }

    // Parse rules
    const parsedRules = this.validationService.parseStrategyRules(dto);

    // Create strategy with all fields
    const strategy = await this.prisma.strategies.create({
      data: {
        user_id: dto.user_id,
        name: dto.name,
        type: dto.type,
        description: dto.description,
        risk_level: dto.risk_level,
        timeframe: dto.timeframe,
        entry_rules: parsedRules.entry_rules as any,
        exit_rules: parsedRules.exit_rules as any,
        indicators: parsedRules.indicators as any,
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

  async validateStrategy(dto: CreateStrategyDto) {
    return this.validationService.validateStrategy(dto);
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
}

