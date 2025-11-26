import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class StrategiesService {
  constructor(private prisma: PrismaService) {}

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
    type: string;
    description?: string;
    risk_level: string;
    auto_trade_threshold?: number;
    is_active?: boolean;
  }) {
    return this.prisma.strategies.create({
      data,
      include: {
        user: true,
        parameters: true,
      },
    });
  }

  async update(id: string, data: {
    name?: string;
    description?: string;
    risk_level?: string;
    auto_trade_threshold?: number;
    is_active?: boolean;
  }) {
    return this.prisma.strategies.update({
      where: { strategy_id: id },
      data,
    });
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

