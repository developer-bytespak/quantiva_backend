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
  BinanceApiException,
  BinanceRateLimitException,
  InvalidApiKeyException,
} from '../exceptions/binance.exceptions';

interface BinanceAccountInfo {
  accountType: string;
  permissions: string[];
  balances: Array<{
    asset: string;
    free: string;
    locked: string;
  }>;
}

interface BinanceOrder {
  orderId: number;
  symbol: string;
  side: string;
  type: string;
  origQty: string;
  price: string;
  status: string;
  time: number;
}

@Injectable()
export class BinanceService {
  private readonly logger = new Logger(BinanceService.name);
  private readonly baseUrl = 'https://api.binance.com';
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
   * Creates a signature for Binance API requests
   */
  private createSignature(queryString: string, secret: string): string {
    const crypto = require('crypto');
    return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
  }

  /**
   * Gets Binance server time to sync with local time
   */
  private async getBinanceServerTime(): Promise<number> {
    try {
      const response = await this.makePublicRequest('/api/v3/time');
      return response.serverTime;
    } catch (error) {
      // Fallback to local time if server time fetch fails
      this.logger.warn('Failed to fetch Binance server time, using local time');
      return Date.now();
    }
  }

  /**
   * Makes a signed request to Binance API with retry logic
   */
  private async makeSignedRequest(
    endpoint: string,
    apiKey: string,
    apiSecret: string,
    params: Record<string, any> = {},
    retryTimestampError: boolean = true,
  ): Promise<any> {
    // Use Binance server time for better synchronization
    const serverTime = await this.getBinanceServerTime();
    const recvWindow = 60000; // 60 seconds window (increased from default 5 seconds)

    const queryString = new URLSearchParams({
      ...params,
      timestamp: serverTime.toString(),
      recvWindow: recvWindow.toString(),
    }).toString();

    const signature = this.createSignature(queryString, apiSecret);
    const url = `${endpoint}?${queryString}&signature=${signature}`;

    let lastError: any;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await this.apiClient.get(url, {
          headers: {
            'X-MBX-APIKEY': apiKey,
          },
        });
        return response.data;
      } catch (error: any) {
        lastError = error;

        // Handle rate limiting
        if (error.response?.status === 429) {
          const retryAfter = error.response.headers['retry-after'] || 60;
          this.logger.warn(`Rate limit exceeded, retrying after ${retryAfter} seconds`);
          await this.delay(retryAfter * 1000);
          continue;
        }

        // Handle specific Binance error codes
        if (error.response?.data?.code) {
          const binanceCode = error.response.data.code;
          const binanceMsg = error.response.data.msg || 'Binance API error';

          if (binanceCode === -2015 || binanceCode === -1022) {
            throw new InvalidApiKeyException(binanceMsg);
          }

          if (binanceCode === -1003) {
            throw new BinanceRateLimitException(binanceMsg);
          }

          // Handle timestamp synchronization error (-1021)
          if (binanceCode === -1021) {
            if (retryTimestampError && attempt < this.maxRetries - 1) {
              // Retry with fresh server time (only once to avoid infinite recursion)
              this.logger.warn('Timestamp synchronization error, retrying with fresh server time');
              await this.delay(500); // Short delay before retry
              // Retry with fresh timestamp, but disable further timestamp retries
              return this.makeSignedRequest(endpoint, apiKey, apiSecret, params, false);
            }
            throw new BinanceApiException(
              'Timestamp synchronization failed. Please check your system clock.',
              `BINANCE_${binanceCode}`,
            );
          }

          throw new BinanceApiException(binanceMsg, `BINANCE_${binanceCode}`);
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
      throw new BinanceRateLimitException();
    }

    throw new BinanceApiException(
      lastError?.message || 'Failed to connect to Binance API',
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
      return response.data;
    } catch (error: any) {
      if (error.response?.status === 429) {
        throw new BinanceRateLimitException();
      }
      throw new BinanceApiException(error.message || 'Failed to fetch data from Binance');
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
      const accountInfo = await this.makeSignedRequest('/api/v3/account', apiKey, apiSecret) as BinanceAccountInfo;
      
      return {
        valid: true,
        permissions: accountInfo.permissions || [],
        accountType: accountInfo.accountType || 'SPOT',
      };
    } catch (error: any) {
      if (error instanceof InvalidApiKeyException || error instanceof BinanceApiException) {
        throw error;
      }
      throw new InvalidApiKeyException('Failed to verify API key');
    }
  }

  /**
   * Fetches account info from Binance (used internally to avoid redundant calls)
   */
  async getAccountInfo(apiKey: string, apiSecret: string): Promise<BinanceAccountInfo> {
    return this.makeSignedRequest('/api/v3/account', apiKey, apiSecret) as Promise<BinanceAccountInfo>;
  }

  /**
   * Maps account info to balance DTO (helper to avoid redundant API calls)
   */
  mapAccountToBalance(accountInfo: BinanceAccountInfo): AccountBalanceDto {
    const assets: AssetBalanceDto[] = accountInfo.balances
      .filter((balance) => parseFloat(balance.free) > 0 || parseFloat(balance.locked) > 0)
      .map((balance) => ({
        symbol: balance.asset,
        free: balance.free,
        locked: balance.locked,
        total: (parseFloat(balance.free) + parseFloat(balance.locked)).toString(),
      }));

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
      if (error instanceof BinanceApiException || error instanceof InvalidApiKeyException) {
        throw error;
      }
      throw new BinanceApiException('Failed to fetch account balance');
    }
  }

  /**
   * Fetches open orders
   */
  async getOpenOrders(apiKey: string, apiSecret: string, symbol?: string): Promise<OrderDto[]> {
    try {
      const params = symbol ? { symbol } : {};
      const orders = await this.makeSignedRequest('/api/v3/openOrders', apiKey, apiSecret, params) as BinanceOrder[];

      return orders.map((order) => ({
        orderId: order.orderId.toString(),
        symbol: order.symbol,
        side: order.side as 'BUY' | 'SELL',
        type: order.type,
        quantity: parseFloat(order.origQty),
        price: parseFloat(order.price || '0'),
        status: order.status,
        time: order.time,
      }));
    } catch (error: any) {
      if (error instanceof BinanceApiException || error instanceof InvalidApiKeyException) {
        throw error;
      }
      throw new BinanceApiException('Failed to fetch open orders');
    }
  }

  /**
   * Fetches current positions from account info (optimized version that reuses account info)
   */
  async getPositionsFromAccount(
    apiKey: string,
    apiSecret: string,
    accountInfo: BinanceAccountInfo,
  ): Promise<PositionDto[]> {
    try {
      // Get prices for all assets with balances
      const symbols = accountInfo.balances
        .filter((b) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0)
        .map((b) => `${b.asset}USDT`);

      if (symbols.length === 0) {
        return [];
      }

      // Fetch prices for all symbols
      const prices = await this.getTickerPrices(symbols);
      const priceMap = new Map(prices.map((p) => [p.symbol.replace('USDT', ''), p.price]));

      const positions: PositionDto[] = accountInfo.balances
        .filter((balance) => {
          const total = parseFloat(balance.free) + parseFloat(balance.locked);
          return total > 0;
        })
        .map((balance) => {
          const quantity = parseFloat(balance.free) + parseFloat(balance.locked);
          const currentPrice = priceMap.get(balance.asset) || 0;
          const entryPrice = currentPrice; // Simplified - would need trade history for accurate entry price
          const unrealizedPnl = (currentPrice - entryPrice) * quantity;
          const pnlPercent = entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0;

          return {
            symbol: balance.asset,
            quantity,
            entryPrice,
            currentPrice,
            unrealizedPnl,
            pnlPercent,
          };
        });

      return positions;
    } catch (error: any) {
      if (error instanceof BinanceApiException || error instanceof InvalidApiKeyException) {
        throw error;
      }
      throw new BinanceApiException('Failed to fetch positions');
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
      if (error instanceof BinanceApiException || error instanceof InvalidApiKeyException) {
        throw error;
      }
      throw new BinanceApiException('Failed to fetch positions');
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
    accountInfo: BinanceAccountInfo,
  ): Promise<PortfolioDto> {
    try {
      const positions = await this.getPositionsFromAccount(apiKey, apiSecret, accountInfo);
      return this.calculatePortfolioFromPositions(positions);
    } catch (error: any) {
      if (error instanceof BinanceApiException || error instanceof InvalidApiKeyException) {
        throw error;
      }
      throw new BinanceApiException('Failed to calculate portfolio value');
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
      if (error instanceof BinanceApiException || error instanceof InvalidApiKeyException) {
        throw error;
      }
      throw new BinanceApiException('Failed to calculate portfolio value');
    }
  }

  /**
   * Fetches real-time ticker prices
   */
  async getTickerPrices(symbols: string[]): Promise<TickerPriceDto[]> {
    try {
      // Binance API allows fetching multiple tickers
      const symbolParam = symbols.map((s) => `"${s}"`).join(',');
      const tickers = await this.makePublicRequest('/api/v3/ticker/24hr', {
        symbols: `[${symbolParam}]`,
      });

      if (!Array.isArray(tickers)) {
        // If single symbol, wrap in array
        return [this.mapTickerToDto(tickers)];
      }

      return tickers.map((ticker: any) => this.mapTickerToDto(ticker));
    } catch (error: any) {
      // Fallback: fetch prices one by one if batch fails
      if (symbols.length === 1) {
        const ticker = await this.makePublicRequest('/api/v3/ticker/24hr', { symbol: symbols[0] });
        return [this.mapTickerToDto(ticker)];
      }

      // For multiple symbols, try individual requests
      const prices = await Promise.all(
        symbols.map(async (symbol) => {
          try {
            const ticker = await this.makePublicRequest('/api/v3/ticker/24hr', { symbol });
            return this.mapTickerToDto(ticker);
          } catch {
            return null;
          }
        }),
      );

      return prices.filter((p): p is TickerPriceDto => p !== null);
    }
  }

  private mapTickerToDto(ticker: any): TickerPriceDto {
    const price = parseFloat(ticker.lastPrice || ticker.price || '0');
    const openPrice = parseFloat(ticker.openPrice || price);
    const change24h = price - openPrice;
    const changePercent24h = openPrice > 0 ? (change24h / openPrice) * 100 : 0;

    return {
      symbol: ticker.symbol,
      price,
      change24h,
      changePercent24h,
    };
  }
}

