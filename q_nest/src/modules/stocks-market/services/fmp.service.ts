/**
 * FMP (Financial Modeling Prep) Service
 * 
 * NOTE: FMP deprecated v3 API endpoints on August 31, 2025.
 * Legacy endpoints are only available to users with subscriptions prior to that date.
 * 
 * To update to the new API:
 * 1. Visit https://site.financialmodelingprep.com/developer/docs
 * 2. Check the new API endpoint structure
 * 3. Update baseURL and endpoint paths in this file
 * 4. Update the FmpQuote interface if the response format changed
 */
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

    // FMP new API structure (as of Aug 31, 2025)
    // New base URL: https://financialmodelingprep.com/stable/
    // Documentation: https://site.financialmodelingprep.com/developer/docs
    this.apiClient = axios.create({
      baseURL: 'https://financialmodelingprep.com/stable',
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        // API key can be in header or query param - using header for cleaner URLs
        ...(this.apiKey ? { apikey: this.apiKey } : {}),
      },
    });

    if (this.apiKey) {
      const keyLength = this.apiKey.length;
      const keyPreview = keyLength > 4 ? `${this.apiKey.substring(0, 4)}...` : '***';
      this.logger.log(`FMP Service initialized with API key (${keyPreview}, length: ${keyLength})`);
      
      // Validate API key format (FMP keys are typically 32+ characters)
      if (keyLength < 10) {
        this.logger.warn('FMP API key seems too short - please verify it is correct');
      }
    } else {
      this.logger.warn('FMP Service initialized WITHOUT API key - market cap data will not be available');
    }
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

    // Check if API key is configured
    if (!this.apiKey) {
      this.logger.warn('FMP API key not configured - skipping market cap fetch');
      return results;
    }

    try {
      const symbolsParam = symbols.join(',');
      this.logger.log(`Fetching FMP data for symbols: ${symbolsParam}`);
      
      // New FMP API: Use profile endpoint which includes market cap
      // For single symbol: /profile?symbol=AAPL
      // For multiple: fetch individually or use batch if available
      // Note: Profile endpoint might be single-symbol only, so we'll fetch individually
      
      if (symbols.length === 1) {
        // Single symbol - use profile endpoint
        const response = await this.apiClient.get<any>(`/profile`, {
          params: {
            symbol: symbols[0],
            ...(this.apiKey ? { apikey: this.apiKey } : {}),
          },
        });

        if (response.data && Array.isArray(response.data) && response.data.length > 0) {
          const profile = response.data[0];
          // Convert profile to FmpQuote format
          const quote: FmpQuote = {
            symbol: profile.symbol,
            name: profile.companyName || profile.name,
            price: profile.price || 0,
            changesPercentage: profile.changesPercentage || 0,
            change: profile.changes || 0,
            dayLow: profile.range?.split('-')[0] || profile.dayLow || 0,
            dayHigh: profile.range?.split('-')[1] || profile.dayHigh || 0,
            yearHigh: profile.range52Week?.split('-')[1] || profile.yearHigh || 0,
            yearLow: profile.range52Week?.split('-')[0] || profile.yearLow || 0,
            marketCap: profile.mktCap || profile.marketCap || 0,
            priceAvg50: profile.priceAvg50 || 0,
            priceAvg200: profile.priceAvg200 || 0,
            volume: profile.volume || 0,
            avgVolume: profile.avgVolume || 0,
            open: profile.open || 0,
            previousClose: profile.previousClose || 0,
            eps: profile.eps || 0,
            pe: profile.pe || 0,
            earningsAnnouncement: profile.earningsAnnouncement || '',
            sharesOutstanding: profile.sharesOutstanding || 0,
            timestamp: Date.now(),
          };
          results.set(quote.symbol, quote);
          this.logger.log(`FMP profile data for ${quote.symbol}: marketCap=${quote.marketCap}, price=${quote.price}`);
        }
      } else {
        // Multiple symbols - fetch individually (FMP profile might not support batch)
        this.logger.log(`Fetching ${symbols.length} symbols individually...`);
        const profilePromises = symbols.map(async (symbol) => {
          try {
            const response = await this.apiClient.get<any>(`/profile`, {
              params: {
                symbol,
                ...(this.apiKey ? { apikey: this.apiKey } : {}),
              },
            });

            if (response.data && Array.isArray(response.data) && response.data.length > 0) {
              const profile = response.data[0];
              const quote: FmpQuote = {
                symbol: profile.symbol,
                name: profile.companyName || profile.name,
                price: profile.price || 0,
                changesPercentage: profile.changesPercentage || 0,
                change: profile.changes || 0,
                dayLow: profile.range?.split('-')[0] || profile.dayLow || 0,
                dayHigh: profile.range?.split('-')[1] || profile.dayHigh || 0,
                yearHigh: profile.range52Week?.split('-')[1] || profile.yearHigh || 0,
                yearLow: profile.range52Week?.split('-')[0] || profile.yearLow || 0,
                marketCap: profile.mktCap || profile.marketCap || 0,
                priceAvg50: profile.priceAvg50 || 0,
                priceAvg200: profile.priceAvg200 || 0,
                volume: profile.volume || 0,
                avgVolume: profile.avgVolume || 0,
                open: profile.open || 0,
                previousClose: profile.previousClose || 0,
                eps: profile.eps || 0,
                pe: profile.pe || 0,
                earningsAnnouncement: profile.earningsAnnouncement || '',
                sharesOutstanding: profile.sharesOutstanding || 0,
                timestamp: Date.now(),
              };
              return quote;
            }
          } catch (err: any) {
            this.logger.warn(`Failed to fetch profile for ${symbol}: ${err?.message}`);
            return null;
          }
          return null;
        });

        const quotes = await Promise.all(profilePromises);
        quotes.forEach((quote) => {
          if (quote) {
            results.set(quote.symbol, quote);
            this.logger.log(`FMP profile data for ${quote.symbol}: marketCap=${quote.marketCap}`);
          }
        });
      }

      this.logger.log(`Successfully fetched FMP data for ${results.size}/${symbols.length} symbols`);
      return results;
    } catch (error: any) {

      if (error?.response?.status === 429) {
        this.logger.error('FMP API rate limit exceeded');
        throw new Error('FMP API rate limit exceeded');
      }

      if (error?.response?.status === 401 || error?.response?.status === 403) {
        const errorMessage = error?.response?.data?.Error || error?.response?.data?.message || error?.response?.data || error?.message;
        const fullErrorBody = error?.response?.data;
        
        this.logger.error('FMP API authentication/authorization failed', {
          status: error?.response?.status,
          statusText: error?.response?.statusText,
          error: errorMessage,
          fullResponse: JSON.stringify(fullErrorBody),
          apiKeyLength: this.apiKey?.length || 0,
          apiKeyPreview: this.apiKey ? `${this.apiKey.substring(0, 4)}...` : 'NOT SET',
          url: error?.config?.url,
          params: error?.config?.params,
        });
        
        throw new Error(`FMP API error: ${errorMessage || 'Unknown error'}`);
      }

      this.logger.error(`FMP API error: ${error?.message}`, {
        status: error?.response?.status,
        data: error?.response?.data,
        url: error?.config?.url,
      });
      throw new Error(`FMP API error: ${error?.message || 'Unknown error'}`);
    }
  }

  /**
   * Get company profile (alternative endpoint with more details)
   * New API structure: /stable/profile?symbol=AAPL
   */
  async getCompanyProfile(symbol: string): Promise<any> {
    try {
      const response = await this.apiClient.get(`/profile`, {
        params: {
          symbol,
          ...(this.apiKey ? { apikey: this.apiKey } : {}),
        },
      });

      return response.data && Array.isArray(response.data) ? response.data[0] || null : null;
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
  async healthCheck(): Promise<{ online: boolean; message?: string; details?: any }> {
    if (!this.apiKey) {
      return { online: false, message: 'FMP API key not configured' };
    }

    try {
      // Test with a simple quote request using new API structure
      const response = await this.apiClient.get('/quote', {
        params: {
          symbol: 'AAPL',
          ...(this.apiKey ? { apikey: this.apiKey } : {}),
        },
      });

      if (response.data && Array.isArray(response.data) && response.data.length > 0) {
        this.logger.log('FMP health check passed');
        return { online: true };
      }

      return { 
        online: false, 
        message: 'Invalid response format or empty data',
        details: { responseType: typeof response.data, isArray: Array.isArray(response.data) }
      };
    } catch (error: any) {
      const errorMessage = error?.response?.data?.['Error Message'] || error?.response?.data?.Error || error?.response?.data?.message || error?.message;
      const errorDetails = {
        status: error?.response?.status,
        statusText: error?.response?.statusText,
        errorMessage,
        url: error?.config?.url,
      };
      
      this.logger.error(`FMP health check failed:`, errorDetails);
      
      // Check if it's a deprecation error
      if (error?.response?.status === 403 && (errorMessage?.includes('Legacy') || errorMessage?.includes('no longer supported'))) {
        return {
          online: false,
          message: 'FMP v3 API is deprecated. Please use the new API endpoints.',
          details: {
            ...errorDetails,
            note: 'Visit https://site.financialmodelingprep.com/developer/docs for new API documentation',
          },
        };
      }
      
      return {
        online: false,
        message: errorMessage || 'FMP API unreachable',
        details: errorDetails,
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
