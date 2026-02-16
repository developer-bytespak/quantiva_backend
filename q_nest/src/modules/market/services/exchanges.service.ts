import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class ExchangesService {
  private readonly logger = new Logger(ExchangesService.name);
  private readonly apiKey: string | null;
  private readonly baseUrl = 'https://pro-api.coingecko.com/api/v3';

  // Cache for Binance coins list
  private binanceCoinCache: string[] | null = null;
  private cacheTimestamp: number | null = null;
  private readonly CACHE_DURATION = 60 * 60 * 1000; // 1 hour

  // Cache for Binance coins with USDT pairs
  private binanceCoinUsdtCache: string[] | null = null;
  private cacheTimestampUsdt: number | null = null;

  constructor(private configService: ConfigService) {
    this.apiKey = this.configService.get<string>('COINGECKO_API_KEY') || null;
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
              'x-cg-pro-api-key': this.apiKey,
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
              'x-cg-pro-api-key': this.apiKey,
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
   * Clear the cached Binance coins (useful for manual refresh)
   */
  clearCache(): void {
    this.binanceCoinCache = null;
    this.cacheTimestamp = null;
    this.binanceCoinUsdtCache = null;
    this.cacheTimestampUsdt = null;
    this.logger.log('Cleared Binance coins cache (all coins and USDT pairs)');
  }
}
