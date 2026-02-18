import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import {
  AccountBalanceDto,
  AssetBalanceDto,
  CandlestickDto,
  OrderDto,
  PositionDto,
  PortfolioDto,
  TickerPriceDto,
} from '../dto/binance-data.dto';
import { OrderBookDto, RecentTradeDto } from '../dto/orderbook.dto';
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
      this.logger.debug(`Making Bybit public request: ${url}`);
      const response = await this.apiClient.get(url);
      
      // Bybit v5 returns data in result object
      if (response.data.retCode === 0) {
        this.logger.debug(`Bybit API success: retCode=0, result keys: ${Object.keys(response.data.result || {}).join(',')}`);
        return response.data.result;
      } else {
        const errorCode = response.data.retCode;
        const errorMsg = response.data.retMsg || 'Bybit API error';
        
        this.logger.warn(`Bybit API error: retCode=${errorCode}, retMsg=${errorMsg}`);
        
        if (errorCode === 10006) {
          throw new BybitRateLimitException(errorMsg);
        }
        
        throw new BybitApiException(errorMsg, `BYBIT_${errorCode}`);
      }
    } catch (error: any) {
      if (error instanceof BybitApiException || error instanceof BybitRateLimitException) {
        this.logger.warn(`Bybit API exception: ${error.message}`);
        throw error;
      }
      if (error.response?.status === 429) {
        throw new BybitRateLimitException();
      }
      this.logger.error(`Bybit API request failed: ${error.message}, URL: ${url}, Response: ${JSON.stringify(error.response?.data)}`);
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
      this.logger.debug(`Fetching ticker prices for symbols: ${symbolParam}`);
      
      const result = await this.makePublicRequest('/v5/market/tickers', {
        category: 'spot',
        symbol: symbolParam,
      });

      this.logger.debug(`Bybit API response for ${symbolParam}: ${JSON.stringify(result)}`);

      const tickers = (result?.list || []) as BybitTicker[];

      // If no tickers returned, try fallback for single symbol
      if (tickers.length === 0 && symbols.length === 1) {
        this.logger.warn(`No tickers returned for ${symbols[0]}, trying fallback. Full response: ${JSON.stringify(result)}`);
        // Fall through to catch block fallback logic
        throw new Error('Empty ticker list');
      }

      if (tickers.length === 0) {
        this.logger.warn(`No tickers returned for symbols: ${symbolParam}. Full response: ${JSON.stringify(result)}`);
        return [];
      }

      this.logger.debug(`Successfully fetched ${tickers.length} ticker(s) for ${symbolParam}`);

      // For single symbol requests, if API returns a ticker, use it (even if symbol doesn't match exactly)
      // This handles cases where the API might return the ticker with slightly different formatting
      if (symbols.length === 1 && tickers.length > 0) {
        const requestedSymbol = symbols[0].toUpperCase();
        // Try exact match first
        let matchedTicker = tickers.find(t => t.symbol?.toUpperCase() === requestedSymbol);
        
        // If no exact match, use first ticker (API returned it for this symbol, so it's likely correct)
        if (!matchedTicker) {
          this.logger.warn(`Symbol format mismatch for ${requestedSymbol}: API returned ${tickers.map(t => t.symbol).join(',')}, using first ticker`);
          matchedTicker = tickers[0];
        }
        
        return [this.mapTickerToDto(matchedTicker, symbolParam)];
      }

      // For multiple symbols, filter to match requested symbols (case-insensitive)
      const requestedSymbols = symbols.map(s => s.toUpperCase());
      const matchedTickers = tickers.filter(ticker => {
        const tickerSymbol = ticker.symbol?.toUpperCase();
        return requestedSymbols.includes(tickerSymbol);
      });

      if (matchedTickers.length === 0 && tickers.length > 0) {
        this.logger.warn(`Symbol mismatch! Requested: ${requestedSymbols.join(',')}, Got: ${tickers.map(t => t.symbol).join(',')}`);
      }

      return matchedTickers.length > 0 ? matchedTickers.map((ticker) => this.mapTickerToDto(ticker, symbolParam)) : [];
    } catch (error: any) {
      this.logger.warn(`getTickerPrices error for ${symbols.join(',')}: ${error.message}`);
      // Fallback: fetch prices one by one if batch fails
      if (symbols.length === 1) {
        try {
          this.logger.debug(`Trying fallback for single symbol: ${symbols[0]}`);
          const result = await this.makePublicRequest('/v5/market/tickers', {
            category: 'spot',
            symbol: symbols[0],
          });
          
          this.logger.debug(`Fallback API response for ${symbols[0]}: ${JSON.stringify(result)}`);
          
          const tickers = (result?.list || []) as BybitTicker[];
          if (tickers.length > 0) {
            // Find the ticker that matches the requested symbol (case-insensitive)
            const requestedSymbol = symbols[0].toUpperCase();
            let ticker = tickers.find(t => t.symbol?.toUpperCase() === requestedSymbol);
            
            // If no exact match, use the first ticker (API might return it with different casing)
            if (!ticker && tickers.length > 0) {
              this.logger.warn(`Symbol mismatch in fallback: requested ${requestedSymbol}, got ${tickers.map(t => t.symbol).join(',')}, using first ticker`);
              ticker = tickers[0];
            }
            
            if (ticker) {
              const price = parseFloat(String(ticker.lastPrice || '0'));
              
              // Use price24hPcnt if prevPrice24h is not available
              let prevPrice = 0;
              let change24h = 0;
              let changePercent24h = 0;
              
              if (ticker.prevPrice24h) {
                prevPrice = parseFloat(String(ticker.prevPrice24h));
                change24h = price - prevPrice;
                changePercent24h = prevPrice > 0 ? (change24h / prevPrice) * 100 : 0;
              } else if (ticker.price24hPcnt) {
                const percentChange = parseFloat(String(ticker.price24hPcnt));
                changePercent24h = percentChange;
                if (percentChange !== 0 && price > 0) {
                  prevPrice = price / (1 + percentChange / 100);
                  change24h = price - prevPrice;
                }
              }

              this.logger.debug(`Fallback successful for ${symbols[0]}: price=${price}, change24h=${change24h}`);
              return [{
                symbol: ticker.symbol,
                price,
                change24h,
                changePercent24h,
              }];
            }
          } else {
            this.logger.error(`Fallback also returned empty list for ${symbols[0]}. Response: ${JSON.stringify(result)}`);
          }
        } catch (fallbackError: any) {
          this.logger.error(`Fallback also failed for ${symbols[0]}: ${fallbackError.message}`);
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

  /**
   * Maps a Bybit ticker to TickerPriceDto
   */
  private mapTickerToDto(ticker: BybitTicker, requestedSymbol?: string): TickerPriceDto {
    // Log raw ticker data for debugging
    this.logger.debug(`Raw ticker data: ${JSON.stringify(ticker)}`);
    
    // Extract price - try multiple possible field names
    const price = parseFloat(String(ticker.lastPrice || (ticker as any).lastPrice || (ticker as any).price || '0'));
    
    // Calculate 24h change - use prevPrice24h if available, otherwise calculate from price24hPcnt
    let prevPrice = 0;
    let change24h = 0;
    let changePercent24h = 0;
    
    if (ticker.prevPrice24h) {
      prevPrice = parseFloat(String(ticker.prevPrice24h));
      change24h = price - prevPrice;
      changePercent24h = prevPrice > 0 ? (change24h / prevPrice) * 100 : 0;
    } else if (ticker.price24hPcnt) {
      // Calculate prevPrice from percentage change
      const percentChange = parseFloat(String(ticker.price24hPcnt));
      changePercent24h = percentChange;
      if (percentChange !== 0 && price > 0) {
        prevPrice = price / (1 + percentChange / 100);
        change24h = price - prevPrice;
      }
    } else {
      // Fallback: assume no change if we can't calculate
      prevPrice = price;
      change24h = 0;
      changePercent24h = 0;
    }

    this.logger.debug(`Mapped ticker ${ticker.symbol}: price=${price}, prevPrice=${prevPrice}, change24h=${change24h}, changePercent24h=${changePercent24h}`);

    if (price === 0) {
      this.logger.error(`⚠️ Price is 0 for ticker ${ticker.symbol} on Bybit! Raw data: ${JSON.stringify(ticker)}`);
    }

    return {
      symbol: ticker.symbol,
      price,
      change24h,
      changePercent24h,
    };
  }

  /**
   * Maps interval to Bybit format
   */
  private mapInterval(interval: string): string {
    const intervalMap: Record<string, string> = {
      '1m': '1',
      '5m': '5',
      '15m': '15',
      '30m': '30',
      '1h': '60',
      '4h': '240',
      '6h': '360',
      '8h': '480',
      '1d': 'D',
      '1w': 'W',
      '1M': 'M',
    };
    return intervalMap[interval] || '60';
  }

  /**
   * Fetches candlestick/OHLCV data
   */
  async getCandlestickData(
    symbol: string,
    interval: string = '1h',
    limit: number = 100,
    startTime?: number,
    endTime?: number,
  ): Promise<CandlestickDto[]> {
    try {
      const params: Record<string, any> = {
        category: 'spot',
        symbol,
        interval: this.mapInterval(interval),
        limit,
      };

      if (startTime) {
        params.start = startTime;
      }
      if (endTime) {
        params.end = endTime;
      }

      const result = await this.makePublicRequest('/v5/market/kline', params);
      const klines = (result.list || []) as any[];

      return klines.map((kline: any) => ({
        openTime: parseInt(kline[0], 10),
        open: parseFloat(kline[1]),
        high: parseFloat(kline[2]),
        low: parseFloat(kline[3]),
        close: parseFloat(kline[4]),
        volume: parseFloat(kline[5]),
        closeTime: parseInt(kline[0], 10) + (this.getIntervalMs(interval) - 1),
      }));
    } catch (error: any) {
      if (error instanceof BybitApiException || error instanceof BybitRateLimitException) {
        throw error;
      }
      throw new BybitApiException('Failed to fetch candlestick data');
    }
  }

  /**
   * Gets interval duration in milliseconds
   */
  private getIntervalMs(interval: string): number {
    const intervalMap: Record<string, number> = {
      '1m': 60 * 1000,
      '5m': 5 * 60 * 1000,
      '15m': 15 * 60 * 1000,
      '30m': 30 * 60 * 1000,
      '1h': 60 * 60 * 1000,
      '4h': 4 * 60 * 60 * 1000,
      '6h': 6 * 60 * 60 * 1000,
      '8h': 8 * 60 * 60 * 1000,
      '1d': 24 * 60 * 60 * 1000,
      '1w': 7 * 24 * 60 * 60 * 1000,
      '1M': 30 * 24 * 60 * 60 * 1000,
    };
    return intervalMap[interval] || 60 * 60 * 1000;
  }

  /**
   * Places an order on Bybit
   */
  async placeOrder(
    apiKey: string,
    apiSecret: string,
    symbol: string,
    side: 'BUY' | 'SELL',
    type: 'MARKET' | 'LIMIT',
    quantity: number,
    price?: number,
  ): Promise<OrderDto> {
    try {
      if (type === 'LIMIT' && !price) {
        throw new BybitApiException('Price is required for LIMIT orders');
      }

      const params: Record<string, any> = {
        category: 'spot',
        symbol,
        side: side === 'BUY' ? 'Buy' : 'Sell',
        orderType: type === 'MARKET' ? 'Market' : 'Limit',
        qty: quantity.toString(),
      };

      if (type === 'LIMIT') {
        params.price = price!.toString();
      }

      const result = await this.makeSignedRequest('/v5/order/create', apiKey, apiSecret, params, 'POST');
      const order = result as any;

      return {
        orderId: order.orderId || '',
        symbol: order.symbol || symbol,
        side: side,
        type: type,
        quantity: parseFloat(order.qty || quantity.toString()),
        price: parseFloat(order.price || price?.toString() || '0'),
        status: order.orderStatus || 'NEW',
        time: parseInt(order.createdTime || Date.now().toString(), 10),
      };
    } catch (error: any) {
      if (error instanceof BybitApiException || error instanceof BybitInvalidApiKeyException) {
        throw error;
      }
      throw new BybitApiException('Failed to place order');
    }
  }

  /**
   * Places a bracket order with Take Profit and Stop Loss for Bybit
   * Bybit spot doesn't have native OCO, but we can achieve similar functionality using
   * two separate conditional orders: one for take profit, one for stop loss
   * 
   * @param apiKey - Bybit API key
   * @param apiSecret - Bybit API secret  
   * @param symbol - Trading pair symbol (e.g., BTCUSDT)
   * @param side - SELL for closing a long position, BUY for closing a short
   * @param quantity - Amount of the asset to sell/buy
   * @param takeProfitPrice - Price at which to take profit
   * @param stopLossPrice - Price at which to trigger stop loss
   * @returns Object containing both order IDs for tracking
   */
  async placeBracketOrder(
    apiKey: string,
    apiSecret: string,
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: number,
    takeProfitPrice: number,
    stopLossPrice: number,
  ): Promise<{
    takeProfitOrderId: string;
    stopLossOrderId: string;
    symbol: string;
    side: string;
    quantity: number;
    takeProfitPrice: number;
    stopLossPrice: number;
  }> {
    try {
      this.logger.log(
        `Placing bracket order: ${symbol} ${side} qty=${quantity} ` +
        `TP=${takeProfitPrice} SL=${stopLossPrice}`
      );

      // Place Take Profit order (LIMIT order at TP price)
      const tpParams: Record<string, any> = {
        category: 'spot',
        symbol,
        side: side === 'BUY' ? 'Buy' : 'Sell',
        orderType: 'Limit',
        qty: quantity.toString(),
        price: takeProfitPrice.toString(),
        timeInForce: 'GTC',
      };

      const tpResult = await this.makeSignedRequest(
        '/v5/order/create',
        apiKey,
        apiSecret,
        tpParams,
        'POST',
      );

      // Place Stop Loss order using conditional trigger
      // For Bybit spot, we use a trigger order that becomes a market order when stop price is hit
      const slParams: Record<string, any> = {
        category: 'spot',
        symbol,
        side: side === 'BUY' ? 'Buy' : 'Sell',
        orderType: 'Market',
        qty: quantity.toString(),
        triggerPrice: stopLossPrice.toString(),
        triggerDirection: side === 'SELL' ? 2 : 1, // 1=rise above, 2=fall below
        triggerBy: 'LastPrice',
        orderFilter: 'StopOrder',
      };

      const slResult = await this.makeSignedRequest(
        '/v5/order/create',
        apiKey,
        apiSecret,
        slParams,
        'POST',
      );

      this.logger.log(
        `Bracket order placed: TP orderId=${tpResult.orderId}, SL orderId=${slResult.orderId}`
      );

      return {
        takeProfitOrderId: tpResult.orderId || '',
        stopLossOrderId: slResult.orderId || '',
        symbol,
        side,
        quantity,
        takeProfitPrice,
        stopLossPrice,
      };
    } catch (error: any) {
      this.logger.error(`Failed to place bracket order: ${error.message}`);
      if (error instanceof BybitApiException || error instanceof BybitInvalidApiKeyException) {
        throw error;
      }
      throw new BybitApiException('Failed to place bracket order');
    }
  }

  /**
   * Cancels both orders of a bracket order
   */
  async cancelBracketOrder(
    apiKey: string,
    apiSecret: string,
    symbol: string,
    takeProfitOrderId: string,
    stopLossOrderId: string,
  ): Promise<{ tpCancelled: boolean; slCancelled: boolean }> {
    let tpCancelled = false;
    let slCancelled = false;

    try {
      // Cancel TP order
      await this.makeSignedRequest(
        '/v5/order/cancel',
        apiKey,
        apiSecret,
        {
          category: 'spot',
          symbol,
          orderId: takeProfitOrderId,
        },
        'POST',
      );
      tpCancelled = true;
    } catch (error: any) {
      this.logger.warn(`Failed to cancel TP order ${takeProfitOrderId}: ${error.message}`);
    }

    try {
      // Cancel SL order
      await this.makeSignedRequest(
        '/v5/order/cancel',
        apiKey,
        apiSecret,
        {
          category: 'spot',
          symbol,
          orderId: stopLossOrderId,
          orderFilter: 'StopOrder',
        },
        'POST',
      );
      slCancelled = true;
    } catch (error: any) {
      this.logger.warn(`Failed to cancel SL order ${stopLossOrderId}: ${error.message}`);
    }

    return { tpCancelled, slCancelled };
  }

  /**
   * Fetches order book (depth) for a symbol
   */
  async getOrderBook(symbol: string, limit: number = 20): Promise<OrderBookDto> {
    try {
      const result = await this.makePublicRequest('/v5/market/orderbook', {
        category: 'spot',
        symbol,
        limit,
      });

      // Bybit v5 orderbook returns data directly in result
      // Structure: { s: 'BTCUSDT', b: [[price, qty], ...], a: [[price, qty], ...], ts: timestamp }
      const orderbook = result || {};
      const bids = (orderbook.b || []).map((bid: [string, string]) => ({
        price: parseFloat(bid[0]),
        quantity: parseFloat(bid[1]),
      }));

      const asks = (orderbook.a || []).map((ask: [string, string]) => ({
        price: parseFloat(ask[0]),
        quantity: parseFloat(ask[1]),
      }));

      // Calculate cumulative totals
      let bidTotal = 0;
      const bidsWithTotal = bids.map((bid) => {
        bidTotal += bid.quantity;
        return { ...bid, total: bidTotal };
      });

      let askTotal = 0;
      const asksWithTotal = asks.map((ask) => {
        askTotal += ask.quantity;
        return { ...ask, total: askTotal };
      });

      // Calculate spread
      const bestBid = bids[0]?.price || 0;
      const bestAsk = asks[0]?.price || 0;
      const spread = bestAsk - bestBid;
      const spreadPercent = bestBid > 0 ? (spread / bestBid) * 100 : 0;

      return {
        bids: bidsWithTotal,
        asks: asksWithTotal,
        lastUpdateId: orderbook.ts || 0,
        spread,
        spreadPercent,
      };
    } catch (error: any) {
      throw new BybitApiException(`Failed to fetch order book for ${symbol}: ${error.message}`);
    }
  }

  /**
   * Fetches recent trades for a symbol
   */
  async getRecentTrades(symbol: string, limit: number = 50): Promise<RecentTradeDto[]> {
    try {
      const result = await this.makePublicRequest('/v5/market/recent-trade', {
        category: 'spot',
        symbol,
        limit,
      });

      // Bybit v5 recent trades returns data in result.list
      const trades = result.list || [];

      return trades.map((trade: any) => ({
        id: trade.execId || trade.tradeId || '',
        price: parseFloat(trade.price || '0'),
        quantity: parseFloat(trade.qty || trade.size || '0'),
        time: parseInt(trade.time || '0', 10),
        isBuyerMaker: trade.side === 'Sell', // In Bybit, Sell means buyer is maker
      }));
    } catch (error: any) {
      throw new BybitApiException(`Failed to fetch recent trades for ${symbol}: ${error.message}`);
    }
  }
}

