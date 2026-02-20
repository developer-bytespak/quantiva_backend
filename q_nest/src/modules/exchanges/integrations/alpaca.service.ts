import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';

const DATA_API_BASE = 'https://data.alpaca.markets';

/** Snapshot from Alpaca Data API (ap/bp/as/bs may be number or string) */
interface AlpacaSnapshot {
  symbol: string;
  latestTrade?: { t: string; p: number };
  latestQuote?: { ap?: number | string; bp?: number | string; as?: number | string; bs?: number | string };
  prevDailyBar?: { o: number; h: number; l: number; c: number; v: number; t: string };
  dailyBar?: { o: number; h: number; l: number; c: number; v: number; t: string };
}

function toNum(v: number | string | undefined): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : undefined;
}

function toNumOrZero(v: number | string | undefined): number {
  const n = toNum(v);
  return typeof n === 'number' ? n : 0;
}

/** Quote-like shape for stock detail (from Data API snapshot) */
export interface AlpacaStockQuote {
  symbol: string;
  price: number;
  change24h: number;
  changePercent24h: number;
  volume24h: number;
  dayHigh: number;
  dayLow: number;
  dayOpen: number;
  prevClose: number;
  /** Real bid/ask from Alpaca latestQuote when available */
  bidPrice?: number;
  askPrice?: number;
  bidSize?: number;
  askSize?: number;
  spread?: number;
  spreadPercent?: number;
}

/** Bar from Alpaca Data API */
export interface AlpacaBarDto {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/**
 * Alpaca supported cryptocurrencies (base symbols without /USD)
 * These are the crypto assets available for trading on Alpaca
 * Note: TRX removed as it's not active for trading
 */
export const ALPACA_SUPPORTED_CRYPTO = [
  'BTC', 'ETH', 'LTC', 'BCH', 'USDT', 'USDC', 'XRP', 'DOGE', 
  'SHIB', 'MATIC', 'UNI', 'AAVE', 'LINK', 'MKR', 'ALGO', 
  'AVAX', 'DOT', 'SOL', 'ADA', 'XLM', 'ETC', 'FIL',
  'GRT', 'SUSHI', 'YFI', 'BAT', 'CRV', 'ATOM'
];

@Injectable()
export class AlpacaService {
  private readonly logger = new Logger(AlpacaService.name);
  private readonly baseUrl = 'https://api.alpaca.markets';
  private readonly paperBaseUrl = 'https://paper-api.alpaca.markets';
  private readonly apiClient: AxiosInstance;
  private readonly paperApiClient: AxiosInstance;
  private apiKey: string | null = null;
  private apiSecret: string | null = null;
  private usePaperTrading = true; // Default to paper trading

  constructor() {
    this.apiClient = axios.create({
      baseURL: this.baseUrl,
      timeout: 10000,
    });
    this.paperApiClient = axios.create({
      baseURL: this.paperBaseUrl,
      timeout: 10000,
    });
  }

  /**
   * Configure Alpaca service with API credentials
   */
  configure(apiKey: string, apiSecret: string, usePaper = true) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.usePaperTrading = usePaper;
    this.logger.log(`Alpaca configured for ${usePaper ? 'paper' : 'live'} trading`);
  }

  /**
   * Check if service is configured with credentials
   */
  isConfigured(): boolean {
    return !!(this.apiKey && this.apiSecret);
  }

  /**
   * Get the appropriate API client (paper or live)
   */
  private getClient(): AxiosInstance {
    return this.usePaperTrading ? this.paperApiClient : this.apiClient;
  }

  /**
   * Get auth headers for API requests
   */
  private getAuthHeaders(apiKey?: string, apiSecret?: string) {
    return {
      'APCA-API-KEY-ID': apiKey || this.apiKey,
      'APCA-API-SECRET-KEY': apiSecret || this.apiSecret,
    };
  }

  /**
   * Verify Alpaca API key by fetching account
   */
  async verifyApiKey(apiKey: string, apiSecret: string): Promise<{
    valid: boolean;
    permissions: string[];
    accountType: string;
  }> {
    try {
      // Detect if it's a paper or live key based on the key prefix
      // Paper keys start with 'PK', live keys start with 'AK'
      const isPaperKey = apiKey.startsWith('PK');
      const client = isPaperKey ? this.paperApiClient : this.apiClient;
      
      this.logger.log(`Verifying Alpaca ${isPaperKey ? 'paper' : 'live'} trading key`);
      
      const res = await client.get('/v2/account', {
        headers: this.getAuthHeaders(apiKey, apiSecret),
      });

      const data = res.data || {};

      return {
        valid: true,
        permissions: ['ACCOUNT_READ', 'TRADING'],
        accountType: data.account_blocked ? 'BLOCKED' : 'STOCKS',
      };
    } catch (error: any) {
      this.logger.warn('Alpaca verification failed', error?.response?.data || error?.message || error);
      throw new Error((error?.response?.data && JSON.stringify(error.response.data)) || error?.message || 'Alpaca verification failed');
    }
  }

  /**
   * Get account information including balance
   */
  async getAccountInfo(apiKey?: string, apiSecret?: string): Promise<any> {
    // Detect if it's a paper or live key based on the key prefix
    const keyToUse = apiKey || this.apiKey;
    const isPaperKey = keyToUse?.startsWith('PK');
    const client = isPaperKey ? this.paperApiClient : this.apiClient;
    
    console.log(`[ALPACA] Fetching account info using ${isPaperKey ? 'paper' : 'live'} endpoint (key: ${keyToUse?.substring(0, 2)}...)`);
    
    try {
      const res = await client.get('/v2/account', {
        headers: this.getAuthHeaders(apiKey, apiSecret),
      });
      console.log(`[ALPACA] Account info fetched successfully`);
      return res.data;
    } catch (error: any) {
      console.error(`[ALPACA] getAccountInfo FAILED: Status ${error?.response?.status}, Data:`, error?.response?.data);
      this.logger.error(`Alpaca getAccountInfo failed: ${error?.response?.status} - ${JSON.stringify(error?.response?.data)}`, error?.stack);
      throw error;
    }
  }

  /**
   * Get account balance. When apiKey/apiSecret provided (e.g. from connection), uses that key and returns
   * shape compatible with AccountBalanceDto (assets, totalValueUSD, buyingPower).
   */
  async getAccountBalance(apiKey?: string, apiSecret?: string): Promise<any> {
    const account = await this.getAccountInfo(apiKey, apiSecret);
    const buyingPower = parseFloat(account.buying_power || account.cash || '0') || 0;
    const cash = parseFloat(account.cash || '0') || 0;
    const totalValueUSD = parseFloat(account.portfolio_value || account.equity || '0') || 0;
    return {
      assets: [
        { symbol: 'USD', free: buyingPower.toString(), locked: '0', total: cash.toString() },
      ],
      totalValueUSD,
      buyingPower,
    };
  }

  /**
   * Get the appropriate API client based on API key prefix
   */
  private getClientForKey(apiKey?: string): AxiosInstance {
    const keyToUse = apiKey || this.apiKey;
    const isPaperKey = keyToUse?.startsWith('PK');
    return isPaperKey ? this.paperApiClient : this.apiClient;
  }

  /**
   * Get all positions
   */
  async getPositions(apiKey?: string, apiSecret?: string): Promise<any[]> {
    const client = this.getClientForKey(apiKey);
    const res = await client.get('/v2/positions', {
      headers: this.getAuthHeaders(apiKey, apiSecret),
    });
    return res.data || [];
  }

  /**
   * Get orders with optional filters
   */
  async getOrders(apiKey?: string, apiSecret?: string, status = 'open'): Promise<any[]> {
    const client = this.getClientForKey(apiKey);
    const res = await client.get('/v2/orders', {
      headers: this.getAuthHeaders(apiKey, apiSecret),
      params: {
        status,
        limit: 100,
      },
    });
    return res.data || [];
  }

  /**
   * Get all orders (closed and open)
   */
  async getAllOrders(options?: { limit?: number }): Promise<any[]> {
    const client = this.getClientForKey();
    const res = await client.get('/v2/orders', {
      headers: this.getAuthHeaders(),
      params: {
        status: 'all',
        limit: options?.limit || 100,
      },
    });
    return res.data || [];
  }

  /**
   * Place a market or limit order.
   * When apiKey/apiSecret are provided (e.g. from user connection), uses that key so paper vs live
   * is determined by the key prefix (PK = paper, AK = live). Otherwise uses configured instance key.
   */
  async placeOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    type: 'MARKET' | 'LIMIT',
    quantity: number,
    limitPrice?: number,
    apiKey?: string,
    apiSecret?: string,
  ): Promise<any> {
    try {
      // Convert symbol format: BTCUSDT -> BTC/USD; stocks pass through as-is
      const alpacaSymbol = this.convertToAlpacaSymbol(symbol);

      const orderData: any = {
        symbol: alpacaSymbol,
        qty: quantity.toString(),
        side: side.toLowerCase(),
        type: type.toLowerCase(),
        time_in_force: 'gtc',
      };

      if (type === 'LIMIT' && limitPrice) {
        orderData.limit_price = limitPrice.toString();
      }

      const client = apiKey ? this.getClientForKey(apiKey) : this.getClient();
      const headers = this.getAuthHeaders(apiKey, apiSecret);
      this.logger.log(`Placing ${type} ${side} order: ${quantity} ${alpacaSymbol}`);

      const res = await client.post('/v2/orders', orderData, {
        headers,
      });

      const order = res.data;

      // Transform to Binance-like response format for compatibility
      return {
        orderId: order.id,
        symbol: order.symbol,
        side: order.side.toUpperCase(),
        type: order.type.toUpperCase(),
        quantity: parseFloat(order.qty),
        price: parseFloat(order.filled_avg_price || order.limit_price || 0),
        executedQuantity: parseFloat(order.filled_qty || 0),
        status: order.status.toUpperCase(),
        cumulativeQuoteAssetTransacted: parseFloat(order.filled_avg_price || 0) * parseFloat(order.filled_qty || 0),
      };
    } catch (error: any) {
      this.logger.error(`Error placing order: ${error.message}`, error?.response?.data);
      throw error;
    }
  }

  /**
   * Place a bracket order (entry + take profit + stop loss).
   * When apiKey/apiSecret provided, uses that key (paper vs live by key prefix).
   */
  async placeBracketOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: number,
    takeProfitPrice: number,
    stopLossPrice: number,
    apiKey?: string,
    apiSecret?: string,
  ): Promise<any> {
    try {
      const alpacaSymbol = this.convertToAlpacaSymbol(symbol);

      const orderData = {
        symbol: alpacaSymbol,
        qty: quantity.toString(),
        side: side.toLowerCase(),
        type: 'market',
        time_in_force: 'gtc',
        order_class: 'bracket',
        take_profit: {
          limit_price: takeProfitPrice.toString(),
        },
        stop_loss: {
          stop_price: stopLossPrice.toString(),
        },
      };

      const client = apiKey ? this.getClientForKey(apiKey) : this.getClient();
      const headers = this.getAuthHeaders(apiKey, apiSecret);
      this.logger.log(
        `Placing bracket order: ${quantity} ${alpacaSymbol}, TP=${takeProfitPrice}, SL=${stopLossPrice}`,
      );

      const res = await client.post('/v2/orders', orderData, {
        headers,
      });

      const order = res.data;

      // Transform to Binance OCO-like response
      return {
        orderListId: order.id,
        symbol: order.symbol,
        orders: [
          {
            orderId: order.id,
            symbol: order.symbol,
            side: order.side.toUpperCase(),
          },
          ...(order.legs || []).map((leg: any) => ({
            orderId: leg.id,
            symbol: leg.symbol,
            side: leg.side.toUpperCase(),
            type: leg.type.toUpperCase(),
          })),
        ],
      };
    } catch (error: any) {
      this.logger.error(`Error placing bracket order: ${error.message}`, error?.response?.data);
      throw error;
    }
  }

  /**
   * Alias for bracket order to match Binance naming
   */
  async placeOcoOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: number,
    takeProfitPrice: number,
    stopLossPrice: number,
  ): Promise<any> {
    return this.placeBracketOrder(symbol, side, quantity, takeProfitPrice, stopLossPrice);
  }

  /**
   * Convert Binance-style symbol to Alpaca format
   * BTCUSDT -> BTC/USD
   * ETHUSDT -> ETH/USD
   * BTC/USD -> BTC/USD (already correct)
   */
  private convertToAlpacaSymbol(symbol: string): string {
    // If already in Alpaca format (contains /), return as-is
    if (symbol.includes('/')) {
      return symbol;
    }

    const upperSymbol = symbol.toUpperCase();

    // Handle common crypto pairs
    if (upperSymbol.endsWith('USDT')) {
      return upperSymbol.replace('USDT', '/USD');
    }
    if (upperSymbol.endsWith('USDC')) {
      return upperSymbol.replace('USDC', '/USD');
    }
    if (upperSymbol.endsWith('USD')) {
      return upperSymbol.replace('USD', '/USD');
    }

    // Stock ticker (e.g. AAPL, NVDA, BRK.B) – use as-is for Alpaca stocks API
    if (/^[A-Z.]{1,6}$/.test(upperSymbol)) {
      return upperSymbol;
    }

    // Default: assume it's base/USD (crypto)
    return `${upperSymbol}/USD`;
  }

  /**
   * Get account activities (trade fills) for trade history
   */
  async getAccountActivities(params?: {
    activity_type?: string;
    date?: string;
    until?: string;
    direction?: 'asc' | 'desc';
    page_size?: number;
  }): Promise<any[]> {
    const res = await this.getClient().get('/v2/account/activities', {
      headers: this.getAuthHeaders(),
      params: {
        activity_type: params?.activity_type || 'FILL',
        direction: params?.direction || 'desc',
        page_size: params?.page_size || 100,
        ...params,
      },
    });
    return res.data || [];
  }

  /**
   * Alpaca Data API client with given credentials (used for market data, not trading).
   * Same API keys work for data.alpaca.markets.
   */
  private getDataApiClient(apiKey: string, apiSecret: string): AxiosInstance {
    return axios.create({
      baseURL: DATA_API_BASE,
      timeout: 15000,
      headers: {
        'APCA-API-KEY-ID': apiKey,
        'APCA-API-SECRET-KEY': apiSecret,
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Get stock snapshot (quote) from Alpaca Data API using the user's credentials.
   * Use this for connection-scoped stock detail so each user's requests use their own Alpaca key (rate limits per user).
   */
  async getStockSnapshot(
    apiKey: string,
    apiSecret: string,
    symbol: string,
  ): Promise<AlpacaStockQuote> {
    const client = this.getDataApiClient(apiKey, apiSecret);
    const sym = symbol.toUpperCase();
    const res = await client.get<Record<string, AlpacaSnapshot>>('/v2/stocks/snapshots', {
      params: { symbols: sym, feed: 'iex' },
    });
    const snapshot = res.data?.[sym];
    if (!snapshot) {
      throw new Error(`Stock ${symbol} not found`);
    }
    const price = toNumOrZero(snapshot.latestTrade?.p ?? snapshot.latestQuote?.ap);
    const prevClose = toNumOrZero(snapshot.prevDailyBar?.c ?? snapshot.dailyBar?.c);
    const volume24h = snapshot.dailyBar?.v ?? 0;
    let change24h = 0;
    let changePercent24h = 0;
    if (prevClose > 0 && price > 0) {
      change24h = price - prevClose;
      changePercent24h = (change24h / prevClose) * 100;
    }
    const q = snapshot.latestQuote;
    const bidPrice = toNum(q?.bp);
    const askPrice = toNum(q?.ap);
    const bidSize = toNum(q?.bs);
    const askSize = toNum(q?.as);
    let spread: number | undefined;
    let spreadPercent: number | undefined;
    if (typeof bidPrice === 'number' && typeof askPrice === 'number' && bidPrice > 0) {
      spread = askPrice - bidPrice;
      spreadPercent = (spread / bidPrice) * 100;
    }
    return {
      symbol: sym,
      price,
      change24h,
      changePercent24h,
      volume24h,
      dayHigh: snapshot.dailyBar?.h ?? 0,
      dayLow: snapshot.dailyBar?.l ?? 0,
      dayOpen: snapshot.dailyBar?.o ?? 0,
      prevClose,
      ...(typeof bidPrice === 'number' && { bidPrice }),
      ...(typeof askPrice === 'number' && { askPrice }),
      ...(typeof bidSize === 'number' && { bidSize }),
      ...(typeof askSize === 'number' && { askSize }),
      ...(typeof spread === 'number' && { spread }),
      ...(typeof spreadPercent === 'number' && { spreadPercent }),
    };
  }

  /**
   * Get historical bars for a stock from Alpaca Data API using the user's credentials.
   */
  async getStockBars(
    apiKey: string,
    apiSecret: string,
    symbol: string,
    timeframe: string = '1Day',
    limit: number = 100,
  ): Promise<AlpacaBarDto[]> {
    const client = this.getDataApiClient(apiKey, apiSecret);
    const sym = symbol.toUpperCase();
    const alpacaTf = this.mapDataApiTimeframe(timeframe);
    const start = this.calculateBarsStart(alpacaTf, limit);
    const res = await client.get<{ bars?: Record<string, AlpacaBarDto[]> }>('/v2/stocks/bars', {
      params: {
        symbols: sym,
        timeframe: alpacaTf,
        start: start.toISOString(),
        limit,
        adjustment: 'split',
        feed: 'iex',
      },
    });
    return res.data?.bars?.[sym] ?? [];
  }

  private mapDataApiTimeframe(tf: string): string {
    const m: Record<string, string> = {
      '1d': '1Day', '4h': '4Hour', '1h': '1Hour', '15m': '15Min', '5m': '5Min', '1m': '1Min',
      '1Day': '1Day', '4Hour': '4Hour', '1Hour': '1Hour', '15Min': '15Min', '5Min': '5Min', '1Min': '1Min',
    };
    return m[tf] ?? tf ?? '1Day';
  }

  private calculateBarsStart(alpacaTf: string, limit: number): Date {
    const now = new Date();
    const tf = alpacaTf.toLowerCase();
    let daysBack = 30;
    if (tf === '1day') daysBack = limit + 10;
    else if (tf === '4hour' || tf === '1hour') daysBack = Math.ceil((limit * 4) / 6) + 10;
    else if (tf === '15min' || tf === '5min' || tf === '1min') daysBack = Math.ceil((limit * 15) / (6 * 60)) + 5;
    const d = new Date(now);
    d.setDate(d.getDate() - daysBack);
    return d;
  }
}
