import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';

/**
 * Alpaca supported cryptocurrencies (base symbols without /USD)
 * These are the crypto assets available for trading on Alpaca
 */
export const ALPACA_SUPPORTED_CRYPTO = [
  'BTC', 'ETH', 'LTC', 'BCH', 'USDT', 'USDC', 'XRP', 'DOGE', 
  'SHIB', 'MATIC', 'UNI', 'AAVE', 'LINK', 'MKR', 'ALGO', 
  'AVAX', 'DOT', 'SOL', 'ADA', 'TRX', 'XLM', 'ETC', 'FIL',
  'GRT', 'SUSHI', 'YFI', 'BAT', 'CRV'
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
      const res = await this.getClient().get('/v2/account', {
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
    const res = await this.getClient().get('/v2/account', {
      headers: this.getAuthHeaders(apiKey, apiSecret),
    });
    return res.data;
  }

  /**
   * Get account balance - simplified version
   */
  async getAccountBalance(): Promise<any> {
    const account = await this.getAccountInfo();
    return {
      balances: [
        {
          asset: 'USD',
          free: parseFloat(account.cash || 0),
          locked: 0,
        },
      ],
      totalBalance: parseFloat(account.portfolio_value || 0),
    };
  }

  /**
   * Get all positions
   */
  async getPositions(apiKey?: string, apiSecret?: string): Promise<any[]> {
    const res = await this.getClient().get('/v2/positions', {
      headers: this.getAuthHeaders(apiKey, apiSecret),
    });
    return res.data || [];
  }

  /**
   * Get orders with optional filters
   */
  async getOrders(apiKey?: string, apiSecret?: string, status = 'open'): Promise<any[]> {
    const res = await this.getClient().get('/v2/orders', {
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
    const res = await this.getClient().get('/v2/orders', {
      headers: this.getAuthHeaders(),
      params: {
        status: 'all',
        limit: options?.limit || 100,
      },
    });
    return res.data || [];
  }

  /**
   * Place a market or limit order
   */
  async placeOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    type: 'MARKET' | 'LIMIT',
    quantity: number,
    limitPrice?: number,
  ): Promise<any> {
    try {
      // Convert symbol format: BTCUSDT -> BTC/USD
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

      this.logger.log(`Placing ${type} ${side} order: ${quantity} ${alpacaSymbol}`);

      const res = await this.getClient().post('/v2/orders', orderData, {
        headers: this.getAuthHeaders(),
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
   * Place a bracket order (entry + take profit + stop loss)
   * This is Alpaca's equivalent to Binance OCO
   */
  async placeBracketOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: number,
    takeProfitPrice: number,
    stopLossPrice: number,
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

      this.logger.log(
        `Placing bracket order: ${quantity} ${alpacaSymbol}, TP=${takeProfitPrice}, SL=${stopLossPrice}`,
      );

      const res = await this.getClient().post('/v2/orders', orderData, {
        headers: this.getAuthHeaders(),
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

    // Default: assume it's base/USD
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
}
