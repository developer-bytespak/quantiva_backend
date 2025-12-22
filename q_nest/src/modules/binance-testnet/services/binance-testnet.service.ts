import { Injectable, Logger } from '@nestjs/common';
import { TestnetCacheService } from './testnet-cache.service';
import { BinanceTestnetService as BinanceTestnetApiService } from '../integrations/binance-testnet.service';
import {
  AccountTestnetBalanceDto,
  TestnetOrderDto,
  TestnetTickerPriceDto,
  TestnetOrderBookDto,
  TestnetRecentTradeDto,
} from '../dto/testnet-data.dto';
import { binanceTestnetConfig } from '../../../config/binance-testnet.config';

@Injectable()
export class BinanceTestnetService {
  private readonly logger = new Logger(BinanceTestnetService.name);
  private readonly apiKey = binanceTestnetConfig.apiKey;
  private readonly apiSecret = binanceTestnetConfig.apiSecret;

  constructor(
    private cacheService: TestnetCacheService,
    private binanceTestnetApi: BinanceTestnetApiService,
  ) {
    if (!this.apiKey || !this.apiSecret) {
      this.logger.warn(
        'Binance testnet credentials not configured. Set TESTNET_API_KEY and TESTNET_API_SECRET environment variables.',
      );
    }
  }

  /**
   * Checks if testnet is properly configured
   */
  isConfigured(): boolean {
    return !!this.apiKey && !!this.apiSecret;
  }

  /**
   * Gets configuration status
   */
  getStatus() {
    return {
      configured: this.isConfigured(),
      apiKeySet: !!this.apiKey,
      apiSecretSet: !!this.apiSecret,
    };
  }

  /**
   * Verifies the testnet connection
   */
  async verifyConnection(): Promise<boolean> {
    try {
      if (!this.isConfigured()) {
        this.logger.error('Testnet not configured');
        return false;
      }

      const isValid = await this.binanceTestnetApi.testConnection(this.apiKey, this.apiSecret);
      this.logger.log(`Testnet connection verification: ${isValid ? 'Success' : 'Failed'}`);
      return isValid;
    } catch (error) {
      this.logger.error(`Failed to verify testnet connection: ${error.message}`);
      return false;
    }
  }

  /**
   * Gets account balance
   */
  async getAccountBalance(): Promise<AccountTestnetBalanceDto> {
    if (!this.isConfigured()) {
      throw new Error('Testnet not configured');
    }

    const cacheKey = 'testnet:balance';

    // Try cache first
    const cached = this.cacheService.get(cacheKey);
    if (cached) {
      return cached;
    }

    const balance = await this.binanceTestnetApi.getAccountBalance(this.apiKey, this.apiSecret);

    // Cache result
    this.cacheService.set(cacheKey, balance, 5000);

    return balance;
  }

  /**
   * Gets open orders
   */
  async getOpenOrders(symbol?: string): Promise<TestnetOrderDto[]> {
    if (!this.isConfigured()) {
      throw new Error('Testnet not configured');
    }

    const cacheKey = `testnet:orders:${symbol || 'all'}`;

    // Try cache first
    const cached = this.cacheService.get(cacheKey);
    if (cached) {
      return cached;
    }

    const orders = await this.binanceTestnetApi.getOpenOrders(this.apiKey, this.apiSecret, symbol);

    // Cache result
    this.cacheService.set(cacheKey, orders, 5000);

    return orders;
  }

  /**
   * Gets all orders (including filled) with comprehensive filters
   */
  async getAllOrders(filters: {
    symbol?: string;
    status?: string;
    side?: string;
    type?: string;
    orderId?: number;
    startTime?: number;
    endTime?: number;
    limit?: number;
  }): Promise<TestnetOrderDto[]> {
    if (!this.isConfigured()) {
      throw new Error('Testnet not configured');
    }

    const cacheKey = `testnet:allorders:${JSON.stringify(filters)}`;

    // Try cache first
    const cached = this.cacheService.get(cacheKey);
    if (cached) {
      return cached;
    }

    const orders = await this.binanceTestnetApi.getAllOrders(
      this.apiKey,
      this.apiSecret,
      filters,
    );

    // Cache result for shorter time since this includes recent activity
    this.cacheService.set(cacheKey, orders, 3000);

    return orders;
  }

  /**
   * Places an order on testnet
   */
  async placeOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    type: 'MARKET' | 'LIMIT',
    quantity: number,
    price?: number,
  ): Promise<TestnetOrderDto> {
    if (!this.isConfigured()) {
      throw new Error('Testnet not configured');
    }

    const order = await this.binanceTestnetApi.placeOrder(
      this.apiKey,
      this.apiSecret,
      symbol,
      side,
      type,
      quantity,
      price,
    );

    // Invalidate orders cache
    this.cacheService.invalidatePattern('testnet:orders');

    return order;
  }

  /**
   * Cancels an order
   */
  async cancelOrder(symbol: string, orderId: number): Promise<TestnetOrderDto> {
    if (!this.isConfigured()) {
      throw new Error('Testnet not configured');
    }

    const order = await this.binanceTestnetApi.cancelOrder(this.apiKey, this.apiSecret, symbol, orderId);

    // Invalidate orders cache
    this.cacheService.invalidatePattern('testnet:orders');

    return order;
  }

  /**
   * Gets ticker price
   */
  async getTickerPrice(symbol: string): Promise<TestnetTickerPriceDto> {
    const cacheKey = `testnet:ticker:${symbol}`;

    const cached = this.cacheService.get(cacheKey);
    if (cached) {
      return cached;
    }

    const ticker = await this.binanceTestnetApi.getTickerPrice(symbol);

    this.cacheService.set(cacheKey, ticker, 3000);

    return ticker;
  }

  /**
   * Gets order book
   */
  async getOrderBook(symbol: string, limit?: number): Promise<TestnetOrderBookDto> {
    const cacheKey = `testnet:orderbook:${symbol}:${limit || 20}`;

    const cached = this.cacheService.get(cacheKey);
    if (cached) {
      return cached;
    }

    const orderBook = await this.binanceTestnetApi.getOrderBook(symbol, limit);

    this.cacheService.set(cacheKey, orderBook, 3000);

    return orderBook;
  }

  /**
   * Gets recent trades
   */
  async getRecentTrades(symbol: string, limit?: number): Promise<TestnetRecentTradeDto[]> {
    const cacheKey = `testnet:trades:${symbol}:${limit || 10}`;

    const cached = this.cacheService.get(cacheKey);
    if (cached) {
      return cached;
    }

    const trades = await this.binanceTestnetApi.getRecentTrades(symbol, limit);

    this.cacheService.set(cacheKey, trades, 3000);

    return trades;
  }

  /**
   * Gets 24h ticker data
   */
  async get24hTicker(symbol: string): Promise<any> {
    const cacheKey = `testnet:ticker24h:${symbol}`;

    const cached = this.cacheService.get(cacheKey);
    if (cached) {
      return cached;
    }

    const ticker = await this.binanceTestnetApi.get24hTicker(symbol);

    this.cacheService.set(cacheKey, ticker, 5000);

    return ticker;
  }

  /**
   * Gets candlestick data
   */
  async getCandlestick(symbol: string, interval?: string, limit?: number): Promise<any[]> {
    const cacheKey = `testnet:candles:${symbol}:${interval || '1h'}:${limit || 100}`;

    const cached = this.cacheService.get(cacheKey);
    if (cached) {
      return cached;
    }

    const candles = await this.binanceTestnetApi.getCandlestick(symbol, interval, limit);

    this.cacheService.set(cacheKey, candles, 10000); // Cache for longer as historical data

    return candles;
  }

  /**
   * Gets dashboard data (combined balance, orders, prices)
   */
  async getDashboardData(symbols: string[]): Promise<any> {
    const cacheKey = 'testnet:dashboard';

    const cached = this.cacheService.get(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const [balance, openOrders] = await Promise.all([
        this.getAccountBalance(),
        this.getOpenOrders(),
      ]);

      const tickerPrices = await Promise.all(
        symbols.map((symbol) => this.getTickerPrice(symbol).catch(() => null)),
      );

      const dashboardData = {
        balance,
        openOrders,
        tickerPrices: tickerPrices.filter(Boolean),
        lastUpdated: new Date(),
      };

      this.cacheService.set(cacheKey, dashboardData, 5000);

      return dashboardData;
    } catch (error) {
      this.logger.error(`Failed to get dashboard data: ${error.message}`);
      throw error;
    }
  }
}
