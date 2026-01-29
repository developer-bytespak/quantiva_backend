import { Injectable, Logger } from '@nestjs/common';
import { TestnetCacheService } from './testnet-cache.service';
import { BinanceTestnetService as BinanceTestnetApiService } from '../integrations/binance-testnet.service';
import { PrismaService } from '../../../prisma/prisma.service';
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
  
  // Request deduplication - tracks pending API requests to avoid duplicate calls
  private pendingRequests: Map<string, Promise<any>> = new Map();

  constructor(
    private cacheService: TestnetCacheService,
    private binanceTestnetApi: BinanceTestnetApiService,
    private prisma: PrismaService,
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
   * Helper method to deduplicate concurrent requests
   * If a request is already pending, return the same promise instead of making a duplicate API call
   */
  private async deduplicatedRequest<T>(
    key: string,
    requestFn: () => Promise<T>,
  ): Promise<T> {
    // If a request is already pending for this key, return it
    if (this.pendingRequests.has(key)) {
      this.logger.debug(`Returning pending request for: ${key}`);
      return this.pendingRequests.get(key)!;
    }

    // Create the request promise
    const promise = requestFn()
      .finally(() => {
        // Clean up the pending request after completion
        this.pendingRequests.delete(key);
      });

    // Store it so concurrent requests can reuse it
    this.pendingRequests.set(key, promise);

    return promise;
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
   * Gets full account information (all balances)
   */
  async getAccountInfo(): Promise<any> {
    if (!this.isConfigured()) {
      throw new Error('Testnet not configured');
    }

    const cacheKey = 'testnet:accountinfo';

    // Try cache first
    const cached = this.cacheService.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Use deduplication to avoid duplicate API calls
    return this.deduplicatedRequest(cacheKey, async () => {
      const cachedAgain = this.cacheService.get(cacheKey);
      if (cachedAgain) {
        return cachedAgain;
      }

      this.logger.log('Fetching account info from Binance Testnet API');
      const accountInfo = await this.binanceTestnetApi.getAccountInfo(this.apiKey, this.apiSecret);

      // Cache result for 30 seconds
      this.cacheService.set(cacheKey, accountInfo, 30000);

      return accountInfo;
    });
  }

  /**
   * Gets account balance (USDT only for performance)
   * Uses caching and request deduplication to minimize API calls
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

    // Use deduplication to avoid duplicate API calls for concurrent requests
    return this.deduplicatedRequest(cacheKey, async () => {
      // Double-check cache in case another request just populated it
      const cachedAgain = this.cacheService.get(cacheKey);
      if (cachedAgain) {
        return cachedAgain;
      }

      this.logger.log('Fetching account balance from Binance Testnet API');
      const balance = await this.binanceTestnetApi.getAccountBalance(this.apiKey, this.apiSecret);

      // Cache result for 30 seconds - this reduces API load significantly
      // Balance doesn't change that frequently, so this is safe
      this.cacheService.set(cacheKey, balance, 30000);

      return balance;
    });
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

    // Use deduplication to avoid duplicate API calls
    return this.deduplicatedRequest(cacheKey, async () => {
      const cachedAgain = this.cacheService.get(cacheKey);
      if (cachedAgain) {
        return cachedAgain;
      }

      this.logger.log(`Fetching open orders from Binance Testnet API${symbol ? ` for ${symbol}` : ''}`);
      const orders = await this.binanceTestnetApi.getOpenOrders(this.apiKey, this.apiSecret, symbol);

      // Cache result for 15 seconds - orders can change more frequently
      this.cacheService.set(cacheKey, orders, 15000);

      return orders;
    });
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

    // Use deduplication to avoid duplicate API calls for the same request
    return this.deduplicatedRequest(cacheKey, async () => {
      // Double-check cache in case another request just populated it
      const cachedAgain = this.cacheService.get(cacheKey);
      if (cachedAgain) {
        return cachedAgain;
      }

      this.logger.log(`Fetching all orders from Binance Testnet API (symbol: ${filters.symbol || 'all'})`);
      const orders = await this.binanceTestnetApi.getAllOrders(
        this.apiKey,
        this.apiSecret,
        filters,
      );

      // Cache result for 10 minutes to drastically reduce API load
      // This prevents rate limit bans
      this.cacheService.set(cacheKey, orders, 600000);

      return orders;
    });
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
   * Places an OCO (One-Cancels-Other) order for automatic stop-loss and take-profit
   * When either the stop-loss or take-profit is triggered, the other order is automatically cancelled
   * 
   * @param symbol - Trading pair symbol (e.g., BTCUSDT)
   * @param side - SELL for closing a long position (most common), BUY for closing a short
   * @param quantity - Amount of the asset to sell/buy
   * @param takeProfitPrice - Price at which to take profit (limit order)
   * @param stopLossPrice - Price at which to trigger stop loss (stop price)
   * @param stopLimitPrice - Optional: Price for the stop-loss limit order
   */
  async placeOcoOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: number,
    takeProfitPrice: number,
    stopLossPrice: number,
    stopLimitPrice?: number,
  ): Promise<{
    orderListId: number;
    contingencyType: string;
    listStatusType: string;
    listOrderStatus: string;
    listClientOrderId: string;
    transactionTime: number;
    symbol: string;
    orders: Array<{
      orderId: number;
      symbol: string;
      clientOrderId: string;
    }>;
    orderReports: Array<{
      orderId: number;
      symbol: string;
      side: string;
      type: string;
      price: string;
      origQty: string;
      status: string;
      stopPrice?: string;
    }>;
  }> {
    if (!this.isConfigured()) {
      throw new Error('Testnet not configured');
    }

    this.logger.log(
      `Placing OCO order: ${symbol} ${side} qty=${quantity} TP=${takeProfitPrice} SL=${stopLossPrice}`
    );

    const result = await this.binanceTestnetApi.placeOcoOrder(
      this.apiKey,
      this.apiSecret,
      symbol,
      side,
      quantity,
      takeProfitPrice,
      stopLossPrice,
      stopLimitPrice,
    );

    // Invalidate orders cache
    this.cacheService.invalidatePattern('testnet:orders');

    return result;
  }

  /**
   * Cancels an OCO order list
   */
  async cancelOcoOrder(symbol: string, orderListId: number): Promise<any> {
    if (!this.isConfigured()) {
      throw new Error('Testnet not configured');
    }

    const result = await this.binanceTestnetApi.cancelOcoOrder(
      this.apiKey,
      this.apiSecret,
      symbol,
      orderListId,
    );

    // Invalidate orders cache
    this.cacheService.invalidatePattern('testnet:orders');

    return result;
  }

  /**
   * Gets all OCO orders
   */
  async getOcoOrders(symbol?: string, limit?: number): Promise<any[]> {
    if (!this.isConfigured()) {
      throw new Error('Testnet not configured');
    }

    const cacheKey = `testnet:ocoorders:${symbol || 'all'}:${limit || 'default'}`;

    const cached = this.cacheService.get(cacheKey);
    if (cached) {
      return cached;
    }

    const orders = await this.binanceTestnetApi.getOcoOrders(
      this.apiKey,
      this.apiSecret,
      symbol,
      limit,
    );

    // Cache for 30 seconds
    this.cacheService.set(cacheKey, orders, 30000);

    return orders;
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
   * Gets all available trading symbols from Binance testnet
   */
  async getAvailableSymbols(): Promise<{ symbols: string[] }> {
    const cacheKey = 'testnet:exchangeInfo';
    
    const cached = this.cacheService.get(cacheKey);
    if (cached) {
      return cached;
    }

    const exchangeInfo = await this.binanceTestnetApi.getExchangeInfo();
    
    // Cache for 1 hour since exchange info rarely changes
    this.cacheService.set(cacheKey, exchangeInfo, 3600000);

    return exchangeInfo;
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

  /**
   * Save Binance testnet order to database for persistence
   */
  async saveOrderToDatabase(order: TestnetOrderDto): Promise<void> {
    try {
      // Get or create a default testnet portfolio
      // Check if a testnet portfolio exists, create one if not
      let testnetPortfolio = await this.prisma.portfolios.findFirst({
        where: {
          name: 'Binance Testnet Portfolio',
        },
      });

      if (!testnetPortfolio) {
        this.logger.log('Creating default Binance Testnet portfolio...');
        // Need to get or create a default user first
        let defaultUser = await this.prisma.users.findFirst({
          where: {
            email: 'testnet@quantiva.local',
          },
        });

        if (!defaultUser) {
          defaultUser = await this.prisma.users.create({
            data: {
              username: 'testnet_user',
              email: 'testnet@quantiva.local',
              password_hash: 'TESTNET_NO_PASSWORD',
              full_name: 'Testnet User',
              email_verified: true,
              kyc_status: 'approved',
            },
          });
        }

        testnetPortfolio = await this.prisma.portfolios.create({
          data: {
            user_id: defaultUser.user_id,
            name: 'Binance Testnet Portfolio',
            type: 'spot',
          },
        });
        this.logger.log(`Created testnet portfolio: ${testnetPortfolio.portfolio_id}`);
      }
      
      // Calculate price safely
      let calculatedPrice = order.price || 0;
      if (!calculatedPrice && order.cumulativeQuoteAssetTransacted && order.executedQuantity) {
        calculatedPrice = order.cumulativeQuoteAssetTransacted / order.executedQuantity;
      }
      // If still no price, we'll fetch it from the order later or leave as 0
      
      const orderData = {
        portfolio_id: testnetPortfolio.portfolio_id,
        side: order.side === 'BUY' ? 'BUY' : 'SELL',
        order_type: order.type === 'MARKET' ? 'market' : 'limit',
        quantity: order.quantity,
        price: calculatedPrice,
        status: order.status === 'FILLED' ? 'filled' : order.status === 'CANCELED' ? 'cancelled' : 'pending',
        auto_trade_approved: true, // Mark as auto-trade for filtering
        metadata: {
          binance_order_id: order.orderId,
          symbol: order.symbol,
          executed_quantity: order.executedQuantity,
          cumulative_quote: order.cumulativeQuoteAssetTransacted,
          timestamp: order.timestamp,
          source: 'binance_testnet',
        },
      };

      this.logger.debug(`Attempting to save order to database: ${JSON.stringify(orderData, null, 2)}`);
      await this.prisma.orders.create({ data: orderData });
      this.logger.log(`✅ Saved order ${order.orderId} (${order.symbol}) to database`);
    } catch (error: any) {
      this.logger.error(`❌ Failed to save order to database: ${error.message}`);
      this.logger.error(`Error details: ${JSON.stringify(error, null, 2)}`);
      this.logger.error(`Error stack: ${error.stack}`);
      this.logger.error(`Order data that failed: ${JSON.stringify(order, null, 2)}`);
      // Don't throw - order was placed successfully on Binance, DB save is just for tracking
    }
  }

  /**
   * Get orders from database (no Binance API calls)
   */
  async getOrdersFromDatabase(limit: number = 100): Promise<TestnetOrderDto[]> {
    try {
      const dbOrders = await this.prisma.orders.findMany({
        where: {
          metadata: {
            path: ['source'],
            equals: 'binance_testnet',
          },
        },
        orderBy: {
          created_at: 'desc',
        },
        take: limit,
      });

      // Convert database orders to TestnetOrderDto format
      return dbOrders.map((order) => ({
        orderId: order.metadata?.binance_order_id || 0,
        symbol: order.metadata?.symbol || '',
        side: order.side === 'BUY' ? 'BUY' : 'SELL',
        type: order.order_type === 'market' ? 'MARKET' : 'LIMIT',
        quantity: parseFloat(order.quantity?.toString() || '0'),
        price: parseFloat(order.price?.toString() || '0'),
        status: order.status === 'filled' ? 'FILLED' : order.status === 'cancelled' ? 'CANCELED' : 'NEW',
        timestamp: order.metadata?.timestamp || order.created_at.getTime(),
        executedQuantity: order.metadata?.executed_quantity || parseFloat(order.quantity?.toString() || '0'),
        cumulativeQuoteAssetTransacted: order.metadata?.cumulative_quote || 0,
      }));
    } catch (error: any) {
      this.logger.error(`Failed to get orders from database: ${error.message}`);
      return [];
    }
  }

  /**
   * Get orders from database and sync with Binance API for fresh data
   * This fetches orders from DB and enriches them with current Binance data
   */
  async getSyncedOrdersFromDatabase(limit: number = 100): Promise<TestnetOrderDto[]> {
    try {
      // Get orders from database
      const dbOrders = await this.getOrdersFromDatabase(limit);
      
      if (!this.isConfigured() || dbOrders.length === 0) {
        return dbOrders;
      }

      this.logger.log(`Syncing ${dbOrders.length} orders from database with Binance API...`);
      
      // Group orders by symbol to minimize API calls
      const ordersBySymbol = new Map<string, TestnetOrderDto[]>();
      for (const order of dbOrders) {
        if (!order.symbol) continue;
        if (!ordersBySymbol.has(order.symbol)) {
          ordersBySymbol.set(order.symbol, []);
        }
        ordersBySymbol.get(order.symbol)!.push(order);
      }

      // Fetch fresh order data from Binance for each symbol
      const syncedOrders: TestnetOrderDto[] = [];
      const symbols = Array.from(ordersBySymbol.keys());
      
      for (const symbol of symbols) {
        try {
          const dbSymbolOrders = ordersBySymbol.get(symbol)!;
          
          // Fetch all orders for this symbol from Binance
          const binanceOrders = await this.getAllOrders({ 
            symbol, 
            limit: 100 
          });
          
          // Match DB orders with Binance orders by orderId
          for (const dbOrder of dbSymbolOrders) {
            const binanceOrder = binanceOrders.find(bo => bo.orderId === dbOrder.orderId);
            
            if (binanceOrder) {
              // Use fresh Binance data
              syncedOrders.push(binanceOrder);
              this.logger.debug(`Synced order ${dbOrder.orderId} (${symbol}) with Binance API`);
            } else {
              // Order not found on Binance, use DB data
              syncedOrders.push(dbOrder);
              this.logger.debug(`Order ${dbOrder.orderId} (${symbol}) not found on Binance, using DB data`);
            }
          }
        } catch (error: any) {
          this.logger.warn(`Failed to sync orders for ${symbol}: ${error.message}, using DB data`);
          // On error, fall back to DB data for this symbol
          syncedOrders.push(...ordersBySymbol.get(symbol)!);
        }
      }

      this.logger.log(`Successfully synced ${syncedOrders.length} orders`);
      return syncedOrders;
    } catch (error: any) {
      this.logger.error(`Failed to sync orders: ${error.message}`);
      return this.getOrdersFromDatabase(limit);
    }
  }
}
