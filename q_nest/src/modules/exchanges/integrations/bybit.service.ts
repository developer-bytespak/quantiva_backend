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
    usdValue: string;
    equity: string;
  }>;
  accountType: string;
  totalEquity: string;
  totalWalletBalance: string;
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
   * Gets Bybit server time to sync with local time.
   * Uses the `timeSecond` field from any v5 API response header, or falls back to local time.
   */
  private async getBybitServerTime(): Promise<number> {
    try {
      // Bybit v5 returns server time in the `time` field of every response envelope.
      // Use a lightweight public endpoint to extract it.
      const response = await this.apiClient.get('/v5/announcements/index', {
        params: { locale: 'en-US', limit: 1 },
        timeout: 5000,
      });
      const serverTime = response.data?.time;
      if (serverTime && typeof serverTime === 'number' && serverTime > 1e12) {
        return serverTime;
      }
    } catch {
      // Fallback to local time — the larger recvWindow (5000ms) handles minor drift
    }
    return Date.now();
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

        // Handle rate limiting — cap wait to 5s to avoid blocking the request for too long
        if (error.response?.status === 429) {
          const retryAfterRaw = parseInt(error.response.headers['retry-after'] || '5', 10);
          const retryAfter = Math.min(retryAfterRaw, 5); // cap at 5 seconds
          this.logger.warn(`Rate limit exceeded, retrying after ${retryAfter}s (attempt ${attempt + 1}/${this.maxRetries})`);
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
      // /v5/user/query-api returns permissions and key info
      const apiInfo = await this.makeSignedRequest('/v5/user/query-api', apiKey, apiSecret);

      // Parse permissions from response (readOnly, trade, transfer, etc.)
      const permissions: string[] = [];
      if (apiInfo?.readOnly === 0) {
        permissions.push('read', 'trade');
      } else {
        permissions.push('read');
      }
      if (apiInfo?.permissions?.Spot?.includes('SpotTrade')) {
        permissions.push('spot_trade');
      }
      if (apiInfo?.permissions?.Wallet?.includes('AccountTransfer')) {
        permissions.push('transfer');
      }

      // Detect account type by probing wallet balance endpoints
      const accountInfo = await this.getAccountInfo(apiKey, apiSecret);

      return {
        valid: true,
        permissions: [...new Set(permissions)],
        accountType: accountInfo.accountType,
      };
    } catch (error: any) {
      if (error instanceof BybitInvalidApiKeyException || error instanceof BybitApiException) {
        throw error;
      }
      throw new BybitInvalidApiKeyException('Failed to verify API key');
    }
  }

  /**
   * Fetches account info from the Bybit UNIFIED trading wallet only.
   *
   * Bybit has two wallets:
   *  - UNIFIED (trading) — the only wallet you can trade from
   *  - FUND (funding) — only for receiving deposits/transfers, cannot trade
   *
   * We only show the UNIFIED balance because that's the tradable amount.
   * If the user has funds in FUND, they must transfer to UNIFIED via Bybit app first.
   */
  async getAccountInfo(apiKey: string, apiSecret: string, _preferredAccountType?: string): Promise<BybitAccountInfo> {
    try {
      const result = await this.makeSignedRequest('/v5/account/wallet-balance', apiKey, apiSecret, {
        accountType: 'UNIFIED',
      });

      const accountData = result.list?.[0];
      const coins = (accountData?.coin || []).filter(
        (c: any) => parseFloat(c.walletBalance || '0') > 0,
      );

      if (coins.length > 0) {
        this.logger.debug(`Bybit UNIFIED wallet: ${coins.length} coins, equity=${accountData?.totalEquity || '0'}`);
      }

      return {
        coin: coins,
        accountType: 'UNIFIED',
        totalEquity: accountData?.totalEquity || '0',
        totalWalletBalance: accountData?.totalWalletBalance || '0',
      };
    } catch (error: any) {
      if (error instanceof BybitInvalidApiKeyException) {
        throw error;
      }
      this.logger.warn(`Bybit UNIFIED wallet-balance failed: ${error?.message ?? error}`);
      return {
        coin: [],
        accountType: 'UNIFIED',
        totalEquity: '0',
        totalWalletBalance: '0',
      };
    }
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
        const total = parseFloat(coin.walletBalance || '0');
        const locked = parseFloat(coin.locked || '0');
        // Bybit UNIFIED accounts return empty string for availableToWithdraw,
        // so fall back to walletBalance - locked
        const free = coin.availableToWithdraw && coin.availableToWithdraw !== ''
          ? parseFloat(coin.availableToWithdraw)
          : total - locked;

        return {
          symbol: coin.coin,
          free: free.toString(),
          locked: locked.toString(),
          total: total.toString(),
        };
      });

    // Use Bybit's pre-calculated totalEquity (USD value of entire account)
    const totalValueUSD = parseFloat(accountInfo.totalEquity || '0') || parseFloat(accountInfo.totalWalletBalance || '0') || 0;

    return {
      assets,
      totalValueUSD,
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
   * Fetches all orders from Bybit: both historical (/v5/order/history) and
   * active stop/conditional orders (/v5/order/realtime with StopOrder filter).
   * This ensures TP/SL orders show as "pending" in the orders page, not missing.
   */
  async getAllOrders(
    apiKey: string,
    apiSecret: string,
    symbol?: string,
    params?: { limit?: number; startTime?: number; endTime?: number },
  ): Promise<any[]> {
    try {
      const reqParams: any = {
        category: 'spot',
        limit: Math.min(params?.limit || 50, 50),
      };
      if (symbol) reqParams.symbol = symbol;
      if (params?.startTime) reqParams.startTime = params.startTime.toString();
      if (params?.endTime) reqParams.endTime = params.endTime.toString();

      const allOrders: any[] = [];
      const seenOrderIds = new Set<string>();

      const mapOrder = (o: any) => {
        const execQty = parseFloat(o.cumExecQty || '0');
        const execValue = parseFloat(o.cumExecValue || '0');
        const avgPrice = execQty > 0 ? execValue / execQty : parseFloat(o.price || o.avgPrice || '0');

        return {
          orderId: o.orderId,
          symbol: o.symbol,
          side: o.side === 'Buy' ? 'BUY' : 'SELL',
          type: o.orderType,
          status: this.mapBybitOrderStatus(o.orderStatus),
          quantity: parseFloat(o.qty || '0'),
          executedQty: execQty,
          cummulativeQuoteQty: execValue,
          price: parseFloat(o.price || '0'),
          stopPrice: parseFloat(o.triggerPrice || '0') || undefined,
          avgPrice,
          timeInForce: o.timeInForce,
          time: parseInt(o.createdTime || '0', 10),
          updateTime: parseInt(o.updatedTime || o.createdTime || '0', 10),
        };
      };

      // 1. Fetch active stop orders (TP/SL that are waiting to trigger)
      try {
        const activeParams: any = { category: 'spot', limit: 50, orderFilter: 'StopOrder' };
        if (symbol) activeParams.symbol = symbol;
        const activeResult = await this.makeSignedRequest('/v5/order/realtime', apiKey, apiSecret, activeParams);
        for (const o of (activeResult.list || [])) {
          seenOrderIds.add(o.orderId);
          allOrders.push(mapOrder(o));
        }
      } catch {
        // Non-fatal — active orders might fail but history still works
      }

      // 2. Fetch order history (filled, cancelled, deactivated)
      let cursor: string | undefined;
      do {
        if (cursor) reqParams.cursor = cursor;
        const result = await this.makeSignedRequest('/v5/order/history', apiKey, apiSecret, reqParams);
        for (const o of (result.list || [])) {
          if (!seenOrderIds.has(o.orderId)) {
            seenOrderIds.add(o.orderId);
            allOrders.push(mapOrder(o));
          }
        }
        cursor = result.nextPageCursor;
      } while (cursor && allOrders.length < (params?.limit || 500));

      return allOrders;
    } catch (error: any) {
      if (error instanceof BybitApiException || error instanceof BybitInvalidApiKeyException) {
        throw error;
      }
      throw new BybitApiException('Failed to fetch order history');
    }
  }

  /**
   * Fetches trade execution history (fills) from Bybit (equivalent of Binance getMyTrades).
   * Uses /v5/execution/list which returns individual trade fills.
   */
  async getMyTrades(
    apiKey: string,
    apiSecret: string,
    symbol?: string,
    params?: { limit?: number; startTime?: number; endTime?: number },
  ): Promise<any[]> {
    try {
      const reqParams: any = {
        category: 'spot',
        limit: Math.min(params?.limit || 100, 100), // Bybit max 100 per page
      };
      if (symbol) reqParams.symbol = symbol;
      if (params?.startTime) reqParams.startTime = params.startTime.toString();
      if (params?.endTime) reqParams.endTime = params.endTime.toString();

      const allTrades: any[] = [];
      let cursor: string | undefined;

      do {
        if (cursor) reqParams.cursor = cursor;
        const result = await this.makeSignedRequest('/v5/execution/list', apiKey, apiSecret, reqParams);
        const trades = result.list || [];

        for (const t of trades) {
          const qty = parseFloat(t.execQty || '0');
          const price = parseFloat(t.execPrice || '0');
          const fee = parseFloat(t.execFee || '0');

          allTrades.push({
            id: t.execId,
            orderId: t.orderId,
            symbol: t.symbol,
            side: t.side === 'Buy' ? 'BUY' : 'SELL',
            isBuyer: t.side === 'Buy',
            price,
            qty,
            quoteQty: qty * price,
            commission: Math.abs(fee),
            commissionAsset: t.feeCurrency || '',
            time: parseInt(t.execTime || '0', 10),
          });
        }

        cursor = result.nextPageCursor;
      } while (cursor && allTrades.length < (params?.limit || 500));

      return allTrades;
    } catch (error: any) {
      if (error instanceof BybitApiException || error instanceof BybitInvalidApiKeyException) {
        throw error;
      }
      throw new BybitApiException('Failed to fetch trade history');
    }
  }

  /**
   * Maps Bybit order status to normalized status matching Binance format.
   */
  private mapBybitOrderStatus(status: string): string {
    const map: Record<string, string> = {
      'New': 'NEW',
      'PartiallyFilled': 'PARTIALLY_FILLED',
      'Filled': 'FILLED',
      'Cancelled': 'CANCELED',
      'PartiallyFilledCanceled': 'CANCELED',
      'Rejected': 'REJECTED',
      'Deactivated': 'EXPIRED',
      'Triggered': 'NEW',
      'Untriggered': 'NEW',
    };
    return map[status] || status;
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
      // Stablecoins pegged to $1 — no need to fetch ticker prices for these
      const stablecoins = new Set(['USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'USDP', 'FDUSD']);

      const coinsWithBalance = accountInfo.coin.filter(
        (c) => parseFloat(c.walletBalance || '0') > 0,
      );

      if (coinsWithBalance.length === 0) {
        return [];
      }

      // Only fetch ticker prices for non-stablecoin assets
      const nonStableCoins = coinsWithBalance.filter((c) => !stablecoins.has(c.coin.toUpperCase()));
      const symbols = nonStableCoins.map((c) => `${c.coin}USDT`);

      // Fetch prices for non-stable symbols
      const prices = symbols.length > 0 ? await this.getTickerPrices(symbols) : [];
      const priceMap = new Map(prices.map((p) => [p.symbol.replace('USDT', ''), p.price]));

      const positions: PositionDto[] = coinsWithBalance.map((coin) => {
        const quantity = parseFloat(coin.walletBalance || '0');
        const isStable = stablecoins.has(coin.coin.toUpperCase());

        // Use ticker price if available, otherwise derive from Bybit's usdValue
        let currentPrice: number;
        if (isStable) {
          currentPrice = 1;
        } else if (priceMap.has(coin.coin)) {
          currentPrice = priceMap.get(coin.coin)!;
        } else {
          // Fallback: derive price from Bybit's pre-calculated usdValue
          const usdValue = parseFloat(coin.usdValue || '0');
          currentPrice = quantity > 0 ? usdValue / quantity : 0;
        }

        return {
          symbol: coin.coin,
          quantity,
          entryPrice: currentPrice,
          currentPrice,
          unrealizedPnl: 0,
          pnlPercent: 0,
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
    // Bybit v5 /market/tickers only accepts a single symbol per request,
    // so we must fetch each symbol individually
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
        } catch (err: any) {
          this.logger.warn(`Failed to fetch ticker for ${symbol}: ${err?.message ?? err}`);
          return null;
        }
      }),
    );

    return prices.filter((p): p is TickerPriceDto => p !== null);
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
   * Transfers funds between Bybit account types (e.g., FUND → UNIFIED).
   * Returns true if transfer succeeded or was not needed.
   */
  async internalTransfer(
    apiKey: string,
    apiSecret: string,
    coin: string,
    amount: string,
    fromAccountType: string,
    toAccountType: string,
  ): Promise<boolean> {
    try {
      const crypto = require('crypto');
      const transferId = crypto.randomUUID();

      const result = await this.makeSignedRequest(
        '/v5/asset/transfer/inter-transfer',
        apiKey,
        apiSecret,
        { transferId, coin, amount, fromAccountType, toAccountType },
        'POST',
      );

      const success = result?.status === 'SUCCESS';
      if (success) {
        this.logger.log(`Bybit internal transfer: ${amount} ${coin} from ${fromAccountType} → ${toAccountType}`);
      }
      return success;
    } catch (error: any) {
      this.logger.warn(`Bybit internal transfer failed: ${error?.message ?? error}`);
      return false;
    }
  }

  /**
   * Places an order on Bybit.
   * Only trades from the UNIFIED wallet. If insufficient balance in UNIFIED,
   * Bybit will return an error — the user must transfer funds from FUND → UNIFIED first.
   *
   * For MARKET BUY orders: the `quantity` is treated as the base coin amount.
   * We fetch the current price to estimate the order value, and if below Bybit's
   * minimum order amount ($5 for most pairs), we use `marketUnit: quoteCoin`
   * to send the USDT value directly instead.
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

      // Fetch instrument info to get basePrecision for qty truncation
      // Fetch instrument info for precision rules
      let basePrecisionDecimals = 8;
      let tickSizeDecimals = 1;
      try {
        const instResult = await this.makePublicRequest('/v5/market/instruments-info', {
          category: 'spot',
          symbol,
        });
        const info = instResult.list?.[0];
        if (info) {
          const bp = info.lotSizeFilter?.basePrecision || '0.000001';
          basePrecisionDecimals = (bp.split('.')[1] || '').replace(/0+$/, '').length;
          const ts = info.priceFilter?.tickSize || '0.1';
          tickSizeDecimals = (ts.split('.')[1] || '').replace(/0+$/, '').length;
        }
      } catch {
        this.logger.warn(`Failed to fetch instrument info for ${symbol}, using defaults`);
      }

      // Truncate quantity to Bybit's allowed precision (e.g., 0.000001 for BTC)
      const qtyFactor = Math.pow(10, basePrecisionDecimals);
      let adjustedQty = Math.floor(quantity * qtyFactor) / qtyFactor;

      const params: Record<string, any> = {
        category: 'spot',
        symbol,
        side: side === 'BUY' ? 'Buy' : 'Sell',
        orderType: type === 'MARKET' ? 'Market' : 'Limit',
        qty: adjustedQty.toString(),
      };

      if (type === 'LIMIT') {
        // Round price to Bybit's tickSize precision (e.g., 0.1 for BTC = 1 decimal)
        const priceFactor = Math.pow(10, tickSizeDecimals);
        const roundedPrice = Math.round(price! * priceFactor) / priceFactor;
        params.price = roundedPrice.toString();
      }

      // For MARKET BUY: always use quoteCoin mode (USDT).
      if (type === 'MARKET' && side === 'BUY') {
        try {
          const tickers = await this.getTickerPrices([symbol]);
          const currentPrice = tickers[0]?.price || 0;
          if (currentPrice > 0) {
            const usdtAmount = quantity * currentPrice;
            params.qty = Math.ceil(usdtAmount * 100) / 100;
            params.qty = params.qty.toString();
            params.marketUnit = 'quoteCoin';
          }
        } catch {
          // If price fetch fails, fall back to base coin qty
        }
      }

      const result = await this.makeSignedRequest('/v5/order/create', apiKey, apiSecret, params, 'POST');
      const orderId = result?.orderId || '';

      // Bybit /v5/order/create only returns orderId — no fill data.
      // For market orders, query the order to get actual fill price and status.
      if (type === 'MARKET' && orderId) {
        try {
          // Wait for Bybit to process the fill before querying
          await this.delay(500);

          const orderDetail = await this.makeSignedRequest('/v5/order/history', apiKey, apiSecret, {
            category: 'spot',
            orderId,
          });

          this.logger.debug(`Order ${orderId} history response: ${JSON.stringify(orderDetail).substring(0, 300)}`);

          const filled = orderDetail.list?.[0];
          if (filled) {
            const execQty = parseFloat(filled.cumExecQty || '0');
            const execValue = parseFloat(filled.cumExecValue || '0');
            const avgPrice = parseFloat(filled.avgPrice || '0') || (execQty > 0 ? execValue / execQty : 0);

            return {
              orderId,
              symbol: filled.symbol || symbol,
              side,
              type,
              quantity: execQty || quantity,
              price: avgPrice,
              status: this.mapBybitOrderStatus(filled.orderStatus || 'New'),
              time: parseInt(filled.createdTime || Date.now().toString(), 10),
            };
          }
        } catch (err: any) {
          this.logger.warn(`Failed to fetch fill details for order ${orderId}: ${err?.message}`);
        }
      }

      // Fallback: return what we have from the create response
      return {
        orderId,
        symbol: result?.symbol || symbol,
        side,
        type,
        quantity,
        price: parseFloat(result?.price || price?.toString() || '0'),
        status: result?.orderStatus ? this.mapBybitOrderStatus(result.orderStatus) : 'NEW',
        time: parseInt(result?.createdTime || Date.now().toString(), 10),
      };
    } catch (error: any) {
      if (error instanceof BybitApiException || error instanceof BybitInvalidApiKeyException) {
        throw error;
      }
      throw new BybitApiException('Failed to place order');
    }
  }

  /**
   * Cancels all active StopOrders for a symbol.
   * Used to clean up leftover TP/SL orders before placing new ones.
   */
  async cancelActiveStopOrders(
    apiKey: string,
    apiSecret: string,
    symbol: string,
  ): Promise<number> {
    let cancelled = 0;
    try {
      const result = await this.makeSignedRequest('/v5/order/realtime', apiKey, apiSecret, {
        category: 'spot',
        symbol,
        orderFilter: 'StopOrder',
        limit: 50,
      });

      for (const order of (result.list || [])) {
        if (order.orderStatus === 'Untriggered' || order.orderStatus === 'New') {
          try {
            await this.makeSignedRequest('/v5/order/cancel', apiKey, apiSecret, {
              category: 'spot',
              symbol,
              orderId: order.orderId,
              orderFilter: 'StopOrder',
            }, 'POST');
            cancelled++;
          } catch (err: any) {
            this.logger.warn(`Failed to cancel stop order ${order.orderId}: ${err?.message}`);
          }
        }
      }

      if (cancelled > 0) {
        this.logger.log(`Cancelled ${cancelled} existing stop order(s) for ${symbol}`);
      }
    } catch (err: any) {
      this.logger.warn(`Failed to fetch active stop orders for ${symbol}: ${err?.message}`);
    }
    return cancelled;
  }

  /**
   * Places a bracket order with Take Profit and Stop Loss for Bybit.
   * Cancels any existing StopOrders for the symbol first to avoid orphans.
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
    orderListId: number;
  }> {
    try {
      // Cancel any existing TP/SL stop orders for this symbol first
      await this.cancelActiveStopOrders(apiKey, apiSecret, symbol);

      this.logger.log(
        `Placing bracket order: ${symbol} ${side} qty=${quantity} ` +
        `TP=${takeProfitPrice} SL=${stopLossPrice}`
      );

      // Fetch instrument info for precision rules
      let basePrecisionDecimals = 8;
      let tickSizeDecimals = 2;
      try {
        const instResult = await this.makePublicRequest('/v5/market/instruments-info', {
          category: 'spot',
          symbol,
        });
        const info = instResult.list?.[0];
        if (info) {
          const bp = info.lotSizeFilter?.basePrecision || '0.000001';
          basePrecisionDecimals = (bp.split('.')[1] || '').replace(/0+$/, '').length;
          const ts = info.priceFilter?.tickSize || '0.01';
          tickSizeDecimals = (ts.split('.')[1] || '').replace(/0+$/, '').length;
        }
      } catch {
        this.logger.warn(`Failed to fetch instrument info for ${symbol}, using defaults`);
      }

      // Truncate qty and round prices to allowed precision
      const qtyFactor = Math.pow(10, basePrecisionDecimals);
      const adjustedQty = Math.floor(quantity * qtyFactor) / qtyFactor;
      const priceFactor = Math.pow(10, tickSizeDecimals);
      const adjustedTP = Math.round(takeProfitPrice * priceFactor) / priceFactor;
      const adjustedSL = Math.round(stopLossPrice * priceFactor) / priceFactor;

      // For Bybit spot, BOTH TP and SL must be StopOrders (trigger-based).
      // Regular LIMIT SELL locks the balance, preventing the SL from being placed.
      // StopOrders don't lock balance until triggered.
      //
      // Also: use actual wallet balance instead of executed qty, because Bybit
      // deducts trading fees from the bought coin (e.g., buy 0.000089 BTC,
      // fee = 0.000001 BTC, actual balance = 0.000088 BTC).
      let sellQty = adjustedQty;
      try {
        const accountInfo = await this.getAccountInfo(apiKey, apiSecret);
        const baseCoin = symbol.replace(/USDT$|USDC$|USD$/, '');
        const coinBalance = accountInfo.coin.find((c) => c.coin === baseCoin);
        if (coinBalance) {
          const actualBalance = parseFloat(coinBalance.walletBalance || '0');
          const truncatedBalance = Math.floor(actualBalance * qtyFactor) / qtyFactor;
          if (truncatedBalance > 0 && truncatedBalance < sellQty) {
            this.logger.debug(`Using actual balance ${truncatedBalance} instead of exec qty ${sellQty} for bracket order`);
            sellQty = truncatedBalance;
          }
        }
      } catch {
        // Non-fatal — use original qty
      }

      const bybitSide = side === 'BUY' ? 'Buy' : 'Sell';

      // TP: StopOrder that triggers when price RISES above TP price → MARKET SELL
      const tpParams: Record<string, any> = {
        category: 'spot',
        symbol,
        side: bybitSide,
        orderType: 'Market',
        qty: sellQty.toString(),
        triggerPrice: adjustedTP.toString(),
        triggerDirection: side === 'SELL' ? 2 : 1, // TP for SELL side: trigger on rise (1)
        triggerBy: 'LastPrice',
        orderFilter: 'StopOrder',
      };

      const tpResult = await this.makeSignedRequest(
        '/v5/order/create',
        apiKey,
        apiSecret,
        tpParams,
        'POST',
      );

      // SL: StopOrder that triggers when price FALLS below SL price → MARKET SELL
      const slParams: Record<string, any> = {
        category: 'spot',
        symbol,
        side: bybitSide,
        orderType: 'Market',
        qty: sellQty.toString(),
        triggerPrice: adjustedSL.toString(),
        triggerDirection: side === 'SELL' ? 1 : 2, // SL for SELL side: trigger on fall (2)
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
        quantity: adjustedQty,
        takeProfitPrice: adjustedTP,
        stopLossPrice: adjustedSL,
        orderListId: 0, // Bybit doesn't have a single OCO orderListId — using 0 as placeholder
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

