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
}

export interface AlpacaBar {
  t: string; // timestamp
  o: number; // open
  h: number; // high
  l: number; // low
  c: number; // close
  v: number; // volume
}

export interface AlpacaSnapshot {
  symbol: string;
  latestTrade: {
    t: string;
    p: number;
  };
  latestQuote: {
    ap: number; // ask price
    bp: number; // bid price
  };
  prevDailyBar: AlpacaBar;
  dailyBar: AlpacaBar;
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

    // Use paper or live URL based on environment
    this.baseUrl = this.isPaper
      ? 'https://paper-api.alpaca.markets'
      : 'https://api.alpaca.markets';

    this.apiClient = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
      headers: {
        'APCA-API-KEY-ID': this.apiKey,
        'APCA-API-SECRET-KEY': this.secretKey,
        'Content-Type': 'application/json',
      },
    });

    this.logger.log(
      `Alpaca Market Service initialized: ${this.isPaper ? 'Paper Trading' : 'Live Trading'}`,
    );
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
      // Split into batches of maxBatchSize
      const batches = this.chunkArray(symbols, this.maxBatchSize);

      this.logger.log(
        `Fetching quotes for ${symbols.length} symbols in ${batches.length} batches`,
      );

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

      this.logger.log(
        `Successfully fetched ${results.size}/${symbols.length} quotes`,
      );

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
        this.logger.warn(
          `Batch fetch attempt ${attempt}/${maxRetries} failed: ${error?.message}`,
        );

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
        params: { symbols: symbolsParam },
      });

      const snapshots = response.data;

      // Process each snapshot
      Object.entries(snapshots).forEach(([symbol, snapshot]) => {
        try {
          const quote = this.processSnapshot(symbol, snapshot);
          results.set(symbol, quote);
        } catch (error: any) {
          this.logger.warn(
            `Failed to process snapshot for ${symbol}: ${error?.message}`,
          );
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
    const prevClose = snapshot.prevDailyBar?.c || currentPrice;
    const volume24h = snapshot.dailyBar?.v || 0;

    // Calculate 24h change
    const change24h = currentPrice - prevClose;
    const changePercent24h = prevClose > 0 ? (change24h / prevClose) * 100 : 0;

    return {
      symbol,
      price: currentPrice,
      change24h,
      changePercent24h,
      volume24h,
      timestamp: new Date(snapshot.latestTrade?.t || new Date()),
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
          params: { symbols: symbol },
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
        params: { symbols: 'AAPL' },
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
