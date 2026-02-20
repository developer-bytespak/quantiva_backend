import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

export interface AlpacaQuote {
  symbol: string;
  price: number;
  change24h: number;
  changePercent24h: number;
  volume24h: number;
  timestamp: Date;
  dayHigh?: number;
  dayLow?: number;
  dayOpen?: number;
  prevClose?: number;
}

export interface AlpacaBar {
  t: string; // timestamp
  o: number; // open
  h: number; // high
  l: number; // low
  c: number; // close
  v: number; // volume
  n?: number; // number of trades
  vw?: number; // volume weighted average price
}

export interface AlpacaSnapshot {
  symbol: string;
  latestTrade?: {
    t: string;
    p: number;
  };
  latestQuote?: {
    ap: number; // ask price
    bp: number; // bid price
  };
  prevDailyBar?: AlpacaBar;
  dailyBar?: AlpacaBar;
  minuteBar?: AlpacaBar;
}

@Injectable()
export class AlpacaMarketService {
  private readonly logger = new Logger(AlpacaMarketService.name);
  private readonly apiClient: AxiosInstance;
  private readonly apiKey: string;
  private readonly secretKey: string;
  private readonly isPaper: boolean;
  private readonly baseUrl: string;
  private readonly maxBatchSize = 100; // Alpaca allows up to 100 symbols per request
  private requestQueue: Map<string, Promise<AlpacaQuote>> = new Map();

  constructor(private configService: ConfigService) {
    this.apiKey = this.configService.get<string>('ALPACA_API_KEY') || '';
    this.secretKey = this.configService.get<string>('ALPACA_SECRET_KEY') || '';
    this.isPaper = this.configService.get<string>('ALPACA_PAPER') === 'true';

    // Use Alpaca Data API (market data is always on data.alpaca.markets)
    // Note: Trading API is different (api.alpaca.markets or paper-api.alpaca.markets)
    this.baseUrl = 'https://data.alpaca.markets';

    this.apiClient = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
      headers: {
        'APCA-API-KEY-ID': this.apiKey,
        'APCA-API-SECRET-KEY': this.secretKey,
        'Content-Type': 'application/json',
      },
    });

  }

  /**
   * Get batch quotes for multiple symbols with retry logic
   * Splits large requests into batches of 100 symbols
   */
  async getBatchQuotes(symbols: string[]): Promise<Map<string, AlpacaQuote>> {
    const results = new Map<string, AlpacaQuote>();

    if (symbols.length === 0) {
      return results;
    }

    try {
      const batches = this.chunkArray(symbols, this.maxBatchSize);

      // Process all batches in parallel
      const batchPromises = batches.map((batch) =>
        this.fetchBatchWithRetry(batch, 3),
      );
      const batchResults = await Promise.all(batchPromises);

      // Merge all batch results
      batchResults.forEach((batchMap) => {
        batchMap.forEach((quote, symbol) => {
          results.set(symbol, quote);
        });
      });

      // For symbols with missing prevDailyBar, fetch historical data
      const symbolsNeedingHistory: string[] = [];
      results.forEach((quote, symbol) => {
        if (quote.change24h === 0 && quote.changePercent24h === 0 && quote.price > 0) {
          symbolsNeedingHistory.push(symbol);
        }
      });

      if (symbolsNeedingHistory.length > 0) {
        try {
          const historicalData = await this.fetchHistoricalBars(symbolsNeedingHistory);

          historicalData.forEach((prevClose, symbol) => {
            const quote = results.get(symbol);
            if (quote && prevClose > 0) {
              quote.change24h = quote.price - prevClose;
              quote.changePercent24h = (quote.change24h / prevClose) * 100;
            }
          });
        } catch (error: any) {
          this.logger.error(
            `Failed to fetch historical data: ${error?.message}`,
          );
        }
      }

      return results;
    } catch (error: any) {
      this.logger.error('Failed to fetch batch quotes', {
        error: error?.message,
        symbolCount: symbols.length,
      });
      throw error;
    }
  }

  /**
   * Fetch historical bars to get previous close price
   */
  private async fetchHistoricalBars(
    symbols: string[],
  ): Promise<Map<string, number>> {
    const results = new Map<string, number>();

    try {
      // Get bars for the last 7 trading days to ensure we capture data
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - 10); // Look back 10 days to ensure we get data even with holidays

      const symbolsParam = symbols.join(',');

      const response = await this.apiClient.get<{
        bars: Record<string, AlpacaBar[]>;
      }>(`/v2/stocks/bars`, {
        params: {
          symbols: symbolsParam,
          timeframe: '1Day',
          start: start.toISOString().split('T')[0],
          end: end.toISOString().split('T')[0],
          limit: 10,
          feed: 'iex',
        },
      });

      const barsData = response.data?.bars || {};

      Object.entries(barsData).forEach(([symbol, bars]) => {
        if (bars && bars.length >= 2) {
          const prevBar = bars[bars.length - 2];
          results.set(symbol, prevBar.c);
        } else if (bars && bars.length === 1) {
          results.set(symbol, bars[0].o);
        }
      });

      return results;
    } catch (error: any) {
      this.logger.error(
        `Failed to fetch historical bars: ${error?.message}`,
      );
      if (error?.response?.data) {
        this.logger.error(
          `Alpaca error response: ${JSON.stringify(error.response.data)}`,
        );
      }
      return results;
    }
  }

  /**
   * Fetch a single batch with retry logic
   */
  private async fetchBatchWithRetry(
    symbols: string[],
    maxRetries: number,
  ): Promise<Map<string, AlpacaQuote>> {
    let lastError: any;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.fetchBatch(symbols);
      } catch (error: any) {
        lastError = error;
        if (attempt < maxRetries) {
          // Exponential backoff: 1s, 2s, 4s
          const delay = Math.pow(2, attempt - 1) * 1000;
          await this.sleep(delay);
        }
      }
    }

    // All retries failed
    throw new Error(
      `Failed to fetch batch after ${maxRetries} retries: ${lastError?.message}`,
    );
  }

  /**
   * Fetch snapshots for a batch of symbols
   */
  private async fetchBatch(
    symbols: string[],
  ): Promise<Map<string, AlpacaQuote>> {
    const results = new Map<string, AlpacaQuote>();

    try {
      // Fetch snapshots for all symbols
      const symbolsParam = symbols.join(',');
      const response = await this.apiClient.get<
        Record<string, AlpacaSnapshot>
      >(`/v2/stocks/snapshots`, {
        params: { symbols: symbolsParam, feed: 'iex' },
      });

      const snapshots = response.data;

      // Process each snapshot
      Object.entries(snapshots).forEach(([symbol, snapshot]) => {
        try {
          const quote = this.processSnapshot(symbol, snapshot);
          results.set(symbol, quote);
        } catch (error: any) {
          // Skip failed snapshot
        }
      });

      return results;
    } catch (error: any) {
      if (error?.response?.status === 429) {
        throw new Error('Alpaca API rate limit exceeded');
      }

      if (error?.response?.status === 401) {
        throw new Error('Alpaca API authentication failed');
      }

      throw new Error(
        `Alpaca API error: ${error?.message || 'Unknown error'}`,
      );
    }
  }

  /**
   * Process a snapshot into a quote
   */
  private processSnapshot(
    symbol: string,
    snapshot: AlpacaSnapshot,
  ): AlpacaQuote {
    const currentPrice = snapshot.latestTrade?.p || snapshot.latestQuote?.ap || 0;
    const prevClose = snapshot.prevDailyBar?.c || 0;
    const volume24h = snapshot.dailyBar?.v || 0;

    // Calculate 24h change only if we have prev close data
    let change24h = 0;
    let changePercent24h = 0;

    if (prevClose > 0 && currentPrice > 0) {
      change24h = currentPrice - prevClose;
      changePercent24h = (change24h / prevClose) * 100;
    }
    // If no prevDailyBar, change will be 0 and will be updated later via historical bars

    return {
      symbol,
      price: currentPrice,
      change24h,
      changePercent24h,
      volume24h,
      timestamp: new Date(snapshot.latestTrade?.t || new Date()),
      dayHigh: snapshot.dailyBar?.h || 0,
      dayLow: snapshot.dailyBar?.l || 0,
      dayOpen: snapshot.dailyBar?.o || 0,
      prevClose,
    };
  }

  /**
   * Get a single quote for a symbol (with request deduplication)
   */
  async getQuote(symbol: string): Promise<AlpacaQuote | null> {
    // Check if request is already in progress
    if (this.requestQueue.has(symbol)) {
      return this.requestQueue.get(symbol) || null;
    }

    // Create new request promise
    const requestPromise = this.fetchSingleQuote(symbol);
    this.requestQueue.set(symbol, requestPromise);

    try {
      const result = await requestPromise;
      return result;
    } finally {
      // Clean up queue after 5 seconds
      setTimeout(() => {
        this.requestQueue.delete(symbol);
      }, 5000);
    }
  }

  /**
   * Fetch a single quote
   */
  private async fetchSingleQuote(symbol: string): Promise<AlpacaQuote> {
    try {
      const response = await this.apiClient.get<Record<string, AlpacaSnapshot>>(
        `/v2/stocks/snapshots`,
        {
          params: { symbols: symbol, feed: 'iex' },
        },
      );

      const snapshot = response.data[symbol];
      if (!snapshot) {
        throw new Error(`No data returned for symbol ${symbol}`);
      }

      return this.processSnapshot(symbol, snapshot);
    } catch (error: any) {
      this.logger.error(`Failed to fetch quote for ${symbol}`, {
        error: error?.message,
      });
      throw error;
    }
  }

  /**
   * Health check for Alpaca API
   */
  async healthCheck(): Promise<{ online: boolean; message?: string }> {
    try {
      // Try to fetch a single snapshot for a well-known symbol
      await this.apiClient.get('/v2/stocks/snapshots', {
        params: { symbols: 'AAPL', feed: 'iex' },
      });

      return { online: true };
    } catch (error: any) {
      return {
        online: false,
        message: error?.message || 'Alpaca API unreachable',
      };
    }
  }

  /**
   * Get historical bars (OHLCV) for a single symbol
   * Used by Python technical engine for multi-timeframe analysis
   * 
   * @param symbol Stock symbol (e.g., 'AAPL')
   * @param timeframe Timeframe ('1d', '4h', '1h', '15m', etc.) or Alpaca format ('1Day', '1Hour')
   * @param limit Number of bars to fetch (default: 100)
   * @returns Array of OHLCV bars
   */
  async getHistoricalBars(
    symbol: string,
    timeframe: string = '1d',
    limit: number = 100,
  ): Promise<AlpacaBar[]> {
    try {
      // Map timeframe to Alpaca format (handles both lowercase and already-formatted)
      const alpacaTimeframe = this.mapTimeframeToAlpaca(timeframe);
      const start = this.calculateStartDate(alpacaTimeframe.toLowerCase(), limit);

      // Use multi-symbol endpoint for consistent response format
      const response = await this.apiClient.get<{
        bars: Record<string, AlpacaBar[]>;
        next_page_token?: string;
      }>(`/v2/stocks/bars`, {
        params: {
          symbols: symbol.toUpperCase(),
          timeframe: alpacaTimeframe,
          start: start.toISOString(),
          limit: limit,
          adjustment: 'split', // Adjust for stock splits
          feed: 'iex',
        },
      });

      // Multi-symbol endpoint returns { bars: { SYMBOL: [...] } }
      const bars = response.data?.bars?.[symbol.toUpperCase()] || [];
      return bars;
    } catch (error: any) {
      this.logger.error(
        `Failed to fetch historical bars for ${symbol}: ${error?.message}`,
      );
      if (error?.response?.data) {
        this.logger.error(
          `Alpaca error response: ${JSON.stringify(error.response.data)}`,
        );
      }
      return [];
    }
  }

  /**
   * Map internal timeframe format to Alpaca API format
   * Handles both internal format ('1d', '4h') and already-formatted ('1Day', '1Hour')
   * @param timeframe Internal format ('1d', '4h', '1h', '15m') or Alpaca format ('1Day', '1Hour')
   * @returns Alpaca API format ('1Day', '4Hour', '1Hour', '15Min')
   */
  private mapTimeframeToAlpaca(timeframe: string): string {
    const mapping: Record<string, string> = {
      // Lowercase internal format
      '1d': '1Day',
      '4h': '4Hour',
      '1h': '1Hour',
      '15m': '15Min',
      '5m': '5Min',
      '1m': '1Min',
      // Already formatted (pass through)
      '1Day': '1Day',
      '4Hour': '4Hour',
      '1Hour': '1Hour',
      '15Min': '15Min',
      '5Min': '5Min',
      '1Min': '1Min',
    };
    
    return mapping[timeframe] || timeframe || '1Day';
  }

  /**
   * Calculate start date for historical bars query
   * @param timeframe Timeframe string (lowercase format: '1d', '1h', '1day', '1hour')
   * @param limit Number of bars
   * @returns Start date
   */
  private calculateStartDate(timeframe: string, limit: number): Date {
    const now = new Date();
    let daysBack = 0;
    
    // Normalize timeframe to lowercase for comparison
    const tf = timeframe.toLowerCase();

    // Estimate days needed based on timeframe
    if (tf === '1d' || tf === '1day') {
      daysBack = limit + 10; // Add buffer for weekends and holidays
    } else if (tf === '4h' || tf === '4hour') {
      daysBack = Math.ceil((limit * 4) / 6) + 10; // ~6 trading hours/day
    } else if (tf === '1h' || tf === '1hour') {
      daysBack = Math.ceil(limit / 6) + 10;
    } else if (tf === '15m' || tf === '15min') {
      daysBack = Math.ceil(limit / 26) + 10; // ~26 15-min bars/day
    } else if (tf === '5m' || tf === '5min') {
      daysBack = Math.ceil(limit / 78) + 10; // ~78 5-min bars/day
    } else if (tf === '1m' || tf === '1min') {
      daysBack = Math.ceil(limit / 390) + 10; // ~390 1-min bars/day
    } else {
      daysBack = limit + 10; // Default
    }

    const startDate = new Date(now);
    startDate.setDate(startDate.getDate() - daysBack);
    
    return startDate;
  }

  /**
   * Utility: Split array into chunks
   */
  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * Utility: Sleep for ms
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}