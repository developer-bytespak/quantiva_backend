import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

export interface FmpQuote {
  symbol: string;
  name: string;
  price: number;
  changesPercentage: number;
  change: number;
  dayLow: number;
  dayHigh: number;
  yearHigh: number;
  yearLow: number;
  marketCap: number;
  priceAvg50: number;
  priceAvg200: number;
  volume: number;
  avgVolume: number;
  open: number;
  previousClose: number;
  eps: number;
  pe: number;
  earningsAnnouncement: string;
  sharesOutstanding: number;
  timestamp: number;
}

@Injectable()
export class FmpService {
  private readonly logger = new Logger(FmpService.name);
  private readonly apiClient: AxiosInstance;
  private readonly apiKey: string;
  private readonly cache: Map<
    string,
    { data: Map<string, FmpQuote>; timestamp: number }
  > = new Map();
  private readonly cacheTTL = 24 * 60 * 60 * 1000; // 24 hours in ms
  private readonly maxBatchSize = 100;

  constructor(private configService: ConfigService) {
    this.apiKey = this.configService.get<string>('FMP_API_KEY') || '';

    this.apiClient = axios.create({
      baseURL: 'https://financialmodelingprep.com/api/v3',
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    this.logger.log('FMP Service initialized');
  }

  /**
   * Get batch profiles (quotes) for multiple symbols
   * Includes caching with 24-hour TTL
   */
  async getBatchProfiles(symbols: string[]): Promise<Map<string, FmpQuote>> {
    const results = new Map<string, FmpQuote>();

    if (symbols.length === 0) {
      return results;
    }

    try {
      // Check cache first
      const cacheKey = this.getCacheKey(symbols);
      const cached = this.cache.get(cacheKey);

      if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
        this.logger.log(
          `Returning cached FMP data for ${symbols.length} symbols`,
        );
        return cached.data;
      }

      // Split into batches
      const batches = this.chunkArray(symbols, this.maxBatchSize);
      this.logger.log(
        `Fetching FMP profiles for ${symbols.length} symbols in ${batches.length} batches`,
      );

      // Fetch all batches in parallel with retry
      const batchPromises = batches.map((batch) =>
        this.fetchBatchWithRetry(batch, 3),
      );
      const batchResults = await Promise.all(batchPromises);

      // Merge results
      batchResults.forEach((batchMap) => {
        batchMap.forEach((quote, symbol) => {
          results.set(symbol, quote);
        });
      });

      // Cache results
      this.cache.set(cacheKey, {
        data: results,
        timestamp: Date.now(),
      });

      this.logger.log(
        `Successfully fetched ${results.size}/${symbols.length} FMP profiles`,
      );

      return results;
    } catch (error: any) {
      this.logger.error('Failed to fetch batch profiles from FMP', {
        error: error?.message,
        symbolCount: symbols.length,
      });
      throw error;
    }
  }

  /**
   * Fetch batch with retry logic
   */
  private async fetchBatchWithRetry(
    symbols: string[],
    maxRetries: number,
  ): Promise<Map<string, FmpQuote>> {
    let lastError: any;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.fetchBatch(symbols);
      } catch (error: any) {
        lastError = error;
        this.logger.warn(
          `FMP batch fetch attempt ${attempt}/${maxRetries} failed: ${error?.message}`,
        );

        if (attempt < maxRetries) {
          // Exponential backoff
          const delay = Math.pow(2, attempt - 1) * 1000;
          await this.sleep(delay);
        }
      }
    }

    throw new Error(
      `FMP batch fetch failed after ${maxRetries} retries: ${lastError?.message}`,
    );
  }

  /**
   * Fetch a single batch of quotes
   */
  private async fetchBatch(symbols: string[]): Promise<Map<string, FmpQuote>> {
    const results = new Map<string, FmpQuote>();

    try {
      // FMP allows comma-separated symbols in /quote endpoint
      const symbolsParam = symbols.join(',');
      const response = await this.apiClient.get<FmpQuote[]>('/quote', {
        params: {
          apikey: this.apiKey,
          symbol: symbolsParam,
        },
      });

      if (!Array.isArray(response.data)) {
        throw new Error('Invalid response format from FMP API');
      }

      // Process each quote
      response.data.forEach((quote) => {
        if (quote && quote.symbol) {
          results.set(quote.symbol, quote);
        }
      });

      return results;
    } catch (error: any) {
      if (error?.response?.status === 429) {
        throw new Error('FMP API rate limit exceeded');
      }

      if (error?.response?.status === 401 || error?.response?.status === 403) {
        throw new Error('FMP API authentication failed');
      }

      throw new Error(`FMP API error: ${error?.message || 'Unknown error'}`);
    }
  }

  /**
   * Get company profile (alternative endpoint with more details)
   */
  async getCompanyProfile(symbol: string): Promise<any> {
    try {
      const response = await this.apiClient.get(`/profile/${symbol}`, {
        params: { apikey: this.apiKey },
      });

      return response.data[0] || null;
    } catch (error: any) {
      this.logger.error(`Failed to fetch profile for ${symbol}`, {
        error: error?.message,
      });
      return null;
    }
  }

  /**
   * Health check for FMP API
   */
  async healthCheck(): Promise<{ online: boolean; message?: string }> {
    try {
      // Test with a simple quote request
      const response = await this.apiClient.get('/quote/AAPL', {
        params: { apikey: this.apiKey },
      });

      if (response.data && Array.isArray(response.data)) {
        return { online: true };
      }

      return { online: false, message: 'Invalid response format' };
    } catch (error: any) {
      return {
        online: false,
        message: error?.message || 'FMP API unreachable',
      };
    }
  }

  /**
   * Clear cache (useful for testing or manual refresh)
   */
  clearCache(): void {
    this.cache.clear();
    this.logger.log('FMP cache cleared');
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    size: number;
    keys: string[];
  } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }

  /**
   * Generate cache key from symbols array
   */
  private getCacheKey(symbols: string[]): string {
    return symbols.sort().join(',');
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
   * Utility: Sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
