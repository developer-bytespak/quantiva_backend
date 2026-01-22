import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

export interface AlpacaAccount {
  id: string;
  account_number: string;
  status: string;
  currency: string;
  buying_power: string;
  cash: string;
  portfolio_value: string;
  pattern_day_trader: boolean;
  trading_blocked: boolean;
  transfers_blocked: boolean;
  account_blocked: boolean;
  created_at: string;
  shorting_enabled: boolean;
  multiplier: string;
  long_market_value: string;
  short_market_value: string;
  equity: string;
  last_equity: string;
  initial_margin: string;
  maintenance_margin: string;
  daytrade_count: number;
  last_maintenance_margin: string;
  daytrading_buying_power: string;
  regt_buying_power: string;
}

export interface AlpacaPosition {
  asset_id: string;
  symbol: string;
  exchange: string;
  asset_class: string;
  avg_entry_price: string;
  qty: string;
  side: string;
  market_value: string;
  cost_basis: string;
  unrealized_pl: string;
  unrealized_plpc: string;
  unrealized_intraday_pl: string;
  unrealized_intraday_plpc: string;
  current_price: string;
  lastday_price: string;
  change_today: string;
}

export interface AlpacaOrder {
  id: string;
  client_order_id: string;
  created_at: string;
  updated_at: string;
  submitted_at: string;
  filled_at: string | null;
  expired_at: string | null;
  canceled_at: string | null;
  failed_at: string | null;
  replaced_at: string | null;
  asset_id: string;
  symbol: string;
  asset_class: string;
  notional: string | null;
  qty: string;
  filled_qty: string;
  filled_avg_price: string | null;
  order_class: string;
  order_type: string;
  type: string;
  side: string;
  time_in_force: string;
  limit_price: string | null;
  stop_price: string | null;
  status: string;
  extended_hours: boolean;
  legs: any[] | null;
  trail_percent: string | null;
  trail_price: string | null;
  hwm: string | null;
}

export interface PlaceOrderParams {
  symbol: string;
  qty?: number;
  notional?: number; // Dollar amount instead of qty
  side: 'buy' | 'sell';
  type: 'market' | 'limit' | 'stop' | 'stop_limit' | 'trailing_stop';
  time_in_force: 'day' | 'gtc' | 'opg' | 'cls' | 'ioc' | 'fok';
  limit_price?: number;
  stop_price?: number;
  trail_price?: number;
  trail_percent?: number;
  extended_hours?: boolean;
  client_order_id?: string;
  order_class?: 'simple' | 'bracket' | 'oco' | 'oto';
  take_profit?: {
    limit_price: number;
  };
  stop_loss?: {
    stop_price: number;
    limit_price?: number;
  };
}

@Injectable()
export class AlpacaPaperTradingService {
  private readonly logger = new Logger(AlpacaPaperTradingService.name);
  private readonly apiClient: AxiosInstance;
  private readonly baseUrl = 'https://paper-api.alpaca.markets';
  
  // Cache for request deduplication
  private pendingRequests: Map<string, Promise<any>> = new Map();
  private cache: Map<string, { data: any; expiry: number }> = new Map();

  constructor(private configService: ConfigService) {
    // Try paper-specific keys first, then fall back to general Alpaca keys
    const apiKey = this.configService.get<string>('ALPACA_PAPER_API_KEY') 
      || this.configService.get<string>('ALPACA_API_KEY');
    const secretKey = this.configService.get<string>('ALPACA_PAPER_SECRET_KEY') 
      || this.configService.get<string>('ALPACA_SECRET_KEY');

    this.apiClient = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
      headers: {
        'APCA-API-KEY-ID': apiKey || '',
        'APCA-API-SECRET-KEY': secretKey || '',
        'Content-Type': 'application/json',
      },
    });

    this.logger.log(`Alpaca Paper Trading Service initialized with endpoint: ${this.baseUrl}`);
    
    if (!apiKey || !secretKey) {
      this.logger.warn('Alpaca paper trading credentials not configured. Set ALPACA_PAPER_API_KEY/ALPACA_PAPER_SECRET_KEY or ALPACA_API_KEY/ALPACA_SECRET_KEY.');
    }
  }

  /**
   * Check if service is configured
   */
  isConfigured(): boolean {
    const apiKey = this.configService.get<string>('ALPACA_PAPER_API_KEY') 
      || this.configService.get<string>('ALPACA_API_KEY');
    const secretKey = this.configService.get<string>('ALPACA_PAPER_SECRET_KEY') 
      || this.configService.get<string>('ALPACA_SECRET_KEY');
    return !!apiKey && !!secretKey;
  }

  /**
   * Get configuration status
   */
  getStatus() {
    return {
      configured: this.isConfigured(),
      endpoint: this.baseUrl,
    };
  }

  /**
   * Cache helper
   */
  private getFromCache<T>(key: string): T | null {
    const cached = this.cache.get(key);
    if (cached && cached.expiry > Date.now()) {
      return cached.data as T;
    }
    this.cache.delete(key);
    return null;
  }

  private setCache(key: string, data: any, ttlMs: number): void {
    this.cache.set(key, { data, expiry: Date.now() + ttlMs });
  }

  private invalidateCache(pattern?: string): void {
    if (pattern) {
      for (const key of this.cache.keys()) {
        if (key.includes(pattern)) {
          this.cache.delete(key);
        }
      }
    } else {
      this.cache.clear();
    }
  }

  /**
   * Request deduplication helper
   */
  private async deduplicatedRequest<T>(
    key: string,
    requestFn: () => Promise<T>,
  ): Promise<T> {
    if (this.pendingRequests.has(key)) {
      return this.pendingRequests.get(key)!;
    }

    const promise = requestFn().finally(() => {
      this.pendingRequests.delete(key);
    });

    this.pendingRequests.set(key, promise);
    return promise;
  }

  /**
   * Verify connection to Alpaca paper trading
   */
  async verifyConnection(): Promise<boolean> {
    try {
      if (!this.isConfigured()) {
        this.logger.error('Alpaca paper trading not configured');
        return false;
      }

      const account = await this.getAccount();
      const isValid = account && account.status === 'ACTIVE';
      this.logger.log(`Alpaca paper trading connection: ${isValid ? 'Success' : 'Failed'}`);
      return isValid;
    } catch (error: any) {
      this.logger.error(`Failed to verify Alpaca connection: ${error?.message}`);
      return false;
    }
  }

  /**
   * Get account information
   */
  async getAccount(): Promise<AlpacaAccount> {
    const cacheKey = 'alpaca:account';
    
    const cached = this.getFromCache<AlpacaAccount>(cacheKey);
    if (cached) {
      return cached;
    }

    return this.deduplicatedRequest(cacheKey, async () => {
      const cachedAgain = this.getFromCache<AlpacaAccount>(cacheKey);
      if (cachedAgain) return cachedAgain;

      this.logger.debug('Fetching account from Alpaca Paper API');
      const response = await this.apiClient.get<AlpacaAccount>('/v2/account');
      
      this.setCache(cacheKey, response.data, 30000); // Cache for 30 seconds
      return response.data;
    });
  }

  /**
   * Get account balance summary (formatted for frontend)
   */
  async getAccountBalance(): Promise<{
    buyingPower: number;
    cash: number;
    portfolioValue: number;
    equity: number;
    longMarketValue: number;
    shortMarketValue: number;
    dailyChange: number;
    dailyChangePercent: number;
  }> {
    const account = await this.getAccount();
    
    const equity = parseFloat(account.equity) || 0;
    const lastEquity = parseFloat(account.last_equity) || equity;
    const dailyChange = equity - lastEquity;
    const dailyChangePercent = lastEquity > 0 ? (dailyChange / lastEquity) * 100 : 0;

    return {
      buyingPower: parseFloat(account.buying_power) || 0,
      cash: parseFloat(account.cash) || 0,
      portfolioValue: parseFloat(account.portfolio_value) || 0,
      equity,
      longMarketValue: parseFloat(account.long_market_value) || 0,
      shortMarketValue: parseFloat(account.short_market_value) || 0,
      dailyChange,
      dailyChangePercent,
    };
  }

  /**
   * Get all positions
   */
  async getPositions(): Promise<AlpacaPosition[]> {
    const cacheKey = 'alpaca:positions';
    
    const cached = this.getFromCache<AlpacaPosition[]>(cacheKey);
    if (cached) {
      return cached;
    }

    return this.deduplicatedRequest(cacheKey, async () => {
      const cachedAgain = this.getFromCache<AlpacaPosition[]>(cacheKey);
      if (cachedAgain) return cachedAgain;

      this.logger.debug('Fetching positions from Alpaca Paper API');
      const response = await this.apiClient.get<AlpacaPosition[]>('/v2/positions');
      
      this.setCache(cacheKey, response.data, 15000); // Cache for 15 seconds
      return response.data;
    });
  }

  /**
   * Get position for a specific symbol
   */
  async getPosition(symbol: string): Promise<AlpacaPosition | null> {
    try {
      const response = await this.apiClient.get<AlpacaPosition>(`/v2/positions/${symbol}`);
      return response.data;
    } catch (error: any) {
      if (error?.response?.status === 404) {
        return null; // No position for this symbol
      }
      throw error;
    }
  }

  /**
   * Close a position
   */
  async closePosition(symbol: string, qty?: number, percentage?: number): Promise<AlpacaOrder> {
    const params: any = {};
    if (qty) params.qty = qty;
    if (percentage) params.percentage = percentage;

    const response = await this.apiClient.delete<AlpacaOrder>(
      `/v2/positions/${symbol}`,
      { params }
    );

    this.invalidateCache('positions');
    this.invalidateCache('orders');
    
    return response.data;
  }

  /**
   * Close all positions
   */
  async closeAllPositions(cancelOrders: boolean = true): Promise<AlpacaOrder[]> {
    const response = await this.apiClient.delete<AlpacaOrder[]>(
      '/v2/positions',
      { params: { cancel_orders: cancelOrders } }
    );

    this.invalidateCache('positions');
    this.invalidateCache('orders');
    
    return response.data;
  }

  /**
   * Get orders with optional filters
   */
  async getOrders(params?: {
    status?: 'open' | 'closed' | 'all';
    limit?: number;
    after?: string;
    until?: string;
    direction?: 'asc' | 'desc';
    nested?: boolean;
    symbols?: string;
  }): Promise<AlpacaOrder[]> {
    const cacheKey = `alpaca:orders:${JSON.stringify(params || {})}`;
    
    const cached = this.getFromCache<AlpacaOrder[]>(cacheKey);
    if (cached) {
      return cached;
    }

    return this.deduplicatedRequest(cacheKey, async () => {
      const cachedAgain = this.getFromCache<AlpacaOrder[]>(cacheKey);
      if (cachedAgain) return cachedAgain;

      this.logger.debug('Fetching orders from Alpaca Paper API');
      const response = await this.apiClient.get<AlpacaOrder[]>('/v2/orders', {
        params: params || { status: 'all', limit: 100 },
      });
      
      this.setCache(cacheKey, response.data, 10000); // Cache for 10 seconds
      return response.data;
    });
  }

  /**
   * Get a specific order by ID
   */
  async getOrder(orderId: string): Promise<AlpacaOrder> {
    const response = await this.apiClient.get<AlpacaOrder>(`/v2/orders/${orderId}`);
    return response.data;
  }

  /**
   * Place a new order
   */
  async placeOrder(params: PlaceOrderParams): Promise<AlpacaOrder> {
    this.logger.log(`Placing order: ${params.side} ${params.qty || params.notional} ${params.symbol} @ ${params.type}`);

    const orderData: any = {
      symbol: params.symbol,
      side: params.side,
      type: params.type,
      time_in_force: params.time_in_force,
    };

    // Either qty or notional, not both
    if (params.qty) {
      orderData.qty = params.qty.toString();
    } else if (params.notional) {
      orderData.notional = params.notional.toString();
    }

    if (params.limit_price) orderData.limit_price = params.limit_price.toString();
    if (params.stop_price) orderData.stop_price = params.stop_price.toString();
    if (params.trail_price) orderData.trail_price = params.trail_price.toString();
    if (params.trail_percent) orderData.trail_percent = params.trail_percent.toString();
    if (params.extended_hours !== undefined) orderData.extended_hours = params.extended_hours;
    if (params.client_order_id) orderData.client_order_id = params.client_order_id;
    if (params.order_class) orderData.order_class = params.order_class;
    if (params.take_profit) orderData.take_profit = { limit_price: params.take_profit.limit_price.toString() };
    if (params.stop_loss) {
      orderData.stop_loss = {
        stop_price: params.stop_loss.stop_price.toString(),
        ...(params.stop_loss.limit_price && { limit_price: params.stop_loss.limit_price.toString() }),
      };
    }

    try {
      const response = await this.apiClient.post<AlpacaOrder>('/v2/orders', orderData);
      
      this.invalidateCache('orders');
      this.invalidateCache('account');
      this.invalidateCache('positions');
      
      this.logger.log(`Order placed successfully: ${response.data.id}`);
      return response.data;
    } catch (error: any) {
      this.logger.error(`Failed to place order: ${error?.response?.data?.message || error?.message}`);
      throw error;
    }
  }

  /**
   * Cancel an order
   */
  async cancelOrder(orderId: string): Promise<void> {
    this.logger.log(`Canceling order: ${orderId}`);
    
    await this.apiClient.delete(`/v2/orders/${orderId}`);
    this.invalidateCache('orders');
    
    this.logger.log(`Order canceled: ${orderId}`);
  }

  /**
   * Cancel all open orders
   */
  async cancelAllOrders(): Promise<{ id: string; status: number; body: any }[]> {
    this.logger.log('Canceling all orders');
    
    const response = await this.apiClient.delete<{ id: string; status: number; body: any }[]>('/v2/orders');
    this.invalidateCache('orders');
    
    return response.data;
  }

  /**
   * Replace/modify an existing order
   */
  async replaceOrder(orderId: string, params: {
    qty?: number;
    time_in_force?: string;
    limit_price?: number;
    stop_price?: number;
    trail?: number;
    client_order_id?: string;
  }): Promise<AlpacaOrder> {
    const patchData: any = {};
    
    if (params.qty) patchData.qty = params.qty.toString();
    if (params.time_in_force) patchData.time_in_force = params.time_in_force;
    if (params.limit_price) patchData.limit_price = params.limit_price.toString();
    if (params.stop_price) patchData.stop_price = params.stop_price.toString();
    if (params.trail) patchData.trail = params.trail.toString();
    if (params.client_order_id) patchData.client_order_id = params.client_order_id;

    const response = await this.apiClient.patch<AlpacaOrder>(`/v2/orders/${orderId}`, patchData);
    this.invalidateCache('orders');
    
    return response.data;
  }

  /**
   * Get portfolio history
   */
  async getPortfolioHistory(params?: {
    period?: string; // 1D, 1W, 1M, 3M, 1A, all
    timeframe?: string; // 1Min, 5Min, 15Min, 1H, 1D
    date_end?: string;
    extended_hours?: boolean;
  }): Promise<{
    timestamp: number[];
    equity: number[];
    profit_loss: number[];
    profit_loss_pct: number[];
    base_value: number;
    timeframe: string;
  }> {
    const response = await this.apiClient.get('/v2/account/portfolio/history', {
      params: params || { period: '1M', timeframe: '1D' },
    });
    return response.data;
  }

  /**
   * Get account activities (trades, dividends, etc.)
   */
  async getAccountActivities(activityTypes?: string[], params?: {
    after?: string;
    until?: string;
    direction?: 'asc' | 'desc';
    page_size?: number;
    page_token?: string;
  }): Promise<any[]> {
    const endpoint = activityTypes?.length 
      ? `/v2/account/activities/${activityTypes.join(',')}`
      : '/v2/account/activities';
    
    const response = await this.apiClient.get(endpoint, { params });
    return response.data;
  }

  /**
   * Get trading calendar
   */
  async getCalendar(start?: string, end?: string): Promise<{
    date: string;
    open: string;
    close: string;
  }[]> {
    const response = await this.apiClient.get('/v2/calendar', {
      params: { start, end },
    });
    return response.data;
  }

  /**
   * Get clock (market hours)
   */
  async getClock(): Promise<{
    timestamp: string;
    is_open: boolean;
    next_open: string;
    next_close: string;
  }> {
    const response = await this.apiClient.get('/v2/clock');
    return response.data;
  }

  /**
   * Get dashboard data (combined account, positions, orders)
   */
  async getDashboardData(): Promise<{
    account: AlpacaAccount;
    balance: {
      buyingPower: number;
      cash: number;
      portfolioValue: number;
      equity: number;
      dailyChange: number;
      dailyChangePercent: number;
    };
    positions: AlpacaPosition[];
    openOrders: AlpacaOrder[];
    recentOrders: AlpacaOrder[];
    clock: {
      isOpen: boolean;
      nextOpen: string;
      nextClose: string;
    };
  }> {
    if (!this.isConfigured()) {
      throw new Error('Alpaca paper trading not configured');
    }

    try {
      const [account, positions, openOrders, recentOrders, clock] = await Promise.all([
        this.getAccount(),
        this.getPositions(),
        this.getOrders({ status: 'open', limit: 50 }),
        this.getOrders({ status: 'closed', limit: 20, direction: 'desc' }),
        this.getClock(),
      ]);

      const balance = {
        buyingPower: parseFloat(account.buying_power) || 0,
        cash: parseFloat(account.cash) || 0,
        portfolioValue: parseFloat(account.portfolio_value) || 0,
        equity: parseFloat(account.equity) || 0,
        dailyChange: (parseFloat(account.equity) || 0) - (parseFloat(account.last_equity) || 0),
        dailyChangePercent: parseFloat(account.last_equity) > 0
          ? (((parseFloat(account.equity) || 0) - (parseFloat(account.last_equity) || 0)) / parseFloat(account.last_equity)) * 100
          : 0,
      };

      return {
        account,
        balance,
        positions,
        openOrders,
        recentOrders,
        clock: {
          isOpen: clock.is_open,
          nextOpen: clock.next_open,
          nextClose: clock.next_close,
        },
      };
    } catch (error: any) {
      this.logger.error(`Failed to get dashboard data: ${error?.message}`);
      throw error;
    }
  }
}

