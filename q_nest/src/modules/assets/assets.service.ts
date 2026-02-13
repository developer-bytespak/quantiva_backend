import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AssetsService {
  constructor(private prisma: PrismaService) {}

  async findAll(assetType?: string, limit?: number, search?: string) {
    const whereClause: any = {
      is_active: true,
    };

    // Filter by asset type if provided
    if (assetType) {
      whereClause.asset_type = assetType;
    }

    // Add search conditions if provided
    if (search) {
      whereClause.OR = [
        { symbol: { contains: search, mode: 'insensitive' } },
        { name: { contains: search, mode: 'insensitive' } },
      ];
    }

    return this.prisma.assets.findMany({
      where: whereClause,
      take: limit,
      orderBy: { symbol: 'asc' },
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
        symbol: data.symbol,
        name: data.name,
        asset_type: data.asset_type,
        sector: data.sector,
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

