import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class OrdersService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    return this.prisma.orders.findMany({
      include: {
        portfolio: true,
        signal: true,
        executions: true,
      },
    });
  }

  async findOne(id: string) {
    return this.prisma.orders.findUnique({
      where: { order_id: id },
      include: {
        portfolio: true,
        signal: true,
        executions: true,
      },
    });
  }

  async findByPortfolio(portfolioId: string) {
    return this.prisma.orders.findMany({
      where: { portfolio_id: portfolioId },
      include: {
        portfolio: true,
        signal: true,
        executions: true,
      },
    });
  }

  async create(data: {
    portfolio_id: string;
    signal_id?: string;
    side?: string;
    order_type?: string;
    quantity?: number;
    price?: number;
    status?: string;
    auto_trade_approved?: boolean;
  }) {
    return this.prisma.orders.create({
      data,
      include: {
        portfolio: true,
        signal: true,
      },
    });
  }

  async update(id: string, data: {
    side?: string;
    order_type?: string;
    quantity?: number;
    price?: number;
    status?: string;
    auto_trade_approved?: boolean;
  }) {
    return this.prisma.orders.update({
      where: { order_id: id },
      data,
    });
  }

  async delete(id: string) {
    return this.prisma.orders.delete({
      where: { order_id: id },
    });
  }

  async createExecution(orderId: string, data: {
    trade_id?: string;
    price?: number;
    quantity?: number;
    fee?: number;
    timestamp?: Date;
  }) {
    return this.prisma.order_executions.create({
      data: {
        order_id: orderId,
        ...data,
      },
    });
  }
}

