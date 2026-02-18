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

    if (!this.apiKey) {
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
        return cached.data;
      }

      const batches = this.chunkArray(symbols, this.maxBatchSize);

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

      // New FMP API: Use profile endpoint which includes market cap
      // For single symbol: /profile?symbol=AAPL
      // For multiple: fetch individually or use batch if available
      // Note: Profile endpoint might be single-symbol only, so we'll fetch individually
      
      if (symbols.length === 1) {
        // Single symbol - use profile endpoint
        try {
          const response = await this.apiClient.get<any>(`/profile`, {
            params: {
              symbol: symbols[0],
              ...(this.apiKey ? { apikey: this.apiKey } : {}),
            },
          });

          // Handle different response formats
          let profile: any = null;
          if (Array.isArray(response.data) && response.data.length > 0) {
            profile = response.data[0];
          } else if (response.data && typeof response.data === 'object' && !Array.isArray(response.data)) {
            // Single object response
            profile = response.data;
          }

          if (profile && profile.symbol) {
            // Convert profile to FmpQuote format
            const quote: FmpQuote = {
              symbol: profile.symbol,
              name: profile.companyName || profile.name || profile.symbol,
              price: Number(profile.price) || 0,
              changesPercentage: Number(profile.changesPercentage) || 0,
              change: Number(profile.changes) || 0,
              dayLow: profile.range ? Number(profile.range.split('-')[0]) : (Number(profile.dayLow) || 0),
              dayHigh: profile.range ? Number(profile.range.split('-')[1]) : (Number(profile.dayHigh) || 0),
              yearHigh: profile.range52Week ? Number(profile.range52Week.split('-')[1]) : (Number(profile.yearHigh) || 0),
              yearLow: profile.range52Week ? Number(profile.range52Week.split('-')[0]) : (Number(profile.yearLow) || 0),
              marketCap: Number(profile.mktCap || profile.marketCap || 0),
              priceAvg50: Number(profile.priceAvg50) || 0,
              priceAvg200: Number(profile.priceAvg200) || 0,
              volume: Number(profile.volume) || 0,
              avgVolume: Number(profile.avgVolume) || 0,
              open: Number(profile.open) || 0,
              previousClose: Number(profile.previousClose) || 0,
              eps: Number(profile.eps) || 0,
              pe: Number(profile.pe) || 0,
              earningsAnnouncement: profile.earningsAnnouncement || '',
              sharesOutstanding: Number(profile.sharesOutstanding) || 0,
              timestamp: Date.now(),
            };
            results.set(quote.symbol, quote);
          }
        } catch (profileError: any) {
          this.logger.error(`Failed to fetch FMP profile for ${symbols[0]}:`, {
            error: profileError?.message,
            status: profileError?.response?.status,
            data: profileError?.response?.data,
          });
          // Don't throw - gracefully return empty results
        }
      } else {
        // Multiple symbols - fetch in smaller batches with rate limiting
        // FMP free tier has strict rate limits (typically 250 requests/day)
        // Process in batches of 5 with delays to avoid hitting limits
        const batchSize = 5;
        const delayBetweenBatches = 2000;

        for (let i = 0; i < symbols.length; i += batchSize) {
          const batch = symbols.slice(i, i + batchSize);
          
          const batchPromises = batch.map(async (symbol, batchIndex) => {
            // Add small delay between requests in same batch
            if (batchIndex > 0) {
              await this.sleep(200);
            }
            
            // Retry logic for rate limit errors
            let lastError: any = null;
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                const response = await this.apiClient.get<any>(`/profile`, {
                  params: {
                    symbol,
                    ...(this.apiKey ? { apikey: this.apiKey } : {}),
                  },
                });

              // Handle different response formats
              let profile: any = null;
              if (Array.isArray(response.data) && response.data.length > 0) {
                profile = response.data[0];
              } else if (response.data && typeof response.data === 'object' && !Array.isArray(response.data)) {
                profile = response.data;
              }

              if (profile && profile.symbol) {
                const quote: FmpQuote = {
                  symbol: profile.symbol,
                  name: profile.companyName || profile.name || profile.symbol,
                  price: Number(profile.price) || 0,
                  changesPercentage: Number(profile.changesPercentage) || 0,
                  change: Number(profile.changes) || 0,
                  dayLow: profile.range ? Number(profile.range.split('-')[0]) : (Number(profile.dayLow) || 0),
                  dayHigh: profile.range ? Number(profile.range.split('-')[1]) : (Number(profile.dayHigh) || 0),
                  yearHigh: profile.range52Week ? Number(profile.range52Week.split('-')[1]) : (Number(profile.yearHigh) || 0),
                  yearLow: profile.range52Week ? Number(profile.range52Week.split('-')[0]) : (Number(profile.yearLow) || 0),
                  marketCap: Number(profile.mktCap || profile.marketCap || 0),
                  priceAvg50: Number(profile.priceAvg50) || 0,
                  priceAvg200: Number(profile.priceAvg200) || 0,
                  volume: Number(profile.volume) || 0,
                  avgVolume: Number(profile.avgVolume) || 0,
                  open: Number(profile.open) || 0,
                  previousClose: Number(profile.previousClose) || 0,
                  eps: Number(profile.eps) || 0,
                  pe: Number(profile.pe) || 0,
                  earningsAnnouncement: profile.earningsAnnouncement || '',
                  sharesOutstanding: Number(profile.sharesOutstanding) || 0,
                  timestamp: Date.now(),
                };
                return quote;
              }
              return null;
            } catch (err: any) {
              lastError = err;
              
                if (err?.response?.status === 429) {
                  const waitTime = Math.min(2000 * Math.pow(2, attempt - 1), 15000);
                  if (attempt < 3) {
                    await this.sleep(waitTime);
                    continue;
                  }
                }
                
                // For other errors or final attempt, break
                break;
              }
            }
            
            return null;
          });

          const batchQuotes = await Promise.all(batchPromises);
          batchQuotes.forEach((quote) => {
            if (quote) {
              results.set(quote.symbol, quote);
            }
          });
          
          // Wait between batches to avoid rate limits
          if (i + batchSize < symbols.length) {
            await this.sleep(delayBetweenBatches);
          }
        }
      }

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
   * Fetch S&P 500 constituents list from FMP API
   * Returns array of stock symbols with name and sector
   * Tries multiple FMP API endpoints to find the correct one
   */
  async getSP500Constituents(): Promise<Array<{
    symbol: string;
    name: string;
    sector: string;
  }>> {
    if (!this.apiKey) {
      this.logger.warn('FMP API key not configured - cannot fetch S&P 500 list');
      return [];
    }

    try {
      this.logger.log('Fetching S&P 500 constituents from FMP API...');
      
      // Try multiple endpoints in order of preference
      const endpoints = [
        { path: '/sp500_constituent', description: 'S&P 500 specific endpoint' },
        { path: '/stock/list', params: { exchange: 'NASDAQ,NYSE' }, description: 'Stock list endpoint' },
        { path: '/stock-screener', params: { marketCapMoreThan: 1000000000 }, description: 'Stock screener endpoint' },
      ];

      let response: any = null;
      let lastError: any = null;

      for (const endpoint of endpoints) {
        try {
          this.logger.log(`Trying FMP endpoint: ${endpoint.path} (${endpoint.description})`);
          
          // Retry logic for rate limit errors
          let retryCount = 0;
          const maxRetries = 3;
          
          while (retryCount < maxRetries) {
            try {
              response = await this.apiClient.get<any>(endpoint.path, {
                params: {
                  ...(endpoint.params || {}),
                  ...(this.apiKey ? { apikey: this.apiKey } : {}),
                },
              });

              if (response && response.data) {
                this.logger.log(`Successfully fetched data from ${endpoint.path}`);
                break;
              }
              break; // Success, exit retry loop
            } catch (error: any) {
              lastError = error;
              
              // If rate limited, wait and retry
              if (error?.response?.status === 429 && retryCount < maxRetries - 1) {
                const waitTime = Math.min(2000 * Math.pow(2, retryCount), 10000); // Exponential backoff
                this.logger.warn(
                  `Rate limited on ${endpoint.path}, waiting ${waitTime}ms before retry ${retryCount + 2}/${maxRetries}`,
                );
                await this.sleep(waitTime);
                retryCount++;
                continue;
              }
              
              // Other errors or final retry failed
              this.logger.warn(`Endpoint ${endpoint.path} failed: ${error?.message}`);
              break; // Exit retry loop, try next endpoint
            }
          }
          
          // If we got a successful response, break out of endpoint loop
          if (response && response.data) {
            break;
          }
        } catch (error: any) {
          lastError = error;
          this.logger.warn(`Endpoint ${endpoint.path} failed: ${error?.message}`);
          // Continue to next endpoint
          continue;
        }
      }

      if (!response || !response.data) {
        throw new Error(
          `All FMP endpoints failed. Last error: ${lastError?.message || 'Unknown'}`,
        );
      }

      let stocks: any[] = [];
      
      // Handle different response formats
      if (Array.isArray(response.data)) {
        stocks = response.data;
      } else if (response.data && typeof response.data === 'object') {
        // Single object or wrapped response
        if (Array.isArray(response.data.data)) {
          stocks = response.data.data;
        } else if (Array.isArray(response.data.stocks)) {
          stocks = response.data.stocks;
        } else if (Array.isArray(response.data.symbols)) {
          stocks = response.data.symbols;
        } else {
          stocks = [response.data];
        }
      }

      if (stocks.length === 0) {
        this.logger.warn('No stocks returned from FMP API');
        return [];
      }

      // Map to our format and filter valid symbols
      const constituents = stocks
        .filter((stock: any) => {
          const symbol = stock.symbol || stock.Symbol || stock.ticker;
          return symbol && typeof symbol === 'string' && symbol.length > 0 && symbol.length <= 10;
        })
        .map((stock: any) => {
          const symbol = (stock.symbol || stock.Symbol || stock.ticker || '').toUpperCase().trim();
          const name = stock.name || stock.Name || stock.companyName || stock.company_name || symbol;
          const sector = stock.sector || stock.Sector || stock.industry || stock.Industry || 'Unknown';
          
          return {
            symbol,
            name: String(name),
            sector: String(sector),
          };
        })
        // Remove duplicates by symbol
        .filter((stock, index, self) => 
          index === self.findIndex((s) => s.symbol === stock.symbol)
        );

      this.logger.log(
        `Successfully fetched ${constituents.length} S&P 500 constituents from FMP`,
      );
      
      return constituents;
    } catch (error: any) {
      this.logger.error('Failed to fetch S&P 500 constituents from FMP', {
        error: error?.message,
        status: error?.response?.status,
        url: error?.config?.url,
        responseData: error?.response?.data,
      });
      
      // Return empty array on error - will fallback to hardcoded list
      return [];
    }
  }

  /**
   * Utility: Sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
