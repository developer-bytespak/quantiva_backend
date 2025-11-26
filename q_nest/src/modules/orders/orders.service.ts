import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SignalAction, OrderType, OrderStatus } from '@prisma/client';

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
    side?: SignalAction;
    order_type?: OrderType;
    quantity?: number;
    price?: number;
    status?: OrderStatus;
    auto_trade_approved?: boolean;
  }) {
    return this.prisma.orders.create({
      data: {
        portfolio_id: data.portfolio_id,
        signal_id: data.signal_id,
        side: data.side,
        order_type: data.order_type,
        quantity: data.quantity,
        price: data.price,
        status: data.status,
        auto_trade_approved: data.auto_trade_approved,
      },
      include: {
        portfolio: true,
        signal: true,
      },
    });
  }

  async update(id: string, data: {
    side?: SignalAction;
    order_type?: OrderType;
    quantity?: number;
    price?: number;
    status?: OrderStatus;
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

