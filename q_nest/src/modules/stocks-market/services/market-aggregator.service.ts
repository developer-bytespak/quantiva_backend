import { Injectable, Logger } from '@nestjs/common';
import { AlpacaMarketService } from './alpaca-market.service';
import { FmpService } from './fmp.service';
import { MarketStock } from '../types/market.types';
import { StockSymbol } from '../data/sp500-symbols';

@Injectable()
export class MarketAggregatorService {
  private readonly logger = new Logger(MarketAggregatorService.name);

  constructor(
    private alpacaService: AlpacaMarketService,
    private fmpService: FmpService,
  ) {}

  /**
   * Aggregate market data with FMP rotation to respect rate limits
   * - Alpaca: Called for ALL symbols (no rate limit) - provides real-time prices
   * - FMP: Called only for fmpSymbols subset (200/day limit) - provides market cap
   * 
   * This allows syncing 500+ stocks while staying within FMP's daily limit.
   * Stocks not in fmpSymbols will retain their existing market cap from the database.
   * 
   * @param allStockSymbols All stocks to sync (get prices from Alpaca)
   * @param fmpSymbols Subset of symbols to fetch market cap from FMP (rotated daily)
   */
  async getAggregatedMarketDataWithRotation(
    allStockSymbols: StockSymbol[],
    fmpSymbols: string[],
  ): Promise<{
    stocks: MarketStock[];
    warnings: string[];
    fmpSynced: number;
  }> {
    const warnings: string[] = [];
    const allSymbols = allStockSymbols.map((s) => s.symbol);
    const fmpSymbolSet = new Set(fmpSymbols.map(s => s.toUpperCase()));

    try {
      this.logger.log(
        `Aggregating market data: ${allSymbols.length} stocks via Alpaca, ${fmpSymbols.length} via FMP (rotation)`,
      );

      // Fetch from Alpaca for ALL symbols (no rate limit)
      const alpacaQuotes = await this.alpacaService.getBatchQuotes(allSymbols);
      const alpacaData = alpacaQuotes;
      this.logger.log(`Retrieved Alpaca data for ${alpacaData.size} symbols`);

      // Fetch from FMP only for the rotated subset
      let fmpData = new Map<string, any>();
      let fmpSynced = 0;
      if (fmpSymbols.length > 0) {
        try {
          fmpData = await this.fmpService.getBatchProfiles(fmpSymbols);
          fmpSynced = fmpData.size;
          if (fmpData.size > 0) {
            this.logger.log(`Retrieved FMP data for ${fmpData.size}/${fmpSymbols.length} symbols (rotation batch)`);
          }
        } catch (fmpError: any) {
          this.logger.warn(`FMP data fetch failed: ${fmpError?.message}`);
          warnings.push(`Market cap data unavailable for rotation batch: ${fmpError?.message || 'FMP API error'}`);
        }
      }

      // Merge data
      const stocks: MarketStock[] = [];

      allStockSymbols.forEach((stockSymbol) => {
        const { symbol, name, sector } = stockSymbol;
        const alpacaQuote = alpacaData.get(symbol);
        const fmpQuote = fmpData.get(symbol);

        // Skip if no data from Alpaca (primary source for prices)
        if (!alpacaQuote) {
          // Still include if we have FMP data
          if (!fmpQuote) {
            this.logger.debug(`No data available for ${symbol}`);
            return;
          }
        }

        // Prefer Alpaca for real-time price data
        const price = alpacaQuote?.price || fmpQuote?.price || 0;
        const change24h = alpacaQuote?.change24h || fmpQuote?.change || 0;
        const changePercent24h =
          alpacaQuote?.changePercent24h || fmpQuote?.changesPercentage || 0;
        const volume24h = alpacaQuote?.volume24h || fmpQuote?.volume || 0;

        // Market cap only from FMP (if this symbol was in the rotation batch)
        // If not in rotation batch, marketCap will be null and DB will retain existing value
        const marketCap = fmpQuote?.marketCap || null;

        const stock: MarketStock = {
          rank: 0, // Will be set after sorting
          symbol,
          name,
          sector,
          price,
          change24h,
          changePercent24h,
          marketCap,
          volume24h,
          timestamp: alpacaQuote?.timestamp || new Date(),
        };

        stocks.push(stock);
      });

      // Sort by market cap (nulls at the end)
      stocks.sort((a, b) => {
        if (a.marketCap === null && b.marketCap === null) return 0;
        if (a.marketCap === null) return 1;
        if (b.marketCap === null) return -1;
        return b.marketCap - a.marketCap;
      });

      // Assign ranks
      stocks.forEach((stock, index) => {
        stock.rank = index + 1;
      });

      this.logger.log(
        `Successfully aggregated ${stocks.length}/${allSymbols.length} stocks (${fmpSynced} with fresh market cap)`,
      );

      return { stocks, warnings, fmpSynced };
    } catch (error: any) {
      this.logger.error('Failed to aggregate market data with rotation', {
        error: error?.message,
      });
      throw new Error(`Market data aggregation failed: ${error?.message}`);
    }
  }

  /**
   * Aggregate market data from Alpaca and FMP
   * Merges price/volume from Alpaca with market cap from FMP
   * @deprecated Use getAggregatedMarketDataWithRotation for better rate limit handling
   */
  async getAggregatedMarketData(
    stockSymbols: StockSymbol[],
  ): Promise<{
    stocks: MarketStock[];
    warnings: string[];
  }> {
    const warnings: string[] = [];
    const symbols = stockSymbols.map((s) => s.symbol);

    try {
      this.logger.log(`Aggregating market data for ${symbols.length} symbols`);

      // Fetch from Alpaca
      const alpacaQuotes = await this.alpacaService.getBatchQuotes(symbols);
      const alpacaData = alpacaQuotes;

      // Try to fetch from FMP for market cap data
      let fmpData = new Map<string, any>();
      try {
        fmpData = await this.fmpService.getBatchProfiles(symbols);
        if (fmpData.size > 0) {
          this.logger.log(`Retrieved FMP data for ${fmpData.size} symbols`);
        }
      } catch (fmpError: any) {
        this.logger.warn(`FMP data fetch failed: ${fmpError?.message}`);
        warnings.push(`Market cap data unavailable: ${fmpError?.message || 'FMP API error'}`);
      }

      // Merge data
      const stocks: MarketStock[] = [];

      stockSymbols.forEach((stockSymbol) => {
        const { symbol, name, sector } = stockSymbol;
        const alpacaQuote = alpacaData.get(symbol);
        const fmpQuote = fmpData.get(symbol);

        // Skip if no data from either source
        if (!alpacaQuote && !fmpQuote) {
          this.logger.warn(`No data available for ${symbol}`);
          return;
        }

        // Prefer Alpaca for real-time price data, fallback to FMP
        const price = alpacaQuote?.price || fmpQuote?.price || 0;
        const change24h = alpacaQuote?.change24h || fmpQuote?.change || 0;
        const changePercent24h =
          alpacaQuote?.changePercent24h || fmpQuote?.changesPercentage || 0;
        const volume24h = alpacaQuote?.volume24h || fmpQuote?.volume || 0;

        // Market cap only from FMP
        const marketCap = fmpQuote?.marketCap || null;

        const stock: MarketStock = {
          rank: 0, // Will be set after sorting
          symbol,
          name,
          sector,
          price,
          change24h,
          changePercent24h,
          marketCap,
          volume24h,
          timestamp: alpacaQuote?.timestamp || new Date(),
        };

        stocks.push(stock);
      });

      // Sort by market cap (nulls at the end)
      stocks.sort((a, b) => {
        if (a.marketCap === null && b.marketCap === null) return 0;
        if (a.marketCap === null) return 1;
        if (b.marketCap === null) return -1;
        return b.marketCap - a.marketCap;
      });

      // Assign ranks
      stocks.forEach((stock, index) => {
        stock.rank = index + 1;
      });

      this.logger.log(
        `Successfully aggregated ${stocks.length}/${symbols.length} stocks`,
      );

      return { stocks, warnings };
    } catch (error: any) {
      this.logger.error('Failed to aggregate market data', {
        error: error?.message,
      });
      throw new Error(`Market data aggregation failed: ${error?.message}`);
    }
  }

  /**
   * Get aggregated data for specific symbols
   */
  async getAggregatedDataForSymbols(
    symbols: string[],
    stockSymbols: StockSymbol[],
  ): Promise<{
    stocks: MarketStock[];
    warnings: string[];
  }> {
    // Filter stock symbols to requested ones
    const filteredStockSymbols = stockSymbols.filter((s) =>
      symbols.includes(s.symbol),
    );

    return this.getAggregatedMarketData(filteredStockSymbols);
  }

  /**
   * Health check for all upstream services
   */
  async healthCheck(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    services: {
      alpaca: { online: boolean; message?: string };
      fmp: { online: boolean; message?: string };
    };
  }> {
    try {
      const [alpacaHealth, fmpHealth] = await Promise.allSettled([
        this.alpacaService.healthCheck(),
        this.fmpService.healthCheck(),
      ]);

      const alpaca =
        alpacaHealth.status === 'fulfilled'
          ? alpacaHealth.value
          : { online: false, message: 'Health check failed' };

      const fmp =
        fmpHealth.status === 'fulfilled'
          ? fmpHealth.value
          : { online: false, message: 'Health check failed' };

      let status: 'healthy' | 'degraded' | 'unhealthy';
      if (alpaca.online && fmp.online) {
        status = 'healthy';
      } else if (alpaca.online || fmp.online) {
        status = 'degraded';
      } else {
        status = 'unhealthy';
      }

      return {
        status,
        services: {
          alpaca,
          fmp,
        },
      };
    } catch (error: any) {
      this.logger.error('Health check failed', { error: error?.message });
      return {
        status: 'unhealthy',
        services: {
          alpaca: { online: false, message: 'Health check error' },
          fmp: { online: false, message: 'Health check error' },
        },
      };
    }
  }
}
