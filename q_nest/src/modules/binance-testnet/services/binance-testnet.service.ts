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

    // Store order in database for persistence
    try {
      this.logger.log(`🔵 Attempting to save order ${order.orderId} to database...`);
      await this.prisma.orders.create({
        data: {
          order_id: `binance_testnet_${order.orderId}`,
          portfolio_id: '415ad43b-4b8a-4841-ba61-f03ac4132ef9', // Use the actual portfolio ID from existing orders
          side: side,
          order_type: type.toLowerCase(),
          quantity: quantity,
          price: price || (order.cumulativeQuoteAssetTransacted / order.executedQuantity) || 0,
          status: order.status === 'FILLED' ? 'filled' : order.status === 'NEW' ? 'pending' : 'cancelled',
          metadata: {
            source: 'binance_testnet',
            binance_order_id: order.orderId,
            symbol: symbol,
            timestamp: order.timestamp,
            executed_quantity: order.executedQuantity,
            cumulative_quote: order.cumulativeQuoteAssetTransacted,
          },
        },
      });
      this.logger.log(`✅ Order ${order.orderId} successfully stored in database`);
    } catch (dbError: any) {
      // Don't fail if DB insert fails - order was placed successfully on Binance
      this.logger.error(`❌ Failed to store order in database: ${dbError?.message}`);
      this.logger.error(`❌ DB Error details: ${JSON.stringify(dbError)}`);
    }

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

    // Save OCO orders to database for trade history tracking
    try {
      // OCO creates 2 orders: LIMIT_MAKER (take profit) and STOP_LOSS_LIMIT (stop loss)
      if (result.orderReports && result.orderReports.length > 0) {
        for (const orderReport of result.orderReports) {
          const isStopLoss = orderReport.type === 'STOP_LOSS_LIMIT';
          const price = isStopLoss 
            ? parseFloat(orderReport.stopPrice || '0')
            : parseFloat(orderReport.price || '0');

          await this.prisma.orders.create({
            data: {
              order_id: `binance_testnet_${orderReport.orderId}`,
              portfolio_id: '415ad43b-4b8a-4841-ba61-f03ac4132ef9', // Use the actual portfolio ID from existing orders
              side: orderReport.side,
              order_type: orderReport.type.toLowerCase(),
              quantity: parseFloat(orderReport.origQty || '0'),
              price: price,
              status: orderReport.status === 'FILLED' ? 'filled' : 'pending',
              metadata: {
                source: 'binance_testnet',
                binance_order_id: orderReport.orderId,
                symbol: orderReport.symbol,
                timestamp: result.transactionTime,
                oco_order_list_id: result.orderListId,
                oco_type: isStopLoss ? 'stop_loss' : 'take_profit',
                stop_price: orderReport.stopPrice,
              },
            },
          });
          this.logger.debug(
            `OCO order ${orderReport.orderId} (${isStopLoss ? 'SL' : 'TP'}) stored in database`
          );
        }
        this.logger.log(
          `✓ Saved ${result.orderReports.length} OCO orders to database (List ID: ${result.orderListId})`
        );
      }
    } catch (dbError: any) {
      // Don't fail if DB insert fails - orders were placed successfully on Binance
      this.logger.warn(`Failed to store OCO orders in database: ${dbError?.message}`);
    }

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

  /**
   * Sync orders in background (non-blocking)
   * Updates order statuses without blocking the response
   */
  private syncOrdersInBackground(): void {
    this.logger.log('🔄 Starting background sync...');
    
    // Run sync without awaiting (fire and forget)
    this.syncOrdersFromBinanceToDatabase()
      .then(result => {
        this.logger.log(
          `✓ Background sync complete: ${result.synced} synced, ${result.skipped} skipped, ${result.errors} errors`
        );
      })
      .catch(error => {
        this.logger.warn(`Background sync failed: ${error?.message}`);
      });
  }

  /**
   * Sync orders from Binance API into database
   * This imports existing Binance orders that weren't stored in DB
   */
  async syncOrdersFromBinanceToDatabase(): Promise<{ synced: number; skipped: number; errors: number }> {
    if (!this.isConfigured()) {
      throw new Error('Testnet not configured');
    }

    let synced = 0;
    let skipped = 0;
    let errors = 0;

    try {
      // Get account info to find symbols with balances
      const accountInfo = await this.getAccountInfo();
      const symbolsWithBalance = accountInfo.balances
        .filter((b: any) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0)
        .map((b: any) => b.asset + 'USDT')
        .filter((s: string) => s !== 'USDTUSDT');

      // Add common trading pairs
      const tradingSymbols = [...new Set([...symbolsWithBalance, 'BTCUSDT', 'ETHUSDT', 'BNBUSDT'])];

      this.logger.log(`Syncing orders for symbols: ${tradingSymbols.join(', ')}`);

      // Get existing orders from database
      const existingOrders = await this.prisma.orders.findMany({
        where: {
          metadata: {
            path: ['source'],
            equals: 'binance_testnet',
          },
        },
        select: {
          order_id: true,
          metadata: true,
          status: true,
        },
      });
      const existingOrdersMap = new Map<number, { order_id: string; status: string; metadata: any }>(
        existingOrders.map((o: any) => [o.metadata?.binance_order_id, o])
      );

      // Fetch orders from Binance for each symbol (limit to recent 50 for speed)
      for (const symbol of tradingSymbols) {
        try {
          const binanceOrders = await this.getAllOrders({ symbol, limit: 50 });
          
          for (const order of binanceOrders) {
            const existingOrder = existingOrdersMap.get(order.orderId);
            
            if (existingOrder) {
              // Update status if changed (e.g., NEW → FILLED)
              const newStatus = order.status === 'FILLED' ? 'filled' : 
                                order.status === 'NEW' ? 'pending' : 'cancelled';
              
              if (existingOrder.status !== newStatus) {
                try {
                  await this.prisma.orders.update({
                    where: { order_id: existingOrder.order_id },
                    data: { status: newStatus },
                  });
                  this.logger.debug(`Updated order ${order.orderId} status: ${existingOrder.status} → ${newStatus}`);
                  synced++;
                } catch (updateError: any) {
                  this.logger.warn(`Failed to update order ${order.orderId}: ${updateError?.message}`);
                  errors++;
                }
              } else {
                skipped++;
              }
              continue;
            }

            try {
              // Calculate price for market orders
              let price = order.price || 0;
              if (!price && order.cumulativeQuoteAssetTransacted && order.executedQuantity) {
                price = order.cumulativeQuoteAssetTransacted / order.executedQuantity;
              }

              await this.prisma.orders.create({
                data: {
                  order_id: `binance_testnet_${order.orderId}`,
                  portfolio_id: '415ad43b-4b8a-4841-ba61-f03ac4132ef9', // Use the actual portfolio ID from existing orders
                  side: order.side,
                  order_type: order.type === 'MARKET' ? 'market' : 'limit',
                  quantity: order.quantity,
                  price: price,
                  status: order.status === 'FILLED' ? 'filled' : order.status === 'NEW' ? 'pending' : 'cancelled',
                  metadata: {
                    source: 'binance_testnet',
                    binance_order_id: order.orderId,
                    symbol: order.symbol,
                    timestamp: order.timestamp,
                    executed_quantity: order.executedQuantity,
                    cumulative_quote: order.cumulativeQuoteAssetTransacted,
                  },
                },
              });
              synced++;
              this.logger.debug(`Synced order ${order.orderId} (${symbol})`);
            } catch (dbError: any) {
              errors++;
              this.logger.warn(`Failed to save order ${order.orderId}: ${dbError?.message}`);
            }
          }
        } catch (symbolError: any) {
          this.logger.warn(`Failed to fetch orders for ${symbol}: ${symbolError?.message}`);
        }
      }

      this.logger.log(`Sync complete: ${synced} synced, ${skipped} skipped, ${errors} errors`);
      return { synced, skipped, errors };
    } catch (error: any) {
      this.logger.error(`Sync failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get trade history with realized P&L for crypto trades
   * Processes filled trades to match BUY/SELL pairs and calculate profit/loss
   */
  async getTradeHistory(params?: {
    limit?: number;
    startTime?: number;
    endTime?: number;
  }): Promise<any[]> {
    try {
      if (!this.isConfigured()) {
        throw new Error('Binance testnet not configured');
      }

      // Start sync in background (don't wait for it)
      // This updates order statuses but doesn't block the response
      this.syncOrdersInBackground();

      // Get filled orders from database (much faster than API calls)
      const dbOrders = await this.prisma.orders.findMany({
        where: {
          metadata: {
            path: ['source'],
            equals: 'binance_testnet',
          },
          status: 'filled',
        },
        orderBy: {
          created_at: 'asc', // Oldest first for FIFO
        },
        take: params?.limit || 500,
      });

      if (dbOrders.length === 0) {
        this.logger.log('No filled orders found in database');
        return [];
      }

      this.logger.log(`Processing ${dbOrders.length} filled orders from database`);

      // Log all orders for debugging
      dbOrders.forEach(order => {
        this.logger.debug(
          `Order: ${order.metadata?.symbol} ${order.side} ${order.quantity} @ $${order.price} | ` +
          `Status: ${order.status} | Time: ${order.created_at.toISOString()}`
        );
      });

      // Group by symbol
      const tradesBySymbol: { [symbol: string]: any[] } = {};
      
      dbOrders.forEach((order) => {
        const symbol = order.metadata?.symbol;
        if (!symbol) return;
        
        const price = parseFloat(order.price?.toString() || '0');
        const qty = parseFloat(order.quantity?.toString() || '0');
        
        // Skip orders with invalid price (0 or negative)
        if (price <= 0) {
          this.logger.warn(`Skipping order with invalid price: ${symbol} ${order.side} ${qty} @ $${price}`);
          return;
        }
        
        if (!tradesBySymbol[symbol]) {
          tradesBySymbol[symbol] = [];
        }
        
        tradesBySymbol[symbol].push({
          side: order.side,
          qty: qty,
          price: price,
          time: order.created_at.getTime(),
          commission: order.metadata?.fee || 0,
        });
      });

      // Process each symbol to find closed trades (BUY → SELL pairs)
      const closedTrades: any[] = [];
      
      for (const [symbol, trades] of Object.entries(tradesBySymbol)) {
        // Already sorted by time (oldest first)
        const buyQueue: any[] = [];
        
        for (const trade of trades) {
          const side = trade.side?.toUpperCase();
          const qty = trade.qty;
          const price = trade.price;
          
          if (side === 'BUY') {
            // Add to buy queue
            buyQueue.push({
              ...trade,
              remainingQty: qty,
              originalQty: qty,
            });
          } else if (side === 'SELL' && buyQueue.length > 0) {
            // Match with oldest buys (FIFO)
            let remainingSellQty = qty;
            
            while (remainingSellQty > 0 && buyQueue.length > 0) {
              const oldestBuy = buyQueue[0];
              const matchedQty = Math.min(remainingSellQty, oldestBuy.remainingQty);
              
              // Calculate P&L for this matched pair
              const buyPrice = oldestBuy.price;
              const sellPrice = price;
              const profitLoss = (sellPrice - buyPrice) * matchedQty;
              const profitLossPercent = ((sellPrice - buyPrice) / buyPrice) * 100;
              
              // Calculate fees
              const buyFee = oldestBuy.commission || 0;
              const sellFee = trade.commission || 0;
              const totalFees = buyFee + sellFee;
              const netProfitLoss = profitLoss - totalFees;
              
              // Calculate duration
              const entryTime = new Date(oldestBuy.time);
              const exitTime = new Date(trade.time);
              const durationMs = exitTime.getTime() - entryTime.getTime();
              const durationHours = Math.floor(durationMs / (1000 * 60 * 60));
              const durationMinutes = Math.floor((durationMs % (1000 * 60 * 60)) / (1000 * 60));
              const duration = durationHours > 0 
                ? `${durationHours}h ${durationMinutes}m`
                : `${durationMinutes}m`;
              
              // Log the matched trade for verification
              this.logger.log(
                `✓ Matched trade: ${symbol} | ` +
                `BUY ${matchedQty} @ $${buyPrice.toFixed(4)} → ` +
                `SELL ${matchedQty} @ $${sellPrice.toFixed(4)} | ` +
                `P&L: $${netProfitLoss.toFixed(2)} (${profitLossPercent.toFixed(2)}%) | ` +
                `Fees: $${totalFees.toFixed(4)} | Duration: ${duration}`
              );
              
              closedTrades.push({
                id: `${symbol}_${oldestBuy.time}_${trade.time}`,
                symbol: symbol,
                entryPrice: buyPrice,
                exitPrice: sellPrice,
                quantity: matchedQty,
                profitLoss: netProfitLoss,
                profitLossPercent: profitLossPercent,
                entryTime: entryTime.toISOString(),
                exitTime: exitTime.toISOString(),
                duration: duration,
                fees: totalFees,
              });
              
              // Update remaining quantities
              remainingSellQty -= matchedQty;
              oldestBuy.remainingQty -= matchedQty;
              
              // Remove from queue if fully matched
              if (oldestBuy.remainingQty <= 0) {
                buyQueue.shift();
              }
            }
          }
        }
      }
      
      // Sort by exit time (most recent first)
      closedTrades.sort((a, b) => new Date(b.exitTime).getTime() - new Date(a.exitTime).getTime());
      
      return closedTrades;
    } catch (error) {
      this.logger.error(`Failed to get trade history: ${error.message}`);
      throw error;
    }
  }
}
