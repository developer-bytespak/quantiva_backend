import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class PortfolioService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    return this.prisma.portfolios.findMany({
      include: {
        user: true,
        positions: {
          include: { asset: true },
        },
      },
    });
  }

  async findOne(id: string) {
    return this.prisma.portfolios.findUnique({
      where: { portfolio_id: id },
      include: {
        user: true,
        positions: {
          include: { asset: true },
        },
        snapshots: true,
      },
    });
  }

  async findByUser(userId: string) {
    return this.prisma.portfolios.findMany({
      where: { user_id: userId },
      include: {
        positions: {
          include: { asset: true },
        },
      },
    });
  }

  async create(data: {
    user_id: string;
    name?: string;
    type?: string;
  }) {
    return this.prisma.portfolios.create({
      data,
      include: {
        user: true,
        positions: true,
      },
    });
  }

  async update(id: string, data: {
    name?: string;
    type?: string;
  }) {
    return this.prisma.portfolios.update({
      where: { portfolio_id: id },
      data,
    });
  }

  async delete(id: string) {
    return this.prisma.portfolios.delete({
      where: { portfolio_id: id },
    });
  }

  async createPosition(portfolioId: string, data: {
    asset_id: string;
    quantity?: number;
    avg_entry_price?: number;
    current_price?: number;
    unrealized_pnl?: number;
    realized_pnl?: number;
    leverage?: number;
    side?: string;
  }) {
    return this.prisma.portfolio_positions.create({
      data: {
        portfolio_id: portfolioId,
        ...data,
      },
      include: { asset: true },
    });
  }

  async updatePosition(positionId: string, data: {
    quantity?: number;
    avg_entry_price?: number;
    current_price?: number;
    unrealized_pnl?: number;
    realized_pnl?: number;
    leverage?: number;
    side?: string;
  }) {
    return this.prisma.portfolio_positions.update({
      where: { position_id: positionId },
      data,
    });
  }

  async deletePosition(positionId: string) {
    return this.prisma.portfolio_positions.delete({
      where: { position_id: positionId },
    });
  }

  async createSnapshot(portfolioId: string, data: {
    total_value?: number;
    cash_value?: number;
    positions_value?: number;
    pnl_24h?: number;
    metadata?: any;
  }) {
    return this.prisma.portfolio_snapshots.create({
      data: {
        portfolio_id: portfolioId,
        timestamp: new Date(),
        ...data,
      },
    });
  }
}

