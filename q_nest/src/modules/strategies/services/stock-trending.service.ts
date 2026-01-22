import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AlpacaMarketService, AlpacaQuote } from '../../stocks-market/services/alpaca-market.service';
import axios from 'axios';

export interface StockMarketData {
  symbol: string;
  asset_id: string;
  name: string;
  sector?: string;
  price_usd: number;
  price_change_24h: number;
  price_change_24h_usd: number;
  volume_24h: number;
  high_24h: number;
  low_24h: number;
  day_open: number;
  prev_close: number;
  market_cap?: number;
  is_realtime: boolean;
  last_updated: Date;
}

@Injectable()
export class StockTrendingService {
  private readonly logger = new Logger(StockTrendingService.name);
  private readonly pythonApiUrl: string;
  
  // Cache for market data to reduce API calls
  private marketDataCache: Map<string, { data: StockMarketData; timestamp: number }> = new Map();
  private readonly CACHE_TTL_MS = 60000; // 1 minute cache

  constructor(
    private prisma: PrismaService,
    private alpacaMarketService: AlpacaMarketService,
  ) {
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
          AND ta.market_volume > 0
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

      // Enrich with real-time Alpaca data if requested
      if (enrichWithRealtime && baseResults.length > 0) {
        try {
          const symbols = baseResults.map(r => r.symbol);
          this.logger.log(`Fetching realtime data for ${symbols.length} stocks from Alpaca`);
          
          const quotes = await this.alpacaMarketService.getBatchQuotes(symbols);
          
          // Merge realtime data into results
          for (const result of baseResults) {
            const quote = quotes.get(result.symbol);
            if (quote) {
              result.price_usd = quote.price || result.price_usd;
              result.price_change_24h = quote.changePercent24h || result.price_change_24h;
              result.volume_24h = quote.volume24h || result.volume_24h;
              result.high_24h = quote.dayHigh || result.high_24h;
              result.low_24h = quote.dayLow || result.low_24h;
              (result as any).realtime = true; // Flag to indicate realtime data
            }
          }
          
          this.logger.log(`Enriched ${quotes.size}/${symbols.length} stocks with realtime data`);
        } catch (error: any) {
          this.logger.warn(`Failed to enrich with realtime data: ${error?.message}`);
          // Continue with database data if Alpaca fails
        }
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
          timeout: 90000, // 90 seconds - Finnhub can be slow
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

  /**
   * Seed popular stocks directly without external API
   * Use this as a fallback if Finnhub is slow/unavailable
   * Now enhanced to fetch real market data from Alpaca
   */
  async seedPopularStocks(): Promise<{
    success: boolean;
    count: number;
    errors: string[];
  }> {
    const popularStocks = [
      { symbol: 'AAPL', name: 'Apple Inc.', sector: 'Technology' },
      { symbol: 'MSFT', name: 'Microsoft Corporation', sector: 'Technology' },
      { symbol: 'GOOGL', name: 'Alphabet Inc.', sector: 'Technology' },
      { symbol: 'AMZN', name: 'Amazon.com Inc.', sector: 'Consumer Cyclical' },
      { symbol: 'NVDA', name: 'NVIDIA Corporation', sector: 'Technology' },
      { symbol: 'META', name: 'Meta Platforms Inc.', sector: 'Technology' },
      { symbol: 'TSLA', name: 'Tesla Inc.', sector: 'Consumer Cyclical' },
      { symbol: 'JPM', name: 'JPMorgan Chase & Co.', sector: 'Financial Services' },
      { symbol: 'V', name: 'Visa Inc.', sector: 'Financial Services' },
      { symbol: 'JNJ', name: 'Johnson & Johnson', sector: 'Healthcare' },
      { symbol: 'WMT', name: 'Walmart Inc.', sector: 'Consumer Defensive' },
      { symbol: 'PG', name: 'Procter & Gamble Co.', sector: 'Consumer Defensive' },
      { symbol: 'MA', name: 'Mastercard Inc.', sector: 'Financial Services' },
      { symbol: 'HD', name: 'The Home Depot Inc.', sector: 'Consumer Cyclical' },
      { symbol: 'DIS', name: 'The Walt Disney Company', sector: 'Communication Services' },
      { symbol: 'NFLX', name: 'Netflix Inc.', sector: 'Communication Services' },
      { symbol: 'AMD', name: 'Advanced Micro Devices Inc.', sector: 'Technology' },
      { symbol: 'CRM', name: 'Salesforce Inc.', sector: 'Technology' },
      { symbol: 'INTC', name: 'Intel Corporation', sector: 'Technology' },
      { symbol: 'ORCL', name: 'Oracle Corporation', sector: 'Technology' },
    ];

    this.logger.log('Seeding popular stocks with real Alpaca market data...');

    const errors: string[] = [];
    let successCount = 0;

    // First, fetch real market data from Alpaca for all stocks
    const symbols = popularStocks.map(s => s.symbol);
    let alpacaQuotes: Map<string, AlpacaQuote> = new Map();
    
    try {
      this.logger.log(`Fetching Alpaca quotes for ${symbols.length} popular stocks`);
      alpacaQuotes = await this.alpacaMarketService.getBatchQuotes(symbols);
      this.logger.log(`Retrieved ${alpacaQuotes.size} quotes from Alpaca`);
    } catch (error: any) {
      this.logger.warn(`Failed to fetch Alpaca quotes: ${error.message}. Using placeholder data.`);
    }

    for (const stock of popularStocks) {
      try {
        // Get Alpaca quote if available
        const quote = alpacaQuotes.get(stock.symbol);
        
        // Find or create asset
        let asset = await this.prisma.assets.findFirst({
          where: {
            symbol: stock.symbol,
            asset_type: 'stock',
          },
        });

        if (!asset) {
          asset = await this.prisma.assets.create({
            data: {
              symbol: stock.symbol,
              name: stock.name,
              display_name: stock.name,
              asset_type: 'stock',
              sector: stock.sector,
              is_active: true,
              first_seen_at: new Date(),
              last_seen_at: new Date(),
            },
          });
        } else {
          await this.prisma.assets.update({
            where: { asset_id: asset.asset_id },
            data: { last_seen_at: new Date() },
          });
        }

        // Create trending_assets entry with real or placeholder data
        const pollTimestamp = new Date();
        const price = quote?.price || 100;
        // Ensure minimum volume of 10M for popular stocks (they're all high-volume by definition)
        const rawVolume = quote?.volume24h || 0;
        const volume = rawVolume > 0 ? rawVolume : 10000000; // Default 10M if no data
        const priceChange = quote?.changePercent24h || 0;
        const high = quote?.dayHigh || price;
        const low = quote?.dayLow || price;
        
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
            price_usd: price,
            price_change_24h: priceChange,
            market_volume: volume,
            volume_24h: volume,
            high_24h: high,
            low_24h: low,
          },
          update: {
            price_usd: price,
            price_change_24h: priceChange,
            market_volume: volume,
            volume_24h: volume,
            high_24h: high,
            low_24h: low,
          },
        });

        successCount++;
        this.logger.debug(`Seeded ${stock.symbol}: $${price.toFixed(2)}, ${priceChange.toFixed(2)}%`);
      } catch (err: any) {
        errors.push(`Error seeding ${stock.symbol}: ${err.message}`);
        this.logger.error(`Error seeding stock ${stock.symbol}:`, err);
      }
    }

    this.logger.log(`Seeded ${successCount}/${popularStocks.length} popular stocks with ${alpacaQuotes.size > 0 ? 'real' : 'placeholder'} market data`);

    return {
      success: successCount > 0,
      count: successCount,
      errors,
    };
  }

  /**
   * Sync all stock market data from Alpaca API
   * This refreshes trending_assets with real-time OHLCV data
   */
  async syncMarketDataFromAlpaca(): Promise<{
    success: boolean;
    updated: number;
    errors: string[];
  }> {
    this.logger.log('Syncing stock market data from Alpaca API...');
    const errors: string[] = [];
    let updatedCount = 0;

    try {
      // Get all stock assets from database
      const stockAssets = await this.prisma.assets.findMany({
        where: {
          asset_type: 'stock',
          is_active: true,
        },
        select: {
          asset_id: true,
          symbol: true,
          name: true,
          display_name: true,
          sector: true,
        },
      });

      if (stockAssets.length === 0) {
        this.logger.warn('No stock assets found in database');
        return { success: false, updated: 0, errors: ['No stock assets found'] };
      }

      this.logger.log(`Found ${stockAssets.length} stock assets to update`);

      // Fetch quotes from Alpaca in batches
      const symbols = stockAssets.map(a => a.symbol);
      const quotes = await this.alpacaMarketService.getBatchQuotes(symbols);

      this.logger.log(`Retrieved ${quotes.size} quotes from Alpaca`);

      // Update trending_assets with real data
      const pollTimestamp = new Date();
      
      for (const asset of stockAssets) {
        const quote = quotes.get(asset.symbol);
        
        if (!quote || quote.price === 0) {
          errors.push(`No valid quote for ${asset.symbol}`);
          continue;
        }

        try {
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
              price_usd: quote.price,
              price_change_24h: quote.changePercent24h,
              price_change_24h_usd: quote.change24h,
              market_volume: quote.volume24h,
              volume_24h: quote.volume24h,
              high_24h: quote.dayHigh || quote.price,
              low_24h: quote.dayLow || quote.price,
            },
            update: {
              price_usd: quote.price,
              price_change_24h: quote.changePercent24h,
              price_change_24h_usd: quote.change24h,
              market_volume: quote.volume24h,
              volume_24h: quote.volume24h,
              high_24h: quote.dayHigh || quote.price,
              low_24h: quote.dayLow || quote.price,
            },
          });

          // Update cache
          this.marketDataCache.set(asset.symbol, {
            data: {
              symbol: asset.symbol,
              asset_id: asset.asset_id,
              name: asset.display_name || asset.name || asset.symbol,
              sector: asset.sector || undefined,
              price_usd: quote.price,
              price_change_24h: quote.changePercent24h,
              price_change_24h_usd: quote.change24h,
              volume_24h: quote.volume24h,
              high_24h: quote.dayHigh || quote.price,
              low_24h: quote.dayLow || quote.price,
              day_open: quote.dayOpen || quote.price,
              prev_close: quote.prevClose || quote.price,
              is_realtime: true,
              last_updated: new Date(),
            },
            timestamp: Date.now(),
          });

          updatedCount++;
        } catch (err: any) {
          errors.push(`Error updating ${asset.symbol}: ${err.message}`);
        }
      }

      this.logger.log(`Updated ${updatedCount}/${stockAssets.length} stocks with Alpaca market data`);

      return {
        success: updatedCount > 0,
        updated: updatedCount,
        errors,
      };
    } catch (error: any) {
      this.logger.error(`Failed to sync market data from Alpaca: ${error.message}`);
      return {
        success: false,
        updated: 0,
        errors: [error.message],
      };
    }
  }

  /**
   * Get market data for a specific stock (with caching)
   */
  async getStockMarketData(symbol: string): Promise<StockMarketData | null> {
    const symbolUpper = symbol.toUpperCase();
    
    // Check cache first
    const cached = this.marketDataCache.get(symbolUpper);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
      return cached.data;
    }

    try {
      // Fetch fresh data from Alpaca
      const quote = await this.alpacaMarketService.getQuote(symbolUpper);
      
      if (!quote) {
        return null;
      }

      // Get asset from database
      const asset = await this.prisma.assets.findFirst({
        where: {
          symbol: symbolUpper,
          asset_type: 'stock',
        },
      });

      if (!asset) {
        return null;
      }

      const marketData: StockMarketData = {
        symbol: symbolUpper,
        asset_id: asset.asset_id,
        name: asset.display_name || asset.name || symbolUpper,
        sector: asset.sector || undefined,
        price_usd: quote.price,
        price_change_24h: quote.changePercent24h,
        price_change_24h_usd: quote.change24h,
        volume_24h: quote.volume24h,
        high_24h: quote.dayHigh || quote.price,
        low_24h: quote.dayLow || quote.price,
        day_open: quote.dayOpen || quote.price,
        prev_close: quote.prevClose || quote.price,
        is_realtime: true,
        last_updated: quote.timestamp,
      };

      // Update cache
      this.marketDataCache.set(symbolUpper, {
        data: marketData,
        timestamp: Date.now(),
      });

      return marketData;
    } catch (error: any) {
      this.logger.error(`Failed to get market data for ${symbolUpper}: ${error.message}`);
      return null;
    }
  }

  /**
   * Get all stocks with market data for Top Trades page
   * Returns stock data from database (synced by cronjob every 5 minutes)
   * 
   * @param limit Maximum number of stocks to return
   * @param forceRealtime If true, fetches live data from Alpaca (default: false, uses DB cache)
   */
  async getStocksForTopTrades(limit: number = 20, forceRealtime: boolean = false): Promise<{
    stocks: StockMarketData[];
    source: 'alpaca' | 'database';
    updated_at: Date;
  }> {
    try {
      // Get trending stocks from database
      // By default, use cached DB data (synced by cronjob every 5 minutes)
      // Only fetch live Alpaca data if explicitly requested
      const trendingStocks = await this.getTopTrendingStocks(limit, forceRealtime);
      
      if (trendingStocks.length === 0) {
        return {
          stocks: [],
          source: 'database',
          updated_at: new Date(),
        };
      }

      // Transform to StockMarketData format
      const stocks: StockMarketData[] = trendingStocks.map(stock => ({
        symbol: stock.symbol,
        asset_id: stock.asset_id,
        name: stock.name,
        sector: stock.sector || undefined,
        price_usd: stock.price_usd,
        price_change_24h: stock.price_change_24h,
        price_change_24h_usd: stock.price_change_24h_usd || stock.price_usd * (stock.price_change_24h / 100),
        volume_24h: stock.volume_24h,
        high_24h: stock.high_24h || stock.price_usd,
        low_24h: stock.low_24h || stock.price_usd,
        day_open: stock.price_usd, // Will be updated if we have realtime data
        prev_close: stock.price_usd, // Will be updated if we have realtime data
        is_realtime: (stock as any).realtime === true,
        last_updated: stock.poll_timestamp || new Date(),
      }));

      return {
        stocks,
        source: stocks.some(s => s.is_realtime) ? 'alpaca' : 'database',
        updated_at: new Date(),
      };
    } catch (error: any) {
      this.logger.error(`Failed to get stocks for top trades: ${error.message}`);
      return {
        stocks: [],
        source: 'database',
        updated_at: new Date(),
      };
    }
  }
}
