import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SignalAction, OrderType } from '@prisma/client';

@Injectable()
export class SignalsService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    return this.prisma.strategy_signals.findMany({
      include: {
        strategy: true,
        user: true,
        asset: true,
        details: true,
        explanations: true,
      },
    });
  }

  async findOne(id: string) {
    return this.prisma.strategy_signals.findUnique({
      where: { signal_id: id },
      include: {
        strategy: true,
        user: true,
        asset: true,
        details: true,
        explanations: true,
        orders: true,
      },
    });
  }

  async findByStrategy(strategyId: string) {
    return this.prisma.strategy_signals.findMany({
      where: { strategy_id: strategyId },
      include: {
        strategy: true,
        user: true,
        asset: true,
      },
    });
  }

  async findByUser(userId: string) {
    return this.prisma.strategy_signals.findMany({
      where: { user_id: userId },
      include: {
        strategy: true,
        asset: true,
      },
    });
  }

  async create(data: {
    strategy_id?: string;
    user_id?: string;
    asset_id?: string;
    timestamp?: Date;
    final_score?: number;
    action: SignalAction;
    confidence?: number;
    sentiment_score?: number;
    trend_score?: number;
    fundamental_score?: number;
    liquidity_score?: number;
    event_risk_score?: number;
    macro_score?: number;
    volatility_score?: number;
  }) {
    return this.prisma.strategy_signals.create({
      data: {
        strategy_id: data.strategy_id,
        user_id: data.user_id,
        asset_id: data.asset_id,
        timestamp: data.timestamp,
        final_score: data.final_score,
        action: data.action,
        confidence: data.confidence,
        sentiment_score: data.sentiment_score,
        trend_score: data.trend_score,
        fundamental_score: data.fundamental_score,
        liquidity_score: data.liquidity_score,
        event_risk_score: data.event_risk_score,
        macro_score: data.macro_score,
        volatility_score: data.volatility_score,
      },
      include: {
        strategy: true,
        user: true,
        asset: true,
      },
    });
  }

  async update(id: string, data: {
    final_score?: number;
    action?: SignalAction;
    confidence?: number;
    sentiment_score?: number;
    trend_score?: number;
    fundamental_score?: number;
    liquidity_score?: number;
    event_risk_score?: number;
    macro_score?: number;
    volatility_score?: number;
  }) {
    return this.prisma.strategy_signals.update({
      where: { signal_id: id },
      data,
    });
  }

  async delete(id: string) {
    return this.prisma.strategy_signals.delete({
      where: { signal_id: id },
    });
  }

  async createDetail(signalId: string, data: {
    entry_price?: number;
    position_size?: number;
    position_value?: number;
    stop_loss?: number;
    take_profit_1?: number;
    take_profit_2?: number;
    leverage?: number;
    order_type?: OrderType;
    time_in_force?: string;
    metadata?: any;
  }) {
    return this.prisma.signal_details.create({
      data: {
        signal_id: signalId,
        entry_price: data.entry_price,
        position_size: data.position_size,
        position_value: data.position_value,
        stop_loss: data.stop_loss,
        take_profit_1: data.take_profit_1,
        take_profit_2: data.take_profit_2,
        leverage: data.leverage,
        order_type: data.order_type,
        time_in_force: data.time_in_force,
        metadata: data.metadata,
      },
    });
  }

  async createExplanation(signalId: string, data: {
    llm_model?: string;
    text?: string;
  }) {
    return this.prisma.signal_explanations.create({
      data: {
        signal_id: signalId,
        ...data,
      },
    });
  }
}

