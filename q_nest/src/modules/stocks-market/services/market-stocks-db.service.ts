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

      // Use longer timeout for large batches (60 seconds)
      await this.prisma.$transaction(
        async (tx) => {
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
                change_24h: stock.change24h,
                change_percent_24h: stock.changePercent24h,
              },
              create: {
                rank_timestamp: now,
                asset_id: asset.asset_id,
                rank: stock.rank,
                market_cap: stock.marketCap,
                price_usd: stock.price,
                volume_24h: stock.volume24h,
                change_24h: stock.change24h,
                change_percent_24h: stock.changePercent24h,
              },
            });
          }
        },
        {
          maxWait: 60000, // 60 seconds max wait
          timeout: 60000, // 60 seconds timeout
        },
      );

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
   * Optimized query using window function for better performance
   */
  async getAll(limit?: number): Promise<MarketStock[]> {
    try {
      // Use optimized query with window function (faster than DISTINCT ON for large datasets)
      const limitValue = limit || 500;
      
      const stocks = await this.prisma.$queryRaw<Array<{
        asset_id: string;
        symbol: string;
        name: string;
        sector: string;
        market_cap_rank: number | null;
        rank: number;
        price_usd: number | null;
        market_cap: number | null;
        volume_24h: number | null;
        change_24h: number | null;
        change_percent_24h: number | null;
      }>>`
        WITH ranked_data AS (
          SELECT 
            a.asset_id,
            a.symbol,
            a.name,
            a.sector,
            a.market_cap_rank,
            mr.rank,
            mr.price_usd,
            mr.market_cap,
            mr.volume_24h,
            mr.change_24h,
            mr.change_percent_24h,
            ROW_NUMBER() OVER (
              PARTITION BY a.asset_id 
              ORDER BY mr.rank_timestamp DESC
            ) as rn
          FROM assets a
          INNER JOIN market_rankings mr ON mr.asset_id = a.asset_id
          WHERE a.asset_type = 'stock'
            AND a.is_active = true
            AND mr.price_usd IS NOT NULL
        )
        SELECT 
          asset_id,
          symbol,
          name,
          sector,
          market_cap_rank,
          COALESCE(rank, market_cap_rank, 0) as rank,
          price_usd,
          market_cap,
          volume_24h,
          change_24h,
          change_percent_24h
        FROM ranked_data
        WHERE rn = 1
        ORDER BY market_cap_rank ASC NULLS LAST
        LIMIT ${limitValue}
      `;

      return stocks.map((stock) => ({
        rank: stock.rank || stock.market_cap_rank || 0,
        symbol: stock.symbol || '',
        name: stock.name || stock.symbol || '',
        sector: stock.sector || 'Unknown',
        price: Number(stock.price_usd || 0),
        change24h: Number(stock.change_24h || 0),
        changePercent24h: Number(stock.change_percent_24h || 0),
        marketCap: stock.market_cap ? Number(stock.market_cap) : null,
        volume24h: Number(stock.volume_24h || 0),
        dataSource: 'alpaca_fmp',
      }));
    } catch (error: any) {
      this.logger.error('Failed to get all stocks', { error: error?.message });
      
      // Fallback to simpler Prisma query
      this.logger.warn('Falling back to Prisma query');
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
          take: limit || 500, // Cap at 500 for safety
        });

        return assets
          .filter((asset) => asset.market_rankings.length > 0)
          .map((asset) => this.mapToMarketStock(asset, asset.market_rankings[0]));
      } catch (fallbackError: any) {
        this.logger.error('Fallback query also failed', {
          error: fallbackError?.message,
        });
        throw fallbackError;
      }
    }
  }

  /**
   * Get all stocks with asset_id included (for top trades)
   * Returns stocks with asset_id for use in other services
   * Includes stocks even if they don't have market_rankings data yet
   */
  async getAllWithAssetId(limit?: number): Promise<Array<MarketStock & { asset_id: string }>> {
    try {
      const limitValue = limit || 500;
      
      const stocks = await this.prisma.$queryRaw<Array<{
        asset_id: string;
        symbol: string;
        name: string;
        sector: string;
        market_cap_rank: number | null;
        rank: number;
        price_usd: number | null;
        market_cap: number | null;
        volume_24h: number | null;
        change_24h: number | null;
        change_percent_24h: number | null;
      }>>`
        WITH ranked_data AS (
          SELECT 
            a.asset_id,
            a.symbol,
            a.name,
            a.sector,
            a.market_cap_rank,
            mr.rank,
            mr.price_usd,
            mr.market_cap,
            mr.volume_24h,
            mr.change_24h,
            mr.change_percent_24h,
            ROW_NUMBER() OVER (
              PARTITION BY a.asset_id 
              ORDER BY mr.rank_timestamp DESC NULLS LAST
            ) as rn
          FROM assets a
          LEFT JOIN market_rankings mr ON mr.asset_id = a.asset_id
          WHERE a.asset_type = 'stock'
            AND a.is_active = true
        )
        SELECT 
          asset_id,
          symbol,
          name,
          sector,
          market_cap_rank,
          COALESCE(rank, market_cap_rank, 0) as rank,
          price_usd,
          market_cap,
          volume_24h,
          change_24h,
          change_percent_24h
        FROM ranked_data
        WHERE rn = 1
        ORDER BY market_cap_rank ASC NULLS LAST
        LIMIT ${limitValue}
      `;
      
      this.logger.log(`Retrieved ${stocks.length} stocks from database (requested limit: ${limitValue})`);

      return stocks.map((stock) => ({
        asset_id: stock.asset_id,
        rank: stock.rank || stock.market_cap_rank || 0,
        symbol: stock.symbol || '',
        name: stock.name || stock.symbol || '',
        sector: stock.sector || 'Unknown',
        price: Number(stock.price_usd || 0),
        change24h: Number(stock.change_24h || 0),
        changePercent24h: Number(stock.change_percent_24h || 0),
        marketCap: stock.market_cap ? Number(stock.market_cap) : null,
        volume24h: Number(stock.volume_24h || 0),
        dataSource: 'alpaca_fmp',
      }));
    } catch (error: any) {
      this.logger.error('Failed to get all stocks with asset_id', { error: error?.message });
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
    const change24h = Number(ranking.change_24h || 0);
    const changePercent24h = Number(ranking.change_percent_24h || 0);

    return {
      rank: asset.market_cap_rank || ranking.rank,
      symbol: asset.symbol || '',
      name: asset.name || asset.display_name || '',
      sector: asset.sector || 'Unknown',
      price,
      change24h,
      changePercent24h,
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

  /**
   * Get all active stock symbols from database
   * Used by sync process to determine which stocks to sync
   */
  async getActiveStockSymbols(): Promise<Array<{
    symbol: string;
    name: string;
    sector: string;
  }>> {
    try {
      const assets = await this.prisma.assets.findMany({
        where: {
          asset_type: 'stock',
          is_active: true,
        },
        select: {
          symbol: true,
          name: true,
          sector: true,
        },
        orderBy: {
          market_cap_rank: 'asc',
        },
      });

      return assets
        .filter((asset) => asset.symbol)
        .map((asset) => ({
          symbol: asset.symbol!,
          name: asset.name || asset.symbol!,
          sector: asset.sector || 'Unknown',
        }));
    } catch (error: any) {
      this.logger.error('Failed to get active stock symbols', {
        error: error?.message,
      });
      throw error;
    }
  }

  /**
   * Get stocks that need syncing (limited to daily quota)
   * Prioritizes stocks with oldest last_seen_at to ensure rotation
   * Limits to maxStocksPerDay (default: 200) to avoid rate limits
   */
  async getStocksToSyncToday(
    maxStocksPerDay: number = 200,
  ): Promise<Array<{
    symbol: string;
    name: string;
    sector: string;
  }>> {
    try {
      // Get stocks ordered by last_seen_at (oldest first) to ensure rotation
      // This way, we sync different stocks each day
      const assets = await this.prisma.assets.findMany({
        where: {
          asset_type: 'stock',
          is_active: true,
        },
        select: {
          symbol: true,
          name: true,
          sector: true,
          last_seen_at: true,
        },
        orderBy: [
          { last_seen_at: 'asc' }, // Oldest first (nulls first)
          { market_cap_rank: 'asc' }, // Then by market cap rank
        ],
        take: maxStocksPerDay,
      });

      const stocks = assets
        .filter((asset) => asset.symbol)
        .map((asset) => ({
          symbol: asset.symbol!,
          name: asset.name || asset.symbol!,
          sector: asset.sector || 'Unknown',
        }));

      this.logger.log(
        `Selected ${stocks.length} stocks to sync today (oldest last_seen_at first)`,
      );

      return stocks;
    } catch (error: any) {
      this.logger.error('Failed to get stocks to sync today', {
        error: error?.message,
      });
      throw error;
    }
  }

  /**
   * Store/update S&P 500 stock symbols in database
   * Creates or updates assets records for S&P 500 stocks
   * Automatically deactivates stocks that are no longer in S&P 500
   * This is called when fetching the S&P 500 list from FMP
   */
  async storeSP500Symbols(
    symbols: Array<{ symbol: string; name: string; sector: string }>,
  ): Promise<{ stored: number; updated: number; deactivated: number }> {
    try {
      const now = new Date();
      let stored = 0;
      let updated = 0;
      let deactivated = 0;

      // Get set of new S&P 500 symbols for quick lookup
      const newSP500Symbols = new Set(symbols.map((s) => s.symbol.toUpperCase()));

      await this.prisma.$transaction(
        async (tx) => {
          // First, update/create all stocks in the new S&P 500 list
          for (const stock of symbols) {
            const existing = await tx.assets.findUnique({
              where: {
                symbol_asset_type: {
                  symbol: stock.symbol,
                  asset_type: 'stock',
                },
              },
            });

            if (existing) {
              // Update existing - ensure it's active
              await tx.assets.update({
                where: {
                  asset_id: existing.asset_id,
                },
                data: {
                  name: stock.name,
                  sector: stock.sector,
                  is_active: true, // Ensure it's active
                  last_seen_at: now,
                  display_name: stock.name,
                },
              });
              updated++;
            } else {
              // Create new
              await tx.assets.create({
                data: {
                  symbol: stock.symbol,
                  name: stock.name,
                  asset_type: 'stock',
                  sector: stock.sector,
                  is_active: true,
                  first_seen_at: now,
                  last_seen_at: now,
                  display_name: stock.name,
                },
              });
              stored++;
            }
          }

          // Second, deactivate any stocks that are no longer in S&P 500
          // (but were previously active stocks)
          const allActiveStocks = await tx.assets.findMany({
            where: {
              asset_type: 'stock',
              is_active: true,
            },
            select: {
              asset_id: true,
              symbol: true,
            },
          });

          for (const stock of allActiveStocks) {
            const symbolUpper = stock.symbol?.toUpperCase();
            if (symbolUpper && !newSP500Symbols.has(symbolUpper)) {
              // This stock is no longer in S&P 500, deactivate it
              await tx.assets.update({
                where: {
                  asset_id: stock.asset_id,
                },
                data: {
                  is_active: false,
                  last_seen_at: now,
                },
              });
              deactivated++;
            }
          }
        },
        {
          maxWait: 60000,
          timeout: 60000,
        },
      );

      if (deactivated > 0) {
        this.logger.log(
          `Stored ${stored} new, updated ${updated} existing, and deactivated ${deactivated} removed S&P 500 stocks`,
        );
      } else {
        this.logger.log(
          `Stored ${stored} new and updated ${updated} existing S&P 500 stocks`,
        );
      }

      return { stored, updated, deactivated };
    } catch (error: any) {
      this.logger.error('Failed to store S&P 500 symbols', {
        error: error?.message,
        symbolsCount: symbols.length,
      });
      throw error;
    }
  }

  /**
   * Clean up old market rankings data
   * Keeps only the last N days of data to save database storage
   */
  async cleanupOldRankings(daysToKeep: number = 7): Promise<number> {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

      this.logger.log(
        `Cleaning up market_rankings older than ${daysToKeep} days (before ${cutoffDate.toISOString()})`,
      );

      const result = await this.prisma.market_rankings.deleteMany({
        where: {
          rank_timestamp: {
            lt: cutoffDate,
          },
        },
      });

      this.logger.log(
        `Successfully deleted ${result.count} old market_rankings records`,
      );

      return result.count;
    } catch (error: any) {
      this.logger.error('Failed to cleanup old rankings', {
        error: error?.message,
      });
      throw error;
    }
  }
}
