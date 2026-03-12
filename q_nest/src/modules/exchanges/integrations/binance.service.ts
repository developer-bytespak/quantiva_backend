import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
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
  BinanceApiException,
  BinanceRateLimitException,
  InvalidApiKeyException,
} from '../exceptions/binance.exceptions';
import { BinanceMarketStreamService } from '../../binance/binance-market-stream.service';

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

  // IP ban guard: when Binance returns HTTP 418 (IP ban), stop all REST until TTL expires
  private ipBannedUntil = 0;
  private proxyEnabled = false;

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly marketStream?: BinanceMarketStreamService,
  ) {
    const proxyUrl = this.configService.get<string>('BINANCE_PROXY_URL');
    this.apiClient = axios.create({
      baseURL: this.baseUrl,
      timeout: 10000,
      ...(proxyUrl ? { httpsAgent: new HttpsProxyAgent(proxyUrl), proxy: false } : {}),
    });
    if (proxyUrl) {
      this.proxyEnabled = true;
      this.logger.log(`Binance REST proxy enabled: ${proxyUrl.replace(/\/\/.*@/, '//<redacted>@')}`);
    }
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
  // Cache server time to avoid fetching it on every single signed request (weight 1 each)
  private cachedServerTimeDelta: number | null = null; // offset = serverTime - localTime
  private serverTimeFetchedAt = 0;
  private readonly SERVER_TIME_CACHE_MS = 60_000; // 1 minute

  private async getBinanceServerTime(): Promise<number> {
    const now = Date.now();
    if (this.cachedServerTimeDelta !== null && now - this.serverTimeFetchedAt < this.SERVER_TIME_CACHE_MS) {
      return now + this.cachedServerTimeDelta;
    }
    try {
      const response = await this.makePublicRequest('/api/v3/time');
      this.cachedServerTimeDelta = response.serverTime - Date.now();
      this.serverTimeFetchedAt = Date.now();
      return response.serverTime;
    } catch (error) {
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
    // Respect active IP ban — fail fast instead of wasting weight on banned IP
    // Skip guard when proxy is active: proxy uses a different IP that isn't banned
    if (!this.proxyEnabled && Date.now() < this.ipBannedUntil) {
      const remainingSec = Math.ceil((this.ipBannedUntil - Date.now()) / 1000);
      throw new BinanceApiException(`Binance IP ban active for ${remainingSec}s more. Requests blocked.`);
    }

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

        // Handle IP ban (418) — do NOT retry, record ban expiry and abort
        if (error.response?.status === 418) {
          const bannedUntil = error.response.data?.bannedUntil as number | undefined;
          this.ipBannedUntil = bannedUntil ?? (Date.now() + 60 * 60 * 1000); // default 1h
          const remainingSec = Math.ceil((this.ipBannedUntil - Date.now()) / 1000);
          this.logger.error(`══ BINANCE IP BAN ══ Blocked for ${remainingSec}s | All REST requests will fail fast until ban lifts`);
          throw new BinanceApiException(`Binance IP banned for ${remainingSec}s. Use WebSocket streams for live data.`);
        }

        // Handle rate limiting (429) — back off, then retry
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
    // Respect active IP ban — fail fast instead of wasting weight on banned IP
    // Skip guard when proxy is active: proxy uses a different IP that isn't banned
    if (!this.proxyEnabled && Date.now() < this.ipBannedUntil) {
      const remainingSec = Math.ceil((this.ipBannedUntil - Date.now()) / 1000);
      throw new BinanceApiException(`Binance IP ban active for ${remainingSec}s more. Requests blocked.`);
    }

    const queryString = new URLSearchParams(params).toString();
    const url = queryString ? `${endpoint}?${queryString}` : endpoint;

    try {
      const response = await this.apiClient.get(url);
      return response.data;
    } catch (error: any) {
      // Handle IP ban (418)
      if (error.response?.status === 418) {
        const bannedUntil = error.response.data?.bannedUntil as number | undefined;
        this.ipBannedUntil = bannedUntil ?? (Date.now() + 60 * 60 * 1000);
        const remainingSec = Math.ceil((this.ipBannedUntil - Date.now()) / 1000);
        this.logger.error(`══ BINANCE IP BAN ══ Blocked for ${remainingSec}s | All REST requests will fail fast until ban lifts`);
        throw new BinanceApiException(`Binance IP banned for ${remainingSec}s.`);
      }
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
      if (
        error instanceof InvalidApiKeyException ||
        error instanceof BinanceApiException ||
        error instanceof BinanceRateLimitException
      ) {
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
      // Stablecoins priced at $1 — no Binance ticker exists for USDTUSDT etc.
      const STABLECOINS = new Set(['USDT', 'BUSD', 'USDC', 'TUSD', 'USDP', 'DAI', 'FDUSD']);

      const nonZeroBalances = accountInfo.balances.filter((b) => {
        const total = parseFloat(b.free) + parseFloat(b.locked);
        return total > 0;
      });

      // Build price map — stablecoins are always $1
      const priceMap = new Map<string, number>();
      for (const stable of STABLECOINS) priceMap.set(stable, 1);

      // Stream-first: serve prices from WS cache — zero REST weight
      const nonStableBalances = nonZeroBalances.filter((b) => !STABLECOINS.has(b.asset));
      const symbolsNeedingRest: string[] = [];

      if (this.marketStream?.isConnected()) {
        for (const b of nonStableBalances) {
          const streamPrice = this.marketStream.getPrice(`${b.asset}USDT`);
          if (streamPrice !== undefined) {
            priceMap.set(b.asset, streamPrice);
          } else {
            symbolsNeedingRest.push(`${b.asset}USDT`);
          }
        }
      } else {
        symbolsNeedingRest.push(...nonStableBalances.map((b) => `${b.asset}USDT`));
      }

      // Only hit REST for symbols the stream doesn't know about
      if (symbolsNeedingRest.length > 0) {
        const prices = await this.getTickerPrices(symbolsNeedingRest);
        for (const p of prices) priceMap.set(p.symbol.replace('USDT', ''), p.price);
      }

      const positions: PositionDto[] = nonZeroBalances.map((balance) => {
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
   * Fetches real-time ticker prices — stream-first, REST fallback.
   */
  async getTickerPrices(symbols: string[]): Promise<TickerPriceDto[]> {
    const result: TickerPriceDto[] = [];
    const symbolsNeedingRest: string[] = [];

    // Stream-first: serve from WS cache — zero REST weight
    if (this.marketStream?.isConnected()) {
      for (const symbol of symbols) {
        const stats = this.marketStream.get24hStats(symbol);
        if (stats) {
          result.push({
            symbol: stats.symbol,
            price: stats.price,
            change24h: stats.price - stats.open,
            changePercent24h: stats.priceChangePercent,
          });
        } else {
          symbolsNeedingRest.push(symbol);
        }
      }
    } else {
      symbolsNeedingRest.push(...symbols);
    }

    // Only hit REST for symbols the stream doesn't know about
    if (symbolsNeedingRest.length > 0) {
      try {
        const symbolParam = symbolsNeedingRest.map((s) => `"${s}"`).join(',');
        const tickers = await this.makePublicRequest('/api/v3/ticker/24hr', {
          symbols: `[${symbolParam}]`,
        });

        const arr = Array.isArray(tickers) ? tickers : [tickers];
        result.push(...arr.map((ticker: any) => this.mapTickerToDto(ticker)));
      } catch (error: any) {
        // Fallback: fetch prices one by one if batch fails
        const prices = await Promise.all(
          symbolsNeedingRest.map(async (symbol) => {
            try {
              const ticker = await this.makePublicRequest('/api/v3/ticker/24hr', { symbol });
              return this.mapTickerToDto(ticker);
            } catch {
              return null;
            }
          }),
        );
        result.push(...prices.filter((p): p is TickerPriceDto => p !== null));
      }
    }

    return result;
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

  /**
   * Maps Binance interval to API format
   */
  private mapInterval(interval: string): string {
    const intervalMap: Record<string, string> = {
      '1m': '1m',
      '5m': '5m',
      '15m': '15m',
      '30m': '30m',
      '1h': '1h',
      '4h': '4h',
      '8h': '8h',
      '1d': '1d',
      '1w': '1w',
      '1M': '1M',
    };
    return intervalMap[interval] || '1h';
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
        symbol,
        interval: this.mapInterval(interval),
        limit,
      };

      if (startTime) {
        params.startTime = startTime;
      }
      if (endTime) {
        params.endTime = endTime;
      }

      const klines = await this.makePublicRequest('/api/v3/klines', params);

      return klines.map((kline: any[]) => ({
        openTime: kline[0],
        open: parseFloat(kline[1]),
        high: parseFloat(kline[2]),
        low: parseFloat(kline[3]),
        close: parseFloat(kline[4]),
        volume: parseFloat(kline[5]),
        closeTime: kline[6],
      }));
    } catch (error: any) {
      if (error instanceof BinanceApiException || error instanceof BinanceRateLimitException) {
        throw error;
      }
      throw new BinanceApiException('Failed to fetch candlestick data');
    }
  }

  /**
   * Makes a signed POST request to Binance API
   */
  private async makeSignedPostRequest(
    endpoint: string,
    apiKey: string,
    apiSecret: string,
    params: Record<string, any> = {},
  ): Promise<any> {
    const serverTime = await this.getBinanceServerTime();
    const recvWindow = 60000;

    const queryString = new URLSearchParams({
      ...params,
      timestamp: serverTime.toString(),
      recvWindow: recvWindow.toString(),
    }).toString();

    const signature = this.createSignature(queryString, apiSecret);
    const url = `${endpoint}?${queryString}&signature=${signature}`;

    try {
      const response = await this.apiClient.post(url, null, {
        headers: {
          'X-MBX-APIKEY': apiKey,
        },
      });
      return response.data;
    } catch (error: any) {
      if (error.response?.data?.code) {
        const binanceCode = error.response.data.code;
        const binanceMsg = error.response.data.msg || 'Binance API error';

        if (binanceCode === -2015 || binanceCode === -1022) {
          throw new InvalidApiKeyException(binanceMsg);
        }

        if (binanceCode === -1003) {
          throw new BinanceRateLimitException(binanceMsg);
        }

        throw new BinanceApiException(binanceMsg, `BINANCE_${binanceCode}`);
      }
      throw new BinanceApiException(error.message || 'Failed to place order');
    }
  }

  /**
   * Makes a signed DELETE request to Binance API
   */
  private async makeSignedDeleteRequest(
    endpoint: string,
    apiKey: string,
    apiSecret: string,
    params: Record<string, any> = {},
  ): Promise<any> {
    const serverTime = await this.getBinanceServerTime();
    const recvWindow = 60000;

    const queryString = new URLSearchParams({
      ...params,
      timestamp: serverTime.toString(),
      recvWindow: recvWindow.toString(),
    }).toString();

    const signature = this.createSignature(queryString, apiSecret);
    const url = `${endpoint}?${queryString}&signature=${signature}`;

    try {
      const response = await this.apiClient.delete(url, {
        headers: {
          'X-MBX-APIKEY': apiKey,
        },
      });
      return response.data;
    } catch (error: any) {
      if (error.response?.data?.code) {
        const binanceCode = error.response.data.code;
        const binanceMsg = error.response.data.msg || 'Binance API error';

        if (binanceCode === -2015 || binanceCode === -1022) {
          throw new InvalidApiKeyException(binanceMsg);
        }

        if (binanceCode === -1003) {
          throw new BinanceRateLimitException(binanceMsg);
        }

        throw new BinanceApiException(binanceMsg, `BINANCE_${binanceCode}`);
      }
      throw new BinanceApiException(error.message || 'Failed to delete order');
    }
  }

  /**
   * Places an order on Binance
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
        throw new BinanceApiException('Price is required for LIMIT orders');
      }

      const params: Record<string, any> = {
        symbol,
        side: side.toUpperCase(),
        type: type === 'MARKET' ? 'MARKET' : 'LIMIT',
        quantity: quantity.toString(),
      };

      if (type === 'LIMIT') {
        params.price = price!.toString();
        params.timeInForce = 'GTC'; // Good Till Cancel
      }

      const order = await this.makeSignedPostRequest('/api/v3/order', apiKey, apiSecret, params);

      return {
        orderId: order.orderId.toString(),
        symbol: order.symbol,
        side: order.side as 'BUY' | 'SELL',
        type: order.type,
        quantity: parseFloat(order.executedQty || order.origQty || '0'),
        price: parseFloat(order.price || '0'),
        status: order.status,
        time: order.transactTime || order.updateTime || Date.now(),
      };
    } catch (error: any) {
      if (error instanceof BinanceApiException || error instanceof InvalidApiKeyException) {
        throw error;
      }
      throw new BinanceApiException('Failed to place order');
    }
  }

  /**
   * Places an OCO (One-Cancels-Other) order for automatic stop-loss and take-profit
   * When either the stop-loss or take-profit is triggered, the other order is automatically cancelled
   * 
   * @param apiKey - Binance API key
   * @param apiSecret - Binance API secret
   * @param symbol - Trading pair symbol (e.g., BTCUSDT)
   * @param side - SELL for closing a long position, BUY for closing a short
   * @param quantity - Amount of the asset to sell/buy
   * @param takeProfitPrice - Price at which to take profit (limit order)
   * @param stopLossPrice - Price at which to trigger stop loss (stop price)
   * @param stopLimitPrice - Price for the stop-loss limit order (optional, defaults to slightly offset from stopLossPrice)
   */
  async placeOcoOrder(
    apiKey: string,
    apiSecret: string,
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
    try {
      // If stopLimitPrice not provided, use a small offset from stopLossPrice
      const effectiveStopLimitPrice = stopLimitPrice || 
        (side === 'SELL' 
          ? stopLossPrice * 0.995  // 0.5% below stop price for sells
          : stopLossPrice * 1.005  // 0.5% above stop price for buys
        );

      const params: Record<string, any> = {
        symbol,
        side: side.toUpperCase(),
        quantity: quantity.toString(),
        price: takeProfitPrice.toFixed(8),        // Take profit limit price
        stopPrice: stopLossPrice.toFixed(8),      // Stop trigger price
        stopLimitPrice: effectiveStopLimitPrice.toFixed(8), // Stop limit price
        stopLimitTimeInForce: 'GTC',
      };

      this.logger.log(
        `Placing OCO order: ${symbol} ${side} qty=${quantity} ` +
        `TP=${takeProfitPrice} SL=${stopLossPrice}`
      );

      const result = await this.makeSignedPostRequest('/api/v3/order/oco', apiKey, apiSecret, params);

      this.logger.log(`OCO order placed successfully: orderListId=${result.orderListId}`);

      return {
        orderListId: result.orderListId,
        contingencyType: result.contingencyType,
        listStatusType: result.listStatusType,
        listOrderStatus: result.listOrderStatus,
        listClientOrderId: result.listClientOrderId,
        transactionTime: result.transactionTime,
        symbol: result.symbol,
        orders: result.orders || [],
        orderReports: result.orderReports || [],
      };
    } catch (error: any) {
      this.logger.error(`Failed to place OCO order: ${error.message}`);
      if (error instanceof BinanceApiException || error instanceof InvalidApiKeyException) {
        throw error;
      }
      throw new BinanceApiException('Failed to place OCO order');
    }
  }

  /**
   * Cancels an OCO order list
   */
  async cancelOcoOrder(
    apiKey: string,
    apiSecret: string,
    symbol: string,
    orderListId: number,
  ): Promise<any> {
    try {
      const result = await this.makeSignedDeleteRequest(
        '/api/v3/orderList',
        apiKey,
        apiSecret,
        { symbol, orderListId },
      );

      this.logger.log(`OCO order cancelled: orderListId=${orderListId}`);
      return result;
    } catch (error: any) {
      this.logger.error(`Failed to cancel OCO order: ${error.message}`);
      if (error instanceof BinanceApiException || error instanceof InvalidApiKeyException) {
        throw error;
      }
      throw new BinanceApiException('Failed to cancel OCO order');
    }
  }

  /**
   * Gets all OCO orders for a symbol
   */
  async getOcoOrders(
    apiKey: string,
    apiSecret: string,
    symbol?: string,
    limit?: number,
  ): Promise<any[]> {
    try {
      const params: Record<string, any> = {};
      if (symbol) params.symbol = symbol;
      if (limit) params.limit = limit;

      const result = await this.makeSignedRequest('/api/v3/allOrderList', apiKey, apiSecret, params);
      return result || [];
    } catch (error: any) {
      this.logger.error(`Failed to get OCO orders: ${error.message}`);
      if (error instanceof BinanceApiException || error instanceof InvalidApiKeyException) {
        throw error;
      }
      throw new BinanceApiException('Failed to get OCO orders');
    }
  }

  /**
   * Fetches order book (depth) for a symbol
   */
  async getOrderBook(symbol: string, limit: number = 20): Promise<OrderBookDto> {
    try {
      const depth = await this.makePublicRequest('/api/v3/depth', {
        symbol,
        limit,
      });

      const bids = depth.bids.map((bid: [string, string]) => ({
        price: parseFloat(bid[0]),
        quantity: parseFloat(bid[1]),
      }));

      const asks = depth.asks.map((ask: [string, string]) => ({
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
        lastUpdateId: depth.lastUpdateId,
        spread,
        spreadPercent,
      };
    } catch (error: any) {
      throw new BinanceApiException(`Failed to fetch order book for ${symbol}: ${error.message}`);
    }
  }

  /**
   * Fetches recent trades for a symbol
   */
  async getRecentTrades(symbol: string, limit: number = 50): Promise<RecentTradeDto[]> {
    try {
      const trades = await this.makePublicRequest('/api/v3/trades', {
        symbol,
        limit,
      });

      return trades.map((trade: any) => ({
        id: trade.id.toString(),
        price: parseFloat(trade.price),
        quantity: parseFloat(trade.qty),
        time: trade.time,
        isBuyerMaker: trade.isBuyerMaker,
      }));
    } catch (error: any) {
      throw new BinanceApiException(`Failed to fetch recent trades for ${symbol}: ${error.message}`);
    }
  }

  /**
   * Fetches deposit history for user
   */
  async getDepositHistory(
    apiKey: string,
    apiSecret: string,
    coin?: string,
    status?: number,
    offset: number = 0,
    limit: number = 100,
    startTime?: number,
    endTime?: number,
  ): Promise<any[]> {
    try {
      const params: Record<string, any> = {
        offset,
        limit: Math.min(limit, 1000),
      };

      if (coin) params.coin = coin;
      if (status !== undefined) params.status = status; // 0:pending, 1:success
      if (startTime) params.startTime = startTime;
      if (endTime) params.endTime = endTime;

      const deposits = await this.makeSignedRequest(
        '/sapi/v1/capital/deposit/hisrec',
        apiKey,
        apiSecret,
        params,
      );

      return deposits.map((deposit: any) => ({
        id: deposit.id,
        coin: deposit.coin,
        amount: parseFloat(deposit.amount),
        network: deposit.network,
        status: deposit.status, // 0: pending, 1: success
        address: deposit.address,
        addressTag: deposit.addressTag,
        txId: deposit.txId,
        insertTime: deposit.insertTime,
        transferType: deposit.transferType,
        confirmTimes: deposit.confirmTimes,
      }));
    } catch (error: any) {
      if (error instanceof BinanceApiException || error instanceof InvalidApiKeyException) {
        throw error;
      }
      throw new BinanceApiException(`Failed to fetch deposit history: ${error.message}`);
    }
  }

  /**
   * Fetches withdrawal history for user
   */
  async getWithdrawalHistory(
    apiKey: string,
    apiSecret: string,
    coin?: string,
    status?: number,
    offset: number = 0,
    limit: number = 100,
    startTime?: number,
    endTime?: number,
  ): Promise<any[]> {
    try {
      const params: Record<string, any> = {
        offset,
        limit: Math.min(limit, 1000),
      };

      if (coin) params.coin = coin;
      if (status !== undefined) params.status = status; // 0:pending, 1:success, 2:failed
      if (startTime) params.startTime = startTime;
      if (endTime) params.endTime = endTime;

      const withdrawals = await this.makeSignedRequest(
        '/sapi/v1/capital/withdraw/history',
        apiKey,
        apiSecret,
        params,
      );

      return withdrawals.map((withdrawal: any) => ({
        id: withdrawal.id,
        coin: withdrawal.coin,
        withdrawOrderId: withdrawal.withdrawOrderId,
        amount: parseFloat(withdrawal.amount),
        network: withdrawal.network,
        address: withdrawal.address,
        addressTag: withdrawal.addressTag,
        txId: withdrawal.txId,
        status: withdrawal.status, // 0: email sent, 1: cancelled, 2: awaiting approval, 3: rejected, 4: processing, 5: failure, 6: completed
        completeTime: withdrawal.completeTime,
        applyTime: withdrawal.applyTime,
        transferType: withdrawal.transferType,
        info: withdrawal.info,
      }));
    } catch (error: any) {
      if (error instanceof BinanceApiException || error instanceof InvalidApiKeyException) {
        throw error;
      }
      throw new BinanceApiException(`Failed to fetch withdrawal history: ${error.message}`);
    }
  }
}

