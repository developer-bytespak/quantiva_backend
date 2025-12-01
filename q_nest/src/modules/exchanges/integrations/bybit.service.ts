import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import {
  AccountBalanceDto,
  AssetBalanceDto,
  OrderDto,
  PositionDto,
  PortfolioDto,
  TickerPriceDto,
} from '../dto/binance-data.dto';
import {
  BybitApiException,
  BybitRateLimitException,
  BybitInvalidApiKeyException,
} from '../exceptions/bybit.exceptions';

interface BybitAccountInfo {
  coin: Array<{
    coin: string;
    walletBalance: string;
    availableToWithdraw: string;
    locked: string;
  }>;
}

interface BybitOrder {
  orderId: string;
  symbol: string;
  side: 'Buy' | 'Sell';
  orderType: string;
  qty: string;
  price: string;
  orderStatus: string;
  createdTime: string;
}

interface BybitPosition {
  symbol: string;
  side: 'Buy' | 'Sell';
  size: string;
  avgPrice: string;
}

interface BybitTicker {
  symbol: string;
  lastPrice: string;
  prevPrice24h: string;
  price24hPcnt: string;
}

@Injectable()
export class BybitService {
  private readonly logger = new Logger(BybitService.name);
  private readonly baseUrl = 'https://api.bybit.com';
  private readonly apiClient: AxiosInstance;
  private readonly maxRetries = 3;
  private readonly retryDelay = 1000; // 1 second base delay

  constructor() {
    this.apiClient = axios.create({
      baseURL: this.baseUrl,
      timeout: 10000,
    });
  }

  /**
   * Creates a signature for Bybit API requests v5
   * Format: sha256(timestamp + apiKey + recvWindow + queryString/body)
   */
  private createSignature(
    timestamp: number,
    apiKey: string,
    recvWindow: number,
    queryOrBody: string,
    secret: string,
  ): string {
    const crypto = require('crypto');
    const preSign = `${timestamp}${apiKey}${recvWindow}${queryOrBody}`;
    return crypto.createHmac('sha256', secret).update(preSign).digest('hex');
  }

  /**
   * Gets Bybit server time to sync with local time
   */
  private async getBybitServerTime(): Promise<number> {
    try {
      // Bybit v5 doesn't have a dedicated server time endpoint
      // We'll use local time but with a larger recvWindow to account for clock drift
      // Alternatively, we can extract server time from error responses if needed
      const localTime = Date.now();
      
      // Try to get server time from a lightweight public endpoint
      // If that fails, use local time (the larger recvWindow will help)
      try {
        const response = await this.apiClient.get('/v5/market/time');
        if (response.data?.retCode === 0 && response.data?.result) {
          const serverTime = response.data.result.timeSecond || response.data.result.time;
          if (serverTime) {
            // Convert seconds to milliseconds if needed
            return typeof serverTime === 'number' 
              ? (serverTime > 1e12 ? serverTime : serverTime * 1000)
              : parseInt(String(serverTime), 10) * 1000;
          }
        }
      } catch {
        // If endpoint doesn't exist or fails, use local time
      }
      
      return localTime;
    } catch (error) {
      // Fallback to local time if server time fetch fails
      this.logger.warn('Failed to fetch Bybit server time, using local time');
      return Date.now();
    }
  }

  /**
   * Makes a signed request to Bybit API v5 with retry logic
   */
  private async makeSignedRequest(
    endpoint: string,
    apiKey: string,
    apiSecret: string,
    params: Record<string, any> = {},
    method: 'GET' | 'POST' = 'GET',
    retryTimestampError: boolean = true,
  ): Promise<any> {
    // Use Bybit server time for better synchronization
    const serverTime = await this.getBybitServerTime();
    const recvWindow = 60000; // 60 seconds window

    // Filter out any undefined or null values
    const cleanParams: Record<string, string> = {};
    Object.keys(params).forEach((key) => {
      if (params[key] !== undefined && params[key] !== null) {
        cleanParams[key] = String(params[key]);
      }
    });

    let queryOrBody: string;
    let url: string;

    if (method === 'GET') {
      // For GET: sort params alphabetically and create query string
      const sortedKeys = Object.keys(cleanParams).sort();
      queryOrBody = sortedKeys
        .map((key) => `${key}=${cleanParams[key]}`)
        .join('&');
      url = queryOrBody ? `${endpoint}?${queryOrBody}` : endpoint;
    } else {
      // For POST: use JSON body
      queryOrBody = JSON.stringify(cleanParams);
      url = endpoint;
    }

    // Create signature: timestamp + apiKey + recvWindow + queryOrBody
    const signature = this.createSignature(
      serverTime,
      apiKey,
      recvWindow,
      queryOrBody,
      apiSecret,
    );

    // Build headers - Bybit v5 requires signature ONLY in headers
    const headers: Record<string, string> = {
      'X-BAPI-API-KEY': apiKey,
      'X-BAPI-SIGN': signature,
      'X-BAPI-SIGN-TYPE': '2',
      'X-BAPI-TIMESTAMP': serverTime.toString(),
      'X-BAPI-RECV-WINDOW': recvWindow.toString(),
      'Content-Type': 'application/json',
    };

    let lastError: any;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const config: any = {
          headers,
        };

        let response;
        if (method === 'POST') {
          // POST: send params in body, not query
          response = await this.apiClient.post(url, cleanParams, config);
        } else {
          // GET: params are already in URL
          response = await this.apiClient.get(url, config);
        }

        // Bybit v5 returns data in result object
        if (response.data.retCode === 0) {
          return response.data.result;
        } else {
          // Handle Bybit error codes
          const errorCode = response.data.retCode;
          const errorMsg = response.data.retMsg || 'Bybit API error';

          // Invalid API key codes
          if (errorCode === 10003 || errorCode === 10004 || errorCode === 110001 || errorCode === 110003) {
            throw new BybitInvalidApiKeyException(errorMsg);
          }

          // Rate limit
          if (errorCode === 10006 || errorCode === 10015) {
            throw new BybitRateLimitException(errorMsg);
          }

          // Timestamp sync error (110004)
          if (errorCode === 10002 || errorCode === 110004) {
            if (retryTimestampError && attempt < this.maxRetries - 1) {
              this.logger.warn('Timestamp synchronization error, retrying with fresh server time');
              await this.delay(500);
              return this.makeSignedRequest(endpoint, apiKey, apiSecret, params, method, false);
            }
            throw new BybitApiException(
              'Timestamp synchronization failed. Please check your system clock.',
              `BYBIT_${errorCode}`,
            );
          }

          // IP whitelist error
          if (errorCode === 10010) {
            throw new BybitApiException(
              'IP address not whitelisted. Please add your server IP address to your Bybit API key whitelist settings, or remove IP restrictions from your API key.',
              `BYBIT_${errorCode}`,
            );
          }

          throw new BybitApiException(errorMsg, `BYBIT_${errorCode}`);
        }
      } catch (error: any) {
        lastError = error;

        // Re-throw known exceptions
        if (
          error instanceof BybitApiException ||
          error instanceof BybitInvalidApiKeyException ||
          error instanceof BybitRateLimitException
        ) {
          throw error;
        }

        // Handle rate limiting
        if (error.response?.status === 429) {
          const retryAfter = error.response.headers['retry-after'] || 60;
          this.logger.warn(`Rate limit exceeded, retrying after ${retryAfter} seconds`);
          await this.delay(retryAfter * 1000);
          continue;
        }

        // Exponential backoff for other errors
        if (attempt < this.maxRetries - 1) {
          const delay = this.retryDelay * Math.pow(2, attempt);
          this.logger.warn(`Request failed, retrying in ${delay}ms (attempt ${attempt + 1}/${this.maxRetries})`);
          await this.delay(delay);
        }
      }
    }

    // If all retries failed
    if (lastError?.response?.status === 429) {
      throw new BybitRateLimitException();
    }

    throw new BybitApiException(
      lastError?.message || 'Failed to connect to Bybit API',
    );
  }

  /**
   * Makes a public request (no authentication required)
   */
  private async makePublicRequest(endpoint: string, params: Record<string, any> = {}): Promise<any> {
    const queryString = new URLSearchParams(params).toString();
    const url = queryString ? `${endpoint}?${queryString}` : endpoint;

    try {
      const response = await this.apiClient.get(url);
      
      // Bybit v5 returns data in result object
      if (response.data.retCode === 0) {
        return response.data.result;
      } else {
        const errorCode = response.data.retCode;
        const errorMsg = response.data.retMsg || 'Bybit API error';
        
        if (errorCode === 10006) {
          throw new BybitRateLimitException(errorMsg);
        }
        
        throw new BybitApiException(errorMsg, `BYBIT_${errorCode}`);
      }
    } catch (error: any) {
      if (error instanceof BybitApiException || error instanceof BybitRateLimitException) {
        throw error;
      }
      if (error.response?.status === 429) {
        throw new BybitRateLimitException();
      }
      throw new BybitApiException(error.message || 'Failed to fetch data from Bybit');
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Verifies API key by fetching account information
   */
  async verifyApiKey(apiKey: string, apiSecret: string): Promise<{
    valid: boolean;
    permissions: string[];
    accountType: string;
  }> {
    try {
      // Use /v5/user/query-api for better API key verification
      await this.makeSignedRequest('/v5/user/query-api', apiKey, apiSecret);
      
      return {
        valid: true,
        permissions: ['read'], // Bybit doesn't provide detailed permissions in this endpoint
        accountType: 'UNIFIED',
      };
    } catch (error: any) {
      if (error instanceof BybitInvalidApiKeyException || error instanceof BybitApiException) {
        throw error;
      }
      throw new BybitInvalidApiKeyException('Failed to verify API key');
    }
  }

  /**
   * Fetches account info from Bybit (used internally to avoid redundant calls)
   */
  async getAccountInfo(apiKey: string, apiSecret: string): Promise<BybitAccountInfo> {
    const result = await this.makeSignedRequest('/v5/account/wallet-balance', apiKey, apiSecret, {
      accountType: 'UNIFIED',
    });
    
    return {
      coin: result.list?.[0]?.coin || [],
    };
  }

  /**
   * Maps account info to balance DTO (helper to avoid redundant API calls)
   */
  mapAccountToBalance(accountInfo: BybitAccountInfo): AccountBalanceDto {
    const assets: AssetBalanceDto[] = accountInfo.coin
      .filter((coin) => {
        const walletBalance = parseFloat(coin.walletBalance || '0');
        return walletBalance > 0;
      })
      .map((coin) => {
        const free = parseFloat(coin.availableToWithdraw || '0');
        const locked = parseFloat(coin.locked || '0');
        const total = parseFloat(coin.walletBalance || '0');

        return {
          symbol: coin.coin,
          free: free.toString(),
          locked: locked.toString(),
          total: total.toString(),
        };
      });

    return {
      assets,
      totalValueUSD: 0, // Calculated on frontend with prices
    };
  }

  /**
   * Fetches account balance
   */
  async getAccountBalance(apiKey: string, apiSecret: string): Promise<AccountBalanceDto> {
    try {
      const accountInfo = await this.getAccountInfo(apiKey, apiSecret);
      return this.mapAccountToBalance(accountInfo);
    } catch (error: any) {
      if (error instanceof BybitApiException || error instanceof BybitInvalidApiKeyException) {
        throw error;
      }
      throw new BybitApiException('Failed to fetch account balance');
    }
  }

  /**
   * Fetches open orders
   */
  async getOpenOrders(apiKey: string, apiSecret: string, symbol?: string): Promise<OrderDto[]> {
    try {
      const params: any = {
        category: 'spot',
        limit: 50,
      };
      
      if (symbol) {
        params.symbol = symbol;
      }

      const result = await this.makeSignedRequest('/v5/order/realtime', apiKey, apiSecret, params);
      const orders = (result.list || []) as BybitOrder[];

      return orders.map((order) => ({
        orderId: order.orderId,
        symbol: order.symbol,
        side: order.side === 'Buy' ? 'BUY' : 'SELL',
        type: order.orderType,
        quantity: parseFloat(order.qty || '0'),
        price: parseFloat(order.price || '0'),
        status: order.orderStatus,
        time: parseInt(order.createdTime || '0', 10),
      }));
    } catch (error: any) {
      if (error instanceof BybitApiException || error instanceof BybitInvalidApiKeyException) {
        throw error;
      }
      throw new BybitApiException('Failed to fetch open orders');
    }
  }

  /**
   * Fetches current positions from account info (optimized version that reuses account info)
   */
  async getPositionsFromAccount(
    apiKey: string,
    apiSecret: string,
    accountInfo: BybitAccountInfo,
  ): Promise<PositionDto[]> {
    try {
      // Get prices for all assets with balances
      const symbols = accountInfo.coin
        .filter((c) => parseFloat(c.walletBalance || '0') > 0)
        .map((c) => `${c.coin}USDT`);

      if (symbols.length === 0) {
        return [];
      }

      // Fetch prices for all symbols
      const prices = await this.getTickerPrices(symbols);
      const priceMap = new Map(prices.map((p) => [p.symbol.replace('USDT', ''), p.price]));

      const positions: PositionDto[] = accountInfo.coin
        .filter((coin) => {
          const total = parseFloat(coin.walletBalance || '0');
          return total > 0;
        })
        .map((coin) => {
          const quantity = parseFloat(coin.walletBalance || '0');
          const currentPrice = priceMap.get(coin.coin) || 0;
          const entryPrice = currentPrice; // Simplified - would need trade history for accurate entry price
          const unrealizedPnl = (currentPrice - entryPrice) * quantity;
          const pnlPercent = entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0;

          return {
            symbol: coin.coin,
            quantity,
            entryPrice,
            currentPrice,
            unrealizedPnl,
            pnlPercent,
          };
        });

      return positions;
    } catch (error: any) {
      if (error instanceof BybitApiException || error instanceof BybitInvalidApiKeyException) {
        throw error;
      }
      throw new BybitApiException('Failed to fetch positions');
    }
  }

  /**
   * Fetches current positions (spot holdings)
   */
  async getPositions(apiKey: string, apiSecret: string): Promise<PositionDto[]> {
    try {
      const accountInfo = await this.getAccountInfo(apiKey, apiSecret);
      return this.getPositionsFromAccount(apiKey, apiSecret, accountInfo);
    } catch (error: any) {
      if (error instanceof BybitApiException || error instanceof BybitInvalidApiKeyException) {
        throw error;
      }
      throw new BybitApiException('Failed to fetch positions');
    }
  }

  /**
   * Calculates portfolio value from positions (pure calculation, no API calls)
   */
  calculatePortfolioFromPositions(positions: PositionDto[]): PortfolioDto {
    let totalValue = 0;
    let totalCost = 0;

    const assets = positions.map((position) => {
      const value = position.currentPrice * position.quantity;
      const cost = position.entryPrice * position.quantity;
      const pnl = value - cost;
      const pnlPercent = cost > 0 ? (pnl / cost) * 100 : 0;

      totalValue += value;
      totalCost += cost;

      return {
        symbol: position.symbol,
        quantity: position.quantity,
        value,
        cost,
        pnl,
        pnlPercent,
      };
    });

    const totalPnl = totalValue - totalCost;
    const pnlPercent = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;

    return {
      totalValue,
      totalCost,
      totalPnl,
      pnlPercent,
      assets,
    };
  }

  /**
   * Calculates portfolio value from positions (optimized version that reuses account info)
   */
  async getPortfolioFromPositions(
    apiKey: string,
    apiSecret: string,
    accountInfo: BybitAccountInfo,
  ): Promise<PortfolioDto> {
    try {
      const positions = await this.getPositionsFromAccount(apiKey, apiSecret, accountInfo);
      return this.calculatePortfolioFromPositions(positions);
    } catch (error: any) {
      if (error instanceof BybitApiException || error instanceof BybitInvalidApiKeyException) {
        throw error;
      }
      throw new BybitApiException('Failed to calculate portfolio value');
    }
  }

  /**
   * Calculates portfolio value
   */
  async getPortfolioValue(apiKey: string, apiSecret: string): Promise<PortfolioDto> {
    try {
      const accountInfo = await this.getAccountInfo(apiKey, apiSecret);
      return this.getPortfolioFromPositions(apiKey, apiSecret, accountInfo);
    } catch (error: any) {
      if (error instanceof BybitApiException || error instanceof BybitInvalidApiKeyException) {
        throw error;
      }
      throw new BybitApiException('Failed to calculate portfolio value');
    }
  }

  /**
   * Fetches real-time ticker prices
   */
  async getTickerPrices(symbols: string[]): Promise<TickerPriceDto[]> {
    try {
      // Bybit v5 allows fetching multiple tickers
      const symbolParam = symbols.join(',');
      const result = await this.makePublicRequest('/v5/market/tickers', {
        category: 'spot',
        symbol: symbolParam,
      });

      const tickers = (result.list || []) as BybitTicker[];

      return tickers.map((ticker) => {
        const price = parseFloat(String(ticker.lastPrice || '0'));
        const prevPriceStr = ticker.prevPrice24h 
          ? String(ticker.prevPrice24h) 
          : price.toString();
        const prevPrice = parseFloat(prevPriceStr);
        const change24h = price - prevPrice;
        const changePercent24h = prevPrice > 0 ? (change24h / prevPrice) * 100 : 0;

        return {
          symbol: ticker.symbol,
          price,
          change24h,
          changePercent24h,
        };
      });
    } catch (error: any) {
      // Fallback: fetch prices one by one if batch fails
      if (symbols.length === 1) {
        const result = await this.makePublicRequest('/v5/market/tickers', {
          category: 'spot',
          symbol: symbols[0],
        });
        
        const tickers = (result.list || []) as BybitTicker[];
        if (tickers.length > 0) {
          const ticker = tickers[0];
          const price = parseFloat(String(ticker.lastPrice || '0'));
          const prevPriceStr = ticker.prevPrice24h 
            ? String(ticker.prevPrice24h) 
            : price.toString();
          const prevPrice = parseFloat(prevPriceStr);
          const change24h = price - prevPrice;
          const changePercent24h = prevPrice > 0 ? (change24h / prevPrice) * 100 : 0;

          return [{
            symbol: ticker.symbol,
            price,
            change24h,
            changePercent24h,
          }];
        }
      }

      // For multiple symbols, try individual requests
      const prices = await Promise.all(
        symbols.map(async (symbol) => {
          try {
            const result = await this.makePublicRequest('/v5/market/tickers', {
              category: 'spot',
              symbol,
            });
            
            const tickers = (result.list || []) as BybitTicker[];
            if (tickers.length > 0) {
              const ticker = tickers[0];
              const price = parseFloat(String(ticker.lastPrice || '0'));
              const prevPriceStr = ticker.prevPrice24h 
                ? String(ticker.prevPrice24h) 
                : price.toString();
              const prevPrice = parseFloat(prevPriceStr);
              const change24h = price - prevPrice;
              const changePercent24h = prevPrice > 0 ? (change24h / prevPrice) * 100 : 0;

              return {
                symbol: ticker.symbol,
                price,
                change24h,
                changePercent24h,
              };
            }
            return null;
          } catch {
            return null;
          }
        }),
      );

      return prices.filter((p): p is TickerPriceDto => p !== null);
    }
  }
}

