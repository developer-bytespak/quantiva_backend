import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { MarketStock } from '../types/market.types';

@Injectable()
export class MarketStocksDbService {
  private readonly logger = new Logger(MarketStocksDbService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Upsert multiple stocks into assets and market_rankings tables
   */
  async upsertBatch(stocks: MarketStock[]): Promise<void> {
    try {
      const now = new Date();

      await this.prisma.$transaction(async (tx) => {
        for (const stock of stocks) {
          // Upsert into assets table
          const asset = await tx.assets.upsert({
            where: {
              symbol_asset_type: {
                symbol: stock.symbol,
                asset_type: 'stock',
              },
            },
            update: {
              name: stock.name,
              sector: stock.sector,
              is_active: true,
              last_seen_at: now,
              display_name: stock.name,
              market_cap_rank: stock.rank,
            },
            create: {
              symbol: stock.symbol,
              name: stock.name,
              asset_type: 'stock',
              sector: stock.sector,
              is_active: true,
              first_seen_at: now,
              last_seen_at: now,
              display_name: stock.name,
              market_cap_rank: stock.rank,
            },
          });

          // Upsert into market_rankings table
          await tx.market_rankings.upsert({
            where: {
              rank_timestamp_asset_id: {
                rank_timestamp: now,
                asset_id: asset.asset_id,
              },
            },
            update: {
              rank: stock.rank,
              market_cap: stock.marketCap,
              price_usd: stock.price,
              volume_24h: stock.volume24h,
            },
            create: {
              rank_timestamp: now,
              asset_id: asset.asset_id,
              rank: stock.rank,
              market_cap: stock.marketCap,
              price_usd: stock.price,
              volume_24h: stock.volume24h,
            },
          });
        }
      });

      this.logger.log(`Successfully upserted ${stocks.length} stocks`);
    } catch (error: any) {
      this.logger.error('Failed to upsert stocks batch', {
        error: error?.message,
        stocksCount: stocks.length,
      });
      throw error;
    }
  }

  /**
   * Get all stocks from assets and market_rankings
   */
  async getAll(limit?: number): Promise<MarketStock[]> {
    try {
      const assets = await this.prisma.assets.findMany({
        where: {
          asset_type: 'stock',
          is_active: true,
        },
        include: {
          market_rankings: {
            orderBy: { rank_timestamp: 'desc' },
            take: 1,
          },
        },
        orderBy: { market_cap_rank: 'asc' },
        take: limit,
      });

      return assets
        .filter((asset) => asset.market_rankings.length > 0)
        .map((asset) => this.mapToMarketStock(asset, asset.market_rankings[0]));
    } catch (error: any) {
      this.logger.error('Failed to get all stocks', { error: error?.message });
      throw error;
    }
  }

  /**
   * Get stocks by symbols
   */
  async getBySymbols(symbols: string[]): Promise<MarketStock[]> {
    try {
      const assets = await this.prisma.assets.findMany({
        where: {
          symbol: { in: symbols },
          asset_type: 'stock',
          is_active: true,
        },
        include: {
          market_rankings: {
            orderBy: { rank_timestamp: 'desc' },
            take: 1,
          },
        },
      });

      return assets
        .filter((asset) => asset.market_rankings.length > 0)
        .map((asset) => this.mapToMarketStock(asset, asset.market_rankings[0]));
    } catch (error: any) {
      this.logger.error('Failed to get stocks by symbols', {
        error: error?.message,
        symbols,
      });
      throw error;
    }
  }

  /**
   * Search stocks by symbol, name, or sector
   */
  async search(query: string, limit?: number): Promise<MarketStock[]> {
    try {
      const assets = await this.prisma.assets.findMany({
        where: {
          asset_type: 'stock',
          is_active: true,
          OR: [
            { symbol: { contains: query, mode: 'insensitive' } },
            { name: { contains: query, mode: 'insensitive' } },
            { sector: { contains: query, mode: 'insensitive' } },
          ],
        },
        include: {
          market_rankings: {
            orderBy: { rank_timestamp: 'desc' },
            take: 1,
          },
        },
        orderBy: { market_cap_rank: 'asc' },
        take: limit,
      });

      return assets
        .filter((asset) => asset.market_rankings.length > 0)
        .map((asset) => this.mapToMarketStock(asset, asset.market_rankings[0]));
    } catch (error: any) {
      this.logger.error('Failed to search stocks', {
        error: error?.message,
        query,
      });
      throw error;
    }
  }

  /**
   * Get stocks by sector
   */
  async getBySector(sector: string, limit?: number): Promise<MarketStock[]> {
    try {
      const assets = await this.prisma.assets.findMany({
        where: {
          asset_type: 'stock',
          sector,
          is_active: true,
        },
        include: {
          market_rankings: {
            orderBy: { rank_timestamp: 'desc' },
            take: 1,
          },
        },
        orderBy: { market_cap_rank: 'asc' },
        take: limit,
      });

      return assets
        .filter((asset) => asset.market_rankings.length > 0)
        .map((asset) => this.mapToMarketStock(asset, asset.market_rankings[0]));
    } catch (error: any) {
      this.logger.error('Failed to get stocks by sector', {
        error: error?.message,
        sector,
      });
      throw error;
    }
  }

  /**
   * Map database records to MarketStock domain object
   */
  private mapToMarketStock(asset: any, ranking: any): MarketStock {
    const price = Number(ranking.price_usd || 0);
    const marketCap = ranking.market_cap ? Number(ranking.market_cap) : null;
    const volume24h = Number(ranking.volume_24h || 0);

    return {
      rank: asset.market_cap_rank || ranking.rank,
      symbol: asset.symbol || '',
      name: asset.name || asset.display_name || '',
      sector: asset.sector || 'Unknown',
      price,
      change24h: 0, // Calculate from historical data if needed
      changePercent24h: 0, // Calculate from historical data if needed
      marketCap,
      volume24h,
      dataSource: 'alpaca_fmp',
    };
  }

  /**
   * Get count of stocks in database
   */
  async getCount(): Promise<number> {
    try {
      return await this.prisma.assets.count({
        where: {
          asset_type: 'stock',
          is_active: true,
        },
      });
    } catch (error: any) {
      this.logger.error('Failed to get stock count', { error: error?.message });
      throw error;
    }
  }

  /**
   * Get last update timestamp for stocks
   */
  async getLastUpdateTime(): Promise<Date | null> {
    try {
      const asset = await this.prisma.assets.findFirst({
        where: {
          asset_type: 'stock',
          is_active: true,
        },
        orderBy: { last_seen_at: 'desc' },
        select: { last_seen_at: true },
      });

      return asset?.last_seen_at || null;
    } catch (error: any) {
      this.logger.error('Failed to get last update time', {
        error: error?.message,
      });
      throw error;
    }
  }
}
