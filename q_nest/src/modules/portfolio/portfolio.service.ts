import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PortfolioType, PositionSide } from '@prisma/client';
import { parsePagination, paginate, PaginatedResponse } from '../../common/utils/pagination';

@Injectable()
export class PortfolioService {
  constructor(private prisma: PrismaService) {}

  async findAll(page?: number, limit?: number): Promise<PaginatedResponse<any>> {
    const { take, skip, page: p, limit: l } = parsePagination(page, limit);
    const where = {};
    const [data, total] = await this.prisma.$transaction([
      this.prisma.portfolios.findMany({
        where,
        take,
        skip,
        orderBy: { created_at: 'desc' },
        include: {
          positions: {
            include: { asset: { select: { asset_id: true, symbol: true, name: true, logo_url: true } } },
          },
        },
      }),
      this.prisma.portfolios.count({ where }),
    ]);
    return paginate(data, total, p, l);
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

  async findByUser(userId: string, page?: number, limit?: number): Promise<PaginatedResponse<any>> {
    const { take, skip, page: p, limit: l } = parsePagination(page, limit);
    const where = { user_id: userId };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.portfolios.findMany({
        where,
        take,
        skip,
        orderBy: { created_at: 'desc' },
        include: {
          positions: {
            include: { asset: { select: { asset_id: true, symbol: true, name: true, logo_url: true } } },
          },
        },
      }),
      this.prisma.portfolios.count({ where }),
    ]);
    return paginate(data, total, p, l);
  }

  async create(data: {
    user_id: string;
    name?: string;
    type?: PortfolioType;
  }) {
    return this.prisma.portfolios.create({
      data: {
        user_id: data.user_id,
        name: data.name,
        type: data.type,
      },
      include: {
        user: true,
        positions: true,
      },
    });
  }

  async update(id: string, data: {
    name?: string;
    type?: PortfolioType;
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
    side?: PositionSide;
  }) {
    return this.prisma.portfolio_positions.create({
      data: {
        portfolio_id: portfolioId,
        asset_id: data.asset_id,
        quantity: data.quantity,
        avg_entry_price: data.avg_entry_price,
        current_price: data.current_price,
        unrealized_pnl: data.unrealized_pnl,
        realized_pnl: data.realized_pnl,
        leverage: data.leverage,
        side: data.side,
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
    side?: PositionSide;
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

