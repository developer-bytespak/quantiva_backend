import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AssetsService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    return this.prisma.assets.findMany({
      where: { is_active: true },
    });
  }

  async findOne(id: string) {
    return this.prisma.assets.findUnique({
      where: { asset_id: id },
    });
  }

  async findBySymbol(symbol: string) {
    return this.prisma.assets.findFirst({
      where: { symbol },
    });
  }

  async create(data: {
    symbol?: string;
    name?: string;
    asset_type?: string;
    sector?: string;
    is_active?: boolean;
  }) {
    return this.prisma.assets.create({
      data: {
        ...data,
        is_active: data.is_active ?? true,
        first_seen_at: new Date(),
        last_seen_at: new Date(),
      },
    });
  }

  async update(id: string, data: {
    symbol?: string;
    name?: string;
    asset_type?: string;
    sector?: string;
    is_active?: boolean;
  }) {
    return this.prisma.assets.update({
      where: { asset_id: id },
      data: {
        ...data,
        last_seen_at: new Date(),
      },
    });
  }

  async delete(id: string) {
    return this.prisma.assets.update({
      where: { asset_id: id },
      data: { is_active: false },
    });
  }

  async getMarketData(assetId: string, startDate?: Date, endDate?: Date) {
    return this.prisma.asset_market_data.findMany({
      where: {
        asset_id: assetId,
        ...(startDate && endDate && {
          timestamp: {
            gte: startDate,
            lte: endDate,
          },
        }),
      },
      orderBy: { timestamp: 'asc' },
    });
  }

  async getTrendingAssets() {
    return this.prisma.trending_assets.findMany({
      take: 20,
      orderBy: { poll_timestamp: 'desc' },
      include: { asset: true },
    });
  }
}

