import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

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
    action: string;
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
      data,
      include: {
        strategy: true,
        user: true,
        asset: true,
      },
    });
  }

  async update(id: string, data: {
    final_score?: number;
    action?: string;
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
    order_type?: string;
    time_in_force?: string;
    metadata?: any;
  }) {
    return this.prisma.signal_details.create({
      data: {
        signal_id: signalId,
        ...data,
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

