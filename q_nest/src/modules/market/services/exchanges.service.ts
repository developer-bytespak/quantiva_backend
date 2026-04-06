import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class ExchangesService implements OnModuleInit {
  private readonly logger = new Logger(ExchangesService.name);
  private readonly apiKey: string | null;
  private readonly baseUrl: string;
  private readonly isProApiKey: boolean;

  // Cache for Binance coins list
  private binanceCoinCache: string[] | null = null;
  private cacheTimestamp: number | null = null;
  private readonly CACHE_DURATION = 60 * 60 * 1000; // 1 hour

  // Cache for Binance coins with USDT pairs
  private binanceCoinUsdtCache: string[] | null = null;
  private cacheTimestampUsdt: number | null = null;

  // Cache for Binance US coins list
  private binanceUSCoinCache: string[] | null = null;
  private binanceUSCacheTimestamp: number | null = null;

  // Cache for Binance US coins with USD/USDT pairs
  private binanceUSPreferredQuoteCache: string[] | null = null;
  private binanceUSPreferredQuoteCacheTimestamp: number | null = null;

  // Cache for Bybit coins list
  private bybitCoinCache: string[] | null = null;
  private bybitCacheTimestamp: number | null = null;

  // Cache for Bybit coins with USDT pairs
  private bybitCoinUsdtCache: string[] | null = null;
  private bybitCacheTimestampUsdt: number | null = null;

  constructor(private configService: ConfigService) {
    this.apiKey = this.configService.get<string>('COINGECKO_API_KEY') || null;
    this.isProApiKey = !!(this.apiKey && this.apiKey.startsWith('CG-'));
    this.baseUrl = this.isProApiKey
      ? 'https://pro-api.coingecko.com/api/v3'
      : 'https://api.coingecko.com/api/v3';
    this.logger.log(
      `CoinGecko API initialized: ${this.isProApiKey ? 'Pro API' : 'Free API'}`,
    );
  }

  /**
   * Warm the exchange coin caches on startup so user requests never trigger CoinGecko calls.
   * Failures are non-fatal — the cache will be populated on the next cron cycle or user request.
   */
  async onModuleInit() {
    try {
      this.logger.log('Warming Binance coin cache on startup...');
      await this.getBinanceCoinsWithUsdtPairs();
      this.logger.log('Binance coin cache warmed successfully');
    } catch (error: any) {
      this.logger.warn(`Failed to warm Binance cache on startup: ${error.message}`);
    }
  }

  /**
   * Get all coins available on Binance from CoinGecko Pro API
   * Paginates through the API and removes duplicates using a Set
   */
  async getAllBinanceCoins(): Promise<string[]> {
    const now = Date.now();

    // Check cache
    if (
      this.binanceCoinCache &&
      this.cacheTimestamp &&
      now - this.cacheTimestamp < this.CACHE_DURATION
    ) {
      this.logger.log('Using cached Binance coins');
      return this.binanceCoinCache;
    }

    // Fetch fresh data
    const coins = await this.fetchBinanceCoinsFromAPI();

    // Update cache
    this.binanceCoinCache = coins;
    this.cacheTimestamp = now;

    return coins;
  }

  /**
   * Fetch Binance coins from CoinGecko Pro API with pagination
   */
  private async fetchBinanceCoinsFromAPI(): Promise<string[]> {
    if (!this.apiKey) {
      const errorMsg =
        'CoinGecko API key not configured. Set COINGECKO_API_KEY environment variable.';
      this.logger.error(errorMsg);
      throw new Error(errorMsg);
    }

    const allCoins = new Set<string>();
    let page = 1;
    let hasMorePages = true;

    while (hasMorePages) {
      try {
        this.logger.log(`Fetching Binance tickers page ${page}...`);

        const response = await axios.get(
          `${this.baseUrl}/exchanges/binance/tickers`,
          {
            headers: {
              ...(this.isProApiKey && this.apiKey
                ? { 'x-cg-pro-api-key': this.apiKey }
                : {}),
            },
            params: {
              page,
              per_page: 100,
            },
            timeout: 30000,
          },
        );

        const tickers = response.data.tickers || [];

        if (tickers.length === 0) {
          hasMorePages = false;
          break;
        }

        // Extract coin IDs from each ticker
        tickers.forEach((ticker: any) => {
          if (ticker.coin_id) {
            allCoins.add(ticker.coin_id);
          }
        });

        page++;

        // Rate limiting: wait between requests
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (error: any) {
        this.logger.error(
          `Error fetching page ${page}: ${error.message}`,
          error.response?.data || error,
        );
        if (page === 1) {
          throw error; // Fail on first page - no data to return
        }
        break; // Stop if we already have some data from previous pages
      }
    }

    this.logger.log(
      `Successfully fetched ${allCoins.size} unique coins from Binance`,
    );
    return Array.from(allCoins);
  }

  /**
   * Get Binance coins that have USDT trading pairs
   * Filters tickers to only include those with USDT as target
   */
  async getBinanceCoinsWithUsdtPairs(): Promise<string[]> {
    const now = Date.now();

    // Check cache
    if (
      this.binanceCoinUsdtCache &&
      this.cacheTimestampUsdt &&
      now - this.cacheTimestampUsdt < this.CACHE_DURATION
    ) {
      this.logger.log('Using cached Binance coins with USDT pairs');
      return this.binanceCoinUsdtCache;
    }

    // Fetch fresh data
    const coins = await this.fetchBinanceCoinsUsdtFromAPI();

    // Update cache
    this.binanceCoinUsdtCache = coins;
    this.cacheTimestampUsdt = now;

    return coins;
  }

  /**
   * Fetch Binance coins with USDT pairs from CoinGecko Pro API
   * Filters to only include tickers where target is USDT
   */
  private async fetchBinanceCoinsUsdtFromAPI(): Promise<string[]> {
    if (!this.apiKey) {
      const errorMsg =
        'CoinGecko API key not configured. Set COINGECKO_API_KEY environment variable.';
      this.logger.error(errorMsg);
      throw new Error(errorMsg);
    }

    const coinsWithUsdt = new Set<string>();
    let page = 1;
    let hasMorePages = true;

    while (hasMorePages) {
      try {
        this.logger.log(`Fetching Binance USDT pairs page ${page}...`);

        const response = await axios.get(
          `${this.baseUrl}/exchanges/binance/tickers`,
          {
            headers: {
              ...(this.isProApiKey && this.apiKey
                ? { 'x-cg-pro-api-key': this.apiKey }
                : {}),
            },
            params: {
              page,
              per_page: 100,
            },
            timeout: 30000,
          },
        );

        const tickers = response.data.tickers || [];

        if (tickers.length === 0) {
          hasMorePages = false;
          break;
        }

        // Extract coin IDs only for USDT pairs
        tickers.forEach((ticker: any) => {
          if (ticker.coin_id && ticker.target === 'USDT') {
            coinsWithUsdt.add(ticker.coin_id);
          }
        });

        page++;

        // Rate limiting: wait between requests
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (error: any) {
        this.logger.error(
          `Error fetching USDT pairs page ${page}: ${error.message}`,
          error.response?.data || error,
        );
        if (page === 1) {
          throw error; // Fail on first page - no data to return
        }
        break; // Stop if we already have some data from previous pages
      }
    }

    this.logger.log(
      `Successfully fetched ${coinsWithUsdt.size} unique coins with USDT pairs from Binance`,
    );
    return Array.from(coinsWithUsdt);
  }

  /**
   * Get all coins available on Binance US from CoinGecko Pro API
   */
  async getAllBinanceUSCoins(): Promise<string[]> {
    const now = Date.now();

    if (
      this.binanceUSCoinCache &&
      this.binanceUSCacheTimestamp &&
      now - this.binanceUSCacheTimestamp < this.CACHE_DURATION
    ) {
      this.logger.log('Using cached Binance US coins');
      return this.binanceUSCoinCache;
    }

    const coins = await this.fetchBinanceUSCoinsFromAPI();
    this.binanceUSCoinCache = coins;
    this.binanceUSCacheTimestamp = now;

    return coins;
  }

  /**
   * Fetch Binance US coins from CoinGecko Pro API with pagination
   */
  private async fetchBinanceUSCoinsFromAPI(): Promise<string[]> {
    if (!this.apiKey) {
      const errorMsg =
        'CoinGecko API key not configured. Set COINGECKO_API_KEY environment variable.';
      this.logger.error(errorMsg);
      throw new Error(errorMsg);
    }

    const allCoins = new Set<string>();
    let page = 1;
    let hasMorePages = true;

    while (hasMorePages) {
      try {
        this.logger.log(`Fetching Binance US tickers page ${page}...`);

        const response = await axios.get(
          `${this.baseUrl}/exchanges/binance_us/tickers`,
          {
            headers: {
              ...(this.isProApiKey && this.apiKey
                ? { 'x-cg-pro-api-key': this.apiKey }
                : {}),
            },
            params: {
              page,
              per_page: 100,
            },
            timeout: 30000,
          },
        );

        const tickers = response.data.tickers || [];

        if (tickers.length === 0) {
          hasMorePages = false;
          break;
        }

        tickers.forEach((ticker: any) => {
          if (ticker.coin_id) {
            allCoins.add(ticker.coin_id);
          }
        });

        page++;
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (error: any) {
        this.logger.error(
          `Error fetching Binance US page ${page}: ${error.message}`,
          error.response?.data || error,
        );
        if (page === 1) {
          throw error;
        }
        break;
      }
    }

    this.logger.log(
      `Successfully fetched ${allCoins.size} unique coins from Binance US`,
    );
    return Array.from(allCoins);
  }

  /**
   * Get Binance US coins with preferred quote pairs (USD first, then USDT)
   */
  async getBinanceUSCoinsWithPreferredQuotePairs(): Promise<string[]> {
    const now = Date.now();

    if (
      this.binanceUSPreferredQuoteCache &&
      this.binanceUSPreferredQuoteCacheTimestamp &&
      now - this.binanceUSPreferredQuoteCacheTimestamp < this.CACHE_DURATION
    ) {
      this.logger.log('Using cached Binance US coins with preferred quote pairs');
      return this.binanceUSPreferredQuoteCache;
    }

    const coins = await this.fetchBinanceUSCoinsPreferredQuotesFromAPI();
    this.binanceUSPreferredQuoteCache = coins;
    this.binanceUSPreferredQuoteCacheTimestamp = now;

    return coins;
  }

  /**
   * Fetch Binance US coins filtered to USD/USDT quote pairs
   */
  private async fetchBinanceUSCoinsPreferredQuotesFromAPI(): Promise<string[]> {
    if (!this.apiKey) {
      const errorMsg =
        'CoinGecko API key not configured. Set COINGECKO_API_KEY environment variable.';
      this.logger.error(errorMsg);
      throw new Error(errorMsg);
    }

    const preferredQuoteCoins = new Set<string>();
    const allowedQuotes = new Set(['USD', 'USDT']);
    let page = 1;
    let hasMorePages = true;

    while (hasMorePages) {
      try {
        this.logger.log(`Fetching Binance US preferred quote pairs page ${page}...`);

        const response = await axios.get(
          `${this.baseUrl}/exchanges/binance_us/tickers`,
          {
            headers: {
              ...(this.isProApiKey && this.apiKey
                ? { 'x-cg-pro-api-key': this.apiKey }
                : {}),
            },
            params: {
              page,
              per_page: 100,
            },
            timeout: 30000,
          },
        );

        const tickers = response.data.tickers || [];

        if (tickers.length === 0) {
          hasMorePages = false;
          break;
        }

        tickers.forEach((ticker: any) => {
          if (!ticker.coin_id || !ticker.target) {
            return;
          }

          if (allowedQuotes.has(String(ticker.target).toUpperCase())) {
            preferredQuoteCoins.add(ticker.coin_id);
          }
        });

        page++;
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (error: any) {
        this.logger.error(
          `Error fetching Binance US preferred pairs page ${page}: ${error.message}`,
          error.response?.data || error,
        );
        if (page === 1) {
          throw error;
        }
        break;
      }
    }

    this.logger.log(
      `Successfully fetched ${preferredQuoteCoins.size} unique coins with USD/USDT pairs from Binance US`,
    );
    return Array.from(preferredQuoteCoins);
  }

  /**
   * Get all coins available on Bybit from CoinGecko Pro API
   * Paginates through the API and removes duplicates using a Set
   */
  async getAllBybitCoins(): Promise<string[]> {
    const now = Date.now();

    // Check cache
    if (
      this.bybitCoinCache &&
      this.bybitCacheTimestamp &&
      now - this.bybitCacheTimestamp < this.CACHE_DURATION
    ) {
      this.logger.log('Using cached Bybit coins');
      return this.bybitCoinCache;
    }

    // Fetch fresh data
    const coins = await this.fetchBybitCoinsFromAPI();

    // Update cache
    this.bybitCoinCache = coins;
    this.bybitCacheTimestamp = now;

    return coins;
  }

  /**
   * Fetch Bybit coins from CoinGecko Pro API with pagination
   */
  private async fetchBybitCoinsFromAPI(): Promise<string[]> {
    if (!this.apiKey) {
      const errorMsg =
        'CoinGecko API key not configured. Set COINGECKO_API_KEY environment variable.';
      this.logger.error(errorMsg);
      throw new Error(errorMsg);
    }

    const allCoins = new Set<string>();
    let page = 1;
    let hasMorePages = true;

    while (hasMorePages) {
      try {
        this.logger.log(`Fetching Bybit tickers page ${page}...`);

        const response = await axios.get(
          `${this.baseUrl}/exchanges/bybit/tickers`,
          {
            headers: {
              ...(this.isProApiKey && this.apiKey
                ? { 'x-cg-pro-api-key': this.apiKey }
                : {}),
            },
            params: {
              page,
              per_page: 100,
            },
            timeout: 30000,
          },
        );

        const tickers = response.data.tickers || [];

        if (tickers.length === 0) {
          hasMorePages = false;
          break;
        }

        // Extract coin IDs from each ticker
        tickers.forEach((ticker: any) => {
          if (ticker.coin_id) {
            allCoins.add(ticker.coin_id);
          }
        });

        page++;

        // Rate limiting: wait between requests
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (error: any) {
        this.logger.error(
          `Error fetching page ${page}: ${error.message}`,
          error.response?.data || error,
        );
        if (page === 1) {
          throw error; // Fail on first page - no data to return
        }
        break; // Stop if we already have some data from previous pages
      }
    }

    this.logger.log(
      `Successfully fetched ${allCoins.size} unique coins from Bybit`,
    );
    return Array.from(allCoins);
  }

  /**
   * Get Bybit coins that have USDT trading pairs
   * Filters tickers to only include those with USDT as target
   */
  async getBybitCoinsWithUsdtPairs(): Promise<string[]> {
    const now = Date.now();

    // Check cache
    if (
      this.bybitCoinUsdtCache &&
      this.bybitCacheTimestampUsdt &&
      now - this.bybitCacheTimestampUsdt < this.CACHE_DURATION
    ) {
      this.logger.log('Using cached Bybit coins with USDT pairs');
      return this.bybitCoinUsdtCache;
    }

    // Fetch fresh data
    const coins = await this.fetchBybitCoinsUsdtFromAPI();

    // Update cache
    this.bybitCoinUsdtCache = coins;
    this.bybitCacheTimestampUsdt = now;

    return coins;
  }

  /**
   * Fetch Bybit coins with USDT pairs from CoinGecko Pro API
   * Filters to only include tickers where target is USDT
   */
  private async fetchBybitCoinsUsdtFromAPI(): Promise<string[]> {
    if (!this.apiKey) {
      const errorMsg =
        'CoinGecko API key not configured. Set COINGECKO_API_KEY environment variable.';
      this.logger.error(errorMsg);
      throw new Error(errorMsg);
    }

    const coinsWithUsdt = new Set<string>();
    let page = 1;
    let hasMorePages = true;

    while (hasMorePages) {
      try {
        this.logger.log(`Fetching Bybit USDT pairs page ${page}...`);

        const response = await axios.get(
          `${this.baseUrl}/exchanges/bybit/tickers`,
          {
            headers: {
              ...(this.isProApiKey && this.apiKey
                ? { 'x-cg-pro-api-key': this.apiKey }
                : {}),
            },
            params: {
              page,
              per_page: 100,
            },
            timeout: 30000,
          },
        );

        const tickers = response.data.tickers || [];

        if (tickers.length === 0) {
          hasMorePages = false;
          break;
        }

        // Extract coin IDs only for USDT pairs
        tickers.forEach((ticker: any) => {
          if (ticker.coin_id && ticker.target === 'USDT') {
            coinsWithUsdt.add(ticker.coin_id);
          }
        });

        page++;

        // Rate limiting: wait between requests
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (error: any) {
        this.logger.error(
          `Error fetching USDT pairs page ${page}: ${error.message}`,
          error.response?.data || error,
        );
        if (page === 1) {
          throw error; // Fail on first page - no data to return
        }
        break; // Stop if we already have some data from previous pages
      }
    }

    this.logger.log(
      `Successfully fetched ${coinsWithUsdt.size} unique coins with USDT pairs from Bybit`,
    );
    return Array.from(coinsWithUsdt);
  }

  /**
   * Clear the cached Binance and Bybit coins (useful for manual refresh)
   */
  clearCache(): void {
    this.binanceCoinCache = null;
    this.cacheTimestamp = null;
    this.binanceCoinUsdtCache = null;
    this.cacheTimestampUsdt = null;
    this.binanceUSCoinCache = null;
    this.binanceUSCacheTimestamp = null;
    this.binanceUSPreferredQuoteCache = null;
    this.binanceUSPreferredQuoteCacheTimestamp = null;
    this.bybitCoinCache = null;
    this.bybitCacheTimestamp = null;
    this.bybitCoinUsdtCache = null;
    this.bybitCacheTimestampUsdt = null;
    this.logger.log('Cleared Binance, Binance US, and Bybit coins cache (all coins and filtered pairs)');
  }
}
