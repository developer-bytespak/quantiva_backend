import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import axios from 'axios';

@Injectable()
export class StockTrendingService {
  private readonly logger = new Logger(StockTrendingService.name);
  private readonly pythonApiUrl: string;

  constructor(private prisma: PrismaService) {
    this.pythonApiUrl = process.env.PYTHON_API_URL || 'http://localhost:8000';
  }

  /**
   * Get top N trending stocks from database
   * 
   * Fetches stocks from trending_assets table filtered by asset_type='stock'
   * Ranked by volume, market cap, and price change
   * 
   * @param limit Maximum number of stocks to return (default: 50)
   * @param enrichWithRealtime Whether to enrich with real-time Alpaca data (default: false)
   * @returns Array of trending stock objects
   */
  async getTopTrendingStocks(limit: number = 50, enrichWithRealtime: boolean = false) {
    try {
      const rows: any[] = await this.prisma.$queryRaw`
        SELECT DISTINCT ON (ta.asset_id)
          ta.asset_id,
          ta.price_usd,
          ta.market_volume,
          ta.volume_24h,
          ta.price_change_24h,
          ta.price_change_24h_usd,
          ta.market_cap,
          ta.high_24h,
          ta.low_24h,
          ta.poll_timestamp,
          a.symbol,
          a.name,
          a.display_name,
          a.logo_url,
          a.asset_type,
          a.sector,
          a.market_cap_rank
        FROM trending_assets ta
        INNER JOIN assets a ON ta.asset_id = a.asset_id
        WHERE
          a.asset_type = 'stock'
          AND ta.price_usd IS NOT NULL
          AND ta.market_volume > 1000000
          AND a.is_active = true
        ORDER BY
          ta.asset_id,
          ta.poll_timestamp DESC
        LIMIT ${limit}
      `;

      if (!rows.length) {
        this.logger.warn('No trending stocks found in database');
        return [];
      }

      // Transform to response format
      const baseResults = rows.map((r) => ({
        asset_id: r.asset_id,
        symbol: r.symbol,
        name: r.display_name || r.name || r.symbol,
        logo_url: r.logo_url,
        asset_type: r.asset_type,
        sector: r.sector,
        price_usd: Number(r.price_usd),
        price_change_24h: Number(r.price_change_24h || 0),
        price_change_24h_usd: Number(r.price_change_24h_usd || 0),
        market_cap: Number(r.market_cap || 0),
        volume_24h: Number(r.volume_24h || r.market_volume || 0),
        high_24h: Number(r.high_24h || 0),
        low_24h: Number(r.low_24h || 0),
        market_volume: Number(r.market_volume),
        market_cap_rank: r.market_cap_rank,
        poll_timestamp: r.poll_timestamp,
      }));

      // TODO: Add Alpaca real-time enrichment if requested
      // This would require AlpacaMarketService integration
      if (enrichWithRealtime) {
        this.logger.warn('Real-time enrichment for stocks not yet implemented');
      }

      return baseResults;
    } catch (err: any) {
      this.logger.error(`Error fetching trending stocks: ${err?.message || err}`);
      return [];
    }
  }

  /**
   * Sync trending stocks from Python Finnhub service to database
   * 
   * Fetches trending stocks from Python API (which calls Finnhub)
   * and stores them in trending_assets table
   * 
   * @returns Object with success status and count of synced stocks
   */
  async syncTrendingStocksFromFinnhub(): Promise<{
    success: boolean;
    count: number;
    errors: string[];
  }> {
    try {
      this.logger.log('Syncing trending stocks from Finnhub via Python API...');

      // Call Python API to fetch trending stocks
      const response = await axios.get(
        `${this.pythonApiUrl}/api/v1/stocks/trending`,
        {
          params: { limit: 50 },
          timeout: 30000,
        }
      );

      const trendingStocks = response.data?.stocks || response.data || [];

      if (!Array.isArray(trendingStocks) || trendingStocks.length === 0) {
        this.logger.warn('No trending stocks received from Python API');
        return { success: false, count: 0, errors: ['No stocks returned'] };
      }

      this.logger.log(`Received ${trendingStocks.length} trending stocks from Python API`);

      const errors: string[] = [];
      let successCount = 0;

      // Process each stock
      for (const stock of trendingStocks) {
        try {
          const symbol = stock.symbol?.toUpperCase();
          if (!symbol) {
            errors.push(`Invalid stock: missing symbol`);
            continue;
          }

          // Find or create asset
          let asset = await this.prisma.assets.findFirst({
            where: {
              symbol: symbol,
              asset_type: 'stock',
            },
          });

          if (!asset) {
            // Create new stock asset
            asset = await this.prisma.assets.create({
              data: {
                symbol: symbol,
                name: stock.name || symbol,
                display_name: stock.name || symbol,
                asset_type: 'stock',
                sector: stock.sector || null,
                is_active: true,
                first_seen_at: new Date(),
                last_seen_at: new Date(),
              },
            });
          } else {
            // Update last seen timestamp
            await this.prisma.assets.update({
              where: { asset_id: asset.asset_id },
              data: { last_seen_at: new Date() },
            });
          }

          // Insert or update trending_assets entry
          const pollTimestamp = new Date();

          await this.prisma.trending_assets.upsert({
            where: {
              poll_timestamp_asset_id: {
                poll_timestamp: pollTimestamp,
                asset_id: asset.asset_id,
              },
            },
            create: {
              poll_timestamp: pollTimestamp,
              asset_id: asset.asset_id,
              price_usd: stock.price || null,
              price_change_24h: stock.change_percent || null,
              market_volume: stock.volume || null,
              volume_24h: stock.volume || null,
              high_24h: stock.high || null,
              low_24h: stock.low || null,
              market_cap: null, // Finnhub doesn't provide market cap in trending
              trend_rank: stock.mention_count || null,
            },
            update: {
              price_usd: stock.price || null,
              price_change_24h: stock.change_percent || null,
              market_volume: stock.volume || null,
              volume_24h: stock.volume || null,
              high_24h: stock.high || null,
              low_24h: stock.low || null,
              trend_rank: stock.mention_count || null,
            },
          });

          successCount++;
        } catch (err: any) {
          errors.push(`Error syncing ${stock.symbol}: ${err.message}`);
          this.logger.error(`Error syncing stock ${stock.symbol}:`, err);
        }
      }

      this.logger.log(`Synced ${successCount}/${trendingStocks.length} trending stocks`);

      return {
        success: successCount > 0,
        count: successCount,
        errors,
      };
    } catch (err: any) {
      this.logger.error(`Failed to sync trending stocks: ${err?.message || err}`);
      return {
        success: false,
        count: 0,
        errors: [err?.message || 'Unknown error'],
      };
    }
  }
}
