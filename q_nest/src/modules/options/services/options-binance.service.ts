import { Injectable, Logger, BadRequestException, ServiceUnavailableException, Inject, forwardRef } from '@nestjs/common';
import * as ccxt from 'ccxt';
import { OPTIONS_RETRY_CONFIG } from '../options.config';
import { OptionsBinanceStreamService } from './options-binance-stream.service';
import {
  OptionContractDto,
  OptionsChainResponseDto,
  GreeksDto,
  OptionsAccountDto,
  OptionsPositionDto,
  OptionsOrderDto,
  OptionTypeEnum,
  AvailableUnderlyingDto,
} from '../dto/options.dto';

interface OptionCredentials {
  apiKey: string;
  apiSecret: string;
}

/**
 * Low-level Binance Options API wrapper using ccxt.
 * Uses direct eapi (European Options API) endpoint calls for reliability,
 * because ccxt unified methods (fetchPositions, fetchBalance) route to
 * futures (fapi) endpoints instead of options (eapi) endpoints.
 *
 * Binance Options API base: https://eapi.binance.com
 * WebSocket streams:        wss://nbstream.binance.com/eoptions/stream
 */
@Injectable()
export class OptionsBinanceService {
  private readonly logger = new Logger(OptionsBinanceService.name);

  // Shared public exchange instance — no API key, used for all public eapi endpoints
  private readonly publicExchange: ccxt.binance;

  // Cache authenticated exchange instances per user (LRU, max 500) — only for private endpoints
  private readonly exchangeInstances = new Map<string, ccxt.binance>();
  private readonly MAX_EXCHANGE_CACHE_SIZE = 500;

  // Cache exchange info (shared across all users, refreshed periodically)
  private exchangeInfoCache: any = null;
  private exchangeInfoCachedAt = 0;
  private readonly EXCHANGE_INFO_TTL = 5 * 60 * 1000; // 5 minutes

  // Shared response cache for bulk public endpoints (ticker / mark return ALL symbols
  // across ALL underlyings in one payload — caching collapses N-underlying polls into one fetch).
  private readonly publicResponseCache = new Map<string, { data: any; expiresAt: number }>();
  private readonly PUBLIC_CACHE_TTL_MS = 10_000; // 10s — refreshes once per chain cycle across all subscribers

  // In-flight deduplication — if request A is already fetching a key, request B awaits the same promise
  private readonly inFlight = new Map<string, Promise<any>>();

  // IP ban state — Binance returns 418 with "banned until <epoch-ms>" when weight exceeded.
  // We pause all public calls until this timestamp passes.
  private bannedUntil = 0;

  // Proxy URL — Binance Options (eapi) is geo-blocked on US IPs (e.g. Render).
  // When BINANCE_PROXY_URL is set, all ccxt HTTP calls are routed through it.
  private readonly proxyUrl: string | undefined;

  constructor(
    @Inject(forwardRef(() => OptionsBinanceStreamService))
    private readonly stream: OptionsBinanceStreamService,
  ) {
    this.proxyUrl = process.env.BINANCE_PROXY_URL;
    if (this.proxyUrl) {
      this.logger.log(`Options Binance proxy enabled: ${this.proxyUrl.replace(/\/\/.*@/, '//<redacted>@')}`);
    } else {
      this.logger.warn('BINANCE_PROXY_URL not set — eapi calls will fail from US-hosted servers');
    }

    this.publicExchange = new ccxt.binance({
      options: { defaultType: 'option' },
      enableRateLimit: true,
    });
    this.applyProxy(this.publicExchange);
  }

  /**
   * Apply the Webshare/HTTPS proxy to a ccxt instance using ccxt v4's documented
   * `httpsProxy` string property. ccxt lazy-loads `https-proxy-agent` internally
   * on the first request and reuses the agent for subsequent calls.
   */
  private applyProxy(exchange: ccxt.binance): void {
    if (!this.proxyUrl) return;
    (exchange as any).httpsProxy = this.proxyUrl;
  }

  /** Get the shared public exchange instance (no auth, for public data only). */
  getPublicExchange(): ccxt.binance {
    return this.publicExchange;
  }

  /**
   * Index price for an underlying. Prefers the live WS stream; falls back to
   * the cached REST endpoint if the stream hasn't populated yet or is stale.
   * Shape matches `eapiPublicGetIndex` response ({ indexPrice, time }) so callers
   * don't need to branch on the source.
   */
  async getCachedIndex(underlying: string): Promise<any> {
    const streamed = this.stream.getIndex(underlying);
    if (streamed !== null) return { indexPrice: String(streamed), time: Date.now() };
    return this.cachedFetch<any>(`index:${underlying}`, () =>
      (this.publicExchange as any).eapiPublicGetIndex({ underlying: `${underlying}USDT` }),
    );
  }

  /** Cached 24h spot ticker for an underlying (uses spot /api/v3, not eapi). */
  async getCachedSpotTicker24h(underlying: string): Promise<any> {
    return this.cachedFetch<any>(`spotTicker24h:${underlying}`, () =>
      (this.publicExchange as any).publicGetTicker24hr({ symbol: `${underlying}USDT` }),
    );
  }

  /**
   * Get or create a ccxt binance instance for the given credentials.
   * Used primarily for its eapi* methods (direct Binance endpoint calls)
   * and for signed request handling.
   */
  getExchange(credentials: OptionCredentials, userId?: string): ccxt.binance {
    const cacheKey = userId || credentials.apiKey.substring(0, 8);
    const existing = this.exchangeInstances.get(cacheKey);

    if (existing) {
      return existing;
    }

    const exchange = new ccxt.binance({
      apiKey: credentials.apiKey,
      secret: credentials.apiSecret,
      options: {
        defaultType: 'option',
      },
      enableRateLimit: true,
    });
    this.applyProxy(exchange);

    // Evict oldest entry if cache is full
    if (this.exchangeInstances.size >= this.MAX_EXCHANGE_CACHE_SIZE) {
      const oldestKey = this.exchangeInstances.keys().next().value;
      if (oldestKey) this.exchangeInstances.delete(oldestKey);
    }

    this.exchangeInstances.set(cacheKey, exchange);
    return exchange;
  }

  /**
   * Fetch and cache the eapi exchange info (available contracts, underlyings).
   * This is a PUBLIC endpoint — no API key needed.
   */
  private async getExchangeInfo(): Promise<any> {
    const now = Date.now();
    if (this.exchangeInfoCache && now - this.exchangeInfoCachedAt < this.EXCHANGE_INFO_TTL) {
      return this.exchangeInfoCache;
    }

    const info = await (this.publicExchange as any).eapiPublicGetExchangeInfo();
    this.exchangeInfoCache = info;
    this.exchangeInfoCachedAt = now;
    this.logger.log(`Options exchange info loaded: ${info.optionSymbols?.length || 0} option symbols`);
    return info;
  }

  /**
   * Parse Binance's "banned until <epoch-ms>" message (returned with 418) and,
   * when present, record the ban so we skip upstream calls until it expires.
   * Returns true if this error is a ban/rate-limit signal.
   */
  private handleRateLimitError(error: any): boolean {
    const status = error?.response?.status || error?.httpStatus;
    const msg: string = error?.message || '';
    const isBan = status === 418 || /\b418\b/.test(msg) || /banned until/i.test(msg);
    const isRateLimit = status === 429 || /\b429\b/.test(msg) || /Way too many requests/i.test(msg);
    if (!isBan && !isRateLimit) return false;

    const match = msg.match(/banned until (\d+)/i);
    const until = match ? parseInt(match[1], 10) : Date.now() + 60_000; // default 60s if not parseable
    if (until > this.bannedUntil) {
      this.bannedUntil = until;
      const seconds = Math.ceil((until - Date.now()) / 1000);
      this.logger.error(`Binance ${status || 'rate-limit'} — pausing eapi calls for ${seconds}s`);
    }
    return true;
  }

  /** True if we're in an active Binance ban window; skip outbound calls. */
  private isBanned(): boolean {
    return Date.now() < this.bannedUntil;
  }

  /**
   * Fetch with shared cache + in-flight dedup. Many subscribers polling the same
   * underlying should share one Binance call. Key = endpoint label + args.
   * Honors active bans by throwing early.
   */
  private async cachedFetch<T>(cacheKey: string, fn: () => Promise<T>): Promise<T> {
    if (this.isBanned()) {
      throw new Error(`Binance options API banned until ${new Date(this.bannedUntil).toISOString()}`);
    }
    const now = Date.now();
    const cached = this.publicResponseCache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.data as T;

    const existing = this.inFlight.get(cacheKey);
    if (existing) return existing as Promise<T>;

    const promise = fn().then(
      (data) => {
        this.publicResponseCache.set(cacheKey, { data, expiresAt: Date.now() + this.PUBLIC_CACHE_TTL_MS });
        this.inFlight.delete(cacheKey);
        return data;
      },
      (err) => {
        this.inFlight.delete(cacheKey);
        throw err;
      },
    );
    this.inFlight.set(cacheKey, promise);
    return promise;
  }

  /**
   * Retry wrapper with exponential backoff for Binance API calls.
   * - Skips entirely if we're in a ban window.
   * - Does NOT retry on 418 / 429 (retrying only extends the ban).
   * - Retries only on 5xx / timeouts.
   */
  private async withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
    if (this.isBanned()) {
      throw new Error(`Binance options API banned until ${new Date(this.bannedUntil).toISOString()}`);
    }
    const { MAX_RETRIES, BASE_DELAY_MS, MAX_DELAY_MS } = OPTIONS_RETRY_CONFIG;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (error: any) {
        // Record ban / rate-limit and stop immediately — retrying makes the ban worse
        if (this.handleRateLimitError(error)) throw error;

        const status = error?.response?.status || error?.code;
        const isTimeout = status === 408 || error?.code === 'ETIMEDOUT' || error?.code === 'ECONNABORTED';
        const isClientError = typeof status === 'number' && status >= 400 && status < 500;

        if (isClientError && !isTimeout) throw error;
        if (attempt === MAX_RETRIES) throw error;

        const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), MAX_DELAY_MS);
        this.logger.warn(`Retry ${attempt}/${MAX_RETRIES} for ${label} after ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw new ServiceUnavailableException('Unreachable');
  }

  /**
   * Get all available underlying assets for options trading.
   * Uses direct eapi/v1/exchangeInfo (public, no auth needed).
   */
  async getAvailableUnderlyings(): Promise<AvailableUnderlyingDto[]> {
    try {
      const exchangeInfo = await this.getExchangeInfo();
      const optionSymbols: any[] = exchangeInfo.optionSymbols || [];

      // Extract unique underlyings from optionSymbols
      // Each symbol has "underlying" like "BTCUSDT", we strip the quote asset
      const underlyingMap = new Map<string, number>();
      for (const sym of optionSymbols) {
        const underlying = sym.underlying?.replace(/USDT$/, '') || sym.baseAsset || '';
        if (underlying) {
          underlyingMap.set(underlying, (underlyingMap.get(underlying) || 0) + 1);
        }
      }

      // Fetch index prices for each underlying — shared cache collapses repeat calls
      const results: AvailableUnderlyingDto[] = [];
      for (const [symbol, contractCount] of underlyingMap) {
        let indexPrice = 0;
        try {
          const indexData = await this.cachedFetch<any>(`index:${symbol}`, () =>
            (this.publicExchange as any).eapiPublicGetIndex({ underlying: `${symbol}USDT` }),
          );
          indexPrice = parseFloat(indexData?.indexPrice || '0');
        } catch {
          this.logger.warn(`Could not fetch index price for ${symbol}`);
        }
        results.push({ symbol, indexPrice, contractCount });
      }

      return results.sort((a, b) => b.contractCount - a.contractCount);
    } catch (error: any) {
      this.logger.error(`Failed to fetch available underlyings: ${error.message}`);
      throw new Error(`Failed to fetch options underlyings: ${error.message}`);
    }
  }

  /**
   * Get all unique underlying base symbols from Binance exchange info (public, no auth).
   * e.g. ['BTC', 'ETH', 'SOL', ...]
   */
  async getAllUnderlyings(): Promise<string[]> {
    const info = await this.getExchangeInfo();
    const optionSymbols: any[] = info.optionSymbols || [];
    const seen = new Set<string>();
    for (const sym of optionSymbols) {
      const base = sym.underlying?.replace(/USDT$/, '') || sym.baseAsset || '';
      if (base) seen.add(base);
    }
    return Array.from(seen).sort();
  }

  /**
   * Get the ATM implied volatility for an underlying (public endpoint, no credentials needed).
   * Finds the nearest ATM option and returns its mark IV.
   */
  async getAtmIv(underlying: string): Promise<number | null> {
    try {
      const exchange = this.publicExchange;

      // Get spot price
      const indexData = await (exchange as any).eapiPublicGetIndex({ underlying: `${underlying}USDT` });
      const spotPrice = parseFloat(indexData?.indexPrice || '0');
      if (!spotPrice) return null;

      // Get exchange info to find ATM contracts
      const exchangeInfo = await this.getExchangeInfo();
      const optionSymbols: any[] = exchangeInfo.optionSymbols || [];

      // Find nearest ATM call expiring in ~30 days
      const now = Date.now();
      const targetExpiry = now + 30 * 24 * 60 * 60 * 1000;
      let bestSymbol: string | null = null;
      let bestDistance = Infinity;

      for (const sym of optionSymbols) {
        if (!sym.symbol?.includes(underlying) || sym.side !== 'CALL') continue;
        const expiry = parseInt(sym.expiryDate || '0', 10);
        const strike = parseFloat(sym.strikePrice || '0');
        if (!expiry || !strike) continue;

        const expiryDist = Math.abs(expiry - targetExpiry);
        const strikeDist = Math.abs(strike - spotPrice) / spotPrice;
        const combinedDist = expiryDist / (30 * 24 * 60 * 60 * 1000) + strikeDist;

        if (combinedDist < bestDistance) {
          bestDistance = combinedDist;
          bestSymbol = sym.symbol;
        }
      }

      if (!bestSymbol) return null;

      // Fetch mark data for the ATM contract
      const markData: any[] = await (exchange as any).eapiPublicGetMark({ symbol: bestSymbol });
      const mark = Array.isArray(markData) ? markData[0] : markData;
      return mark?.markIV ? parseFloat(mark.markIV) : null;
    } catch (error: any) {
      this.logger.warn(`getAtmIv failed for ${underlying}: ${error.message}`);
      return null;
    }
  }

  /**
   * Convert Binance eapi symbol (BTC-260327-100000-C) to ccxt format
   * ccxt: BTC/USDT:USDT-260327-100000-C
   */
  private toCcxtSymbol(contractSymbol: string): string {
    const parts = contractSymbol.split('-');
    if (parts.length !== 4) {
      throw new Error(`Invalid option contract symbol: ${contractSymbol}`);
    }
    const [underlying, expiry, strike, type] = parts;
    return `${underlying}/USDT:USDT-${expiry}-${strike}-${type}`;
  }

  /**
   * Convert ccxt symbol back to Binance eapi symbol
   * ccxt: BTC/USDT:USDT-260327-100000-C → BTC-260327-100000-C
   */
  private fromCcxtSymbol(ccxtSymbol: string): string {
    const match = ccxtSymbol.match(/^(\w+)\/USDT:USDT-(.+)$/);
    if (match) {
      return `${match[1]}-${match[2]}`;
    }
    return ccxtSymbol;
  }

  /**
   * Fetch the full options chain for an underlying asset.
   * Uses direct eapi endpoints: exchangeInfo + ticker + mark.
   */
  async fetchOptionsChain(
    credentials: OptionCredentials | null,
    underlying: string,
    userId?: string,
  ): Promise<OptionsChainResponseDto> {
    const exchange = this.publicExchange;
    const exchangeInfo = await this.getExchangeInfo();

    // Filter contracts for this underlying from exchangeInfo
    const optionSymbols: any[] = (exchangeInfo.optionSymbols || []).filter(
      (s: any) => {
        const base = s.underlying?.replace(/USDT?$/, '') || s.baseAsset || s.symbol?.split('-')[0] || '';
        return base === underlying;
      },
    );

    if (optionSymbols.length === 0) {
      return {
        underlying,
        underlyingPrice: 0,
        expiryDates: [],
        contracts: [],
        timestamp: Date.now(),
      };
    }

    // Prefer live WebSocket stream for mark/Greeks/bid-ask/index — falls back to REST
    // when the stream is stale or disconnected. Volume/OI always come from REST ticker
    // (change slowly, no WS aggregate exists for options).
    const streamMarks = this.stream.getMarksForUnderlying(underlying);
    const streamIndex = this.stream.getIndex(underlying);
    const needMarkRest = streamMarks.size === 0;
    const needIndexRest = streamIndex === null;

    let tickers: any[] = [];
    let markPrices: any[] = [];
    let indexPrice = streamIndex ?? 0;

    try {
      const [tickerResult, markResult, indexResult] = await Promise.allSettled([
        // Volume + OI only come from REST — shared 60s cache across all underlyings
        this.cachedFetch<any[]>('ticker:all', () =>
          this.withRetry<any[]>(() => (exchange as any).eapiPublicGetTicker(), 'getTicker'),
        ),
        needMarkRest
          ? this.cachedFetch<any[]>('mark:all', () =>
              this.withRetry<any[]>(() => (exchange as any).eapiPublicGetMark(), 'getMark'),
            )
          : Promise.resolve([] as any[]),
        needIndexRest
          ? this.cachedFetch<any>(`index:${underlying}`, () =>
              this.withRetry<any>(() => (exchange as any).eapiPublicGetIndex({ underlying: `${underlying}USDT` }), 'getIndex'),
            )
          : Promise.resolve(null),
      ]);
      if (tickerResult.status === 'fulfilled') tickers = (tickerResult.value as any[]) || [];
      else this.logger.error(`Chain fetch: ticker failed for ${underlying}: ${tickerResult.reason?.message || tickerResult.reason}`);
      if (needMarkRest) {
        if (markResult.status === 'fulfilled') markPrices = (markResult.value as any[]) || [];
        else this.logger.error(`Chain fetch: mark failed for ${underlying}: ${markResult.reason?.message || markResult.reason}`);
      }
      if (needIndexRest) {
        if (indexResult.status === 'fulfilled') indexPrice = parseFloat((indexResult.value as any)?.indexPrice || '0');
        else this.logger.error(`Chain fetch: index failed for ${underlying}: ${indexResult.reason?.message || indexResult.reason}`);
      }
    } catch (error: any) {
      this.logger.warn(`Options chain data fetch error: ${error.message}`);
    }

    // Index tickers + REST marks (latter only used when WS stream is unavailable)
    const tickerMap = new Map<string, any>();
    for (const t of tickers) {
      if (t.symbol) tickerMap.set(t.symbol, t);
    }
    const restMarkMap = new Map<string, any>();
    for (const m of markPrices) {
      if (m.symbol) restMarkMap.set(m.symbol, m);
    }

    // Build contracts list
    const contracts: OptionContractDto[] = [];
    const expirySet = new Set<string>();

    for (const sym of optionSymbols) {
      const symbol = sym.symbol; // e.g. "BTC-260327-100000-C"
      const ticker = tickerMap.get(symbol) || {};
      const wsMark = streamMarks.get(symbol);
      const restMark = restMarkMap.get(symbol) || {};

      const expiryMs = sym.expiryDate ? parseInt(sym.expiryDate) : 0;
      const expiryDate = expiryMs ? new Date(expiryMs).toISOString() : '';

      if (expiryDate) {
        expirySet.add(expiryDate.split('T')[0]);
      }

      const strike = parseFloat(sym.strikePrice || '0');
      const optType = (sym.side || '').toUpperCase().startsWith('C')
        ? OptionTypeEnum.CALL
        : OptionTypeEnum.PUT;

      // WS stream carries live bid/ask + mark + Greeks + IV. REST carries the
      // same fields at a slower cadence (used only when stream is stale/disconnected).
      const bidPrice = wsMark ? wsMark.bidPrice : parseFloat(ticker.bidPrice || '0');
      const askPrice = wsMark ? wsMark.askPrice : parseFloat(ticker.askPrice || '0');
      const markPrice = wsMark
        ? wsMark.markPrice
        : parseFloat(restMark.markPrice || ticker.lastPrice || '0');
      const delta = wsMark ? wsMark.delta : parseFloat(restMark.delta || '0');
      const gamma = wsMark ? wsMark.gamma : parseFloat(restMark.gamma || '0');
      const theta = wsMark ? wsMark.theta : parseFloat(restMark.theta || '0');
      const vega = wsMark ? wsMark.vega : parseFloat(restMark.vega || '0');
      const impliedVolatility = wsMark
        ? (wsMark.markIV || undefined)
        : (restMark.markIV ? parseFloat(restMark.markIV) : undefined);

      contracts.push({
        symbol,
        underlying,
        strike,
        expiry: expiryDate,
        type: optType,
        bidPrice,
        askPrice,
        markPrice,
        lastPrice: parseFloat(ticker.lastPrice || '0'),
        volume: parseFloat(ticker.volume || '0'),
        openInterest: parseFloat(ticker.openInterest || restMark.openInterest || '0'),
        greeks: { delta, gamma, theta, vega, impliedVolatility },
        contractSize: parseInt(sym.unit || '1'),
      });
    }

    return {
      underlying,
      underlyingPrice: indexPrice,
      expiryDates: Array.from(expirySet).sort(),
      contracts,
      timestamp: Date.now(),
    };
  }

  /**
   * Fetch Greeks for a specific option contract.
   * Uses direct eapi/v1/mark endpoint (public).
   */
  async fetchGreeks(
    credentials: OptionCredentials | null,
    contractSymbol: string,
    userId?: string,
  ): Promise<GreeksDto> {
    const exchange = this.publicExchange;

    try {
      const markData: any[] = await (exchange as any).eapiPublicGetMark({ symbol: contractSymbol });
      const mark = Array.isArray(markData) ? markData[0] : markData;

      return {
        delta: parseFloat(mark?.delta || '0'),
        gamma: parseFloat(mark?.gamma || '0'),
        theta: parseFloat(mark?.theta || '0'),
        vega: parseFloat(mark?.vega || '0'),
        impliedVolatility: mark?.markIV ? parseFloat(mark.markIV) : undefined,
      };
    } catch (error: any) {
      this.logger.warn(`fetchGreeks via eapi failed for ${contractSymbol}: ${error.message}`);
      return { delta: 0, gamma: 0, theta: 0, vega: 0 };
    }
  }

  /**
   * Fetch ticker for a specific option contract.
   * Uses direct eapi/v1/ticker endpoint (public).
   */
  async fetchOptionTicker(
    credentials: OptionCredentials | null,
    contractSymbol: string,
    userId?: string,
  ): Promise<any> {
    const exchange = this.publicExchange;

    try {
      const tickers: any[] = await (exchange as any).eapiPublicGetTicker({ symbol: contractSymbol });
      return Array.isArray(tickers) ? tickers[0] : tickers;
    } catch (error: any) {
      this.logger.error(`fetchOptionTicker failed for ${contractSymbol}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Fetch order book depth for an option contract.
   * Uses direct eapi/v1/depth endpoint (public).
   */
  async fetchOptionDepth(
    credentials: OptionCredentials | null,
    contractSymbol: string,
    limit: number = 20,
    userId?: string,
  ): Promise<any> {
    const exchange = this.publicExchange;

    try {
      return await (exchange as any).eapiPublicGetDepth({
        symbol: contractSymbol,
        limit: limit.toString(),
      });
    } catch (error: any) {
      this.logger.error(`fetchOptionDepth failed for ${contractSymbol}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Place a LIMIT order for an option contract.
   * Uses direct eapi/v1/order endpoint (private).
   */
  async placeOptionOrder(
    credentials: OptionCredentials,
    contractSymbol: string,
    side: 'buy' | 'sell',
    quantity: number,
    price: number,
    userId?: string,
  ): Promise<any> {
    const exchange = this.getExchange(credentials, userId);

    this.logger.log(
      `Placing options order: ${side.toUpperCase()} ${quantity} ${contractSymbol} @ ${price}`,
    );

    try {
      const order = await (exchange as any).eapiPrivatePostOrder({
        symbol: contractSymbol,
        side: side.toUpperCase(),
        type: 'LIMIT',
        quantity: quantity.toString(),
        price: price.toString(),
        timeInForce: 'GTC',
        // Sell-to-close only: reduceOnly prevents naked option writing
        ...(side === 'sell' ? { reduceOnly: 'true' } : {}),
      });

      this.logger.log(`Options order placed: ${order.orderId} status=${order.status}`);
      return order;
    } catch (error: any) {
      this.logger.error(`placeOptionOrder failed: ${error.message}`);
      // Extract the real Binance error message so the frontend sees it (not a generic 500)
      const msg = error?.info?.msg || error?.message || 'Order placement failed';
      throw new BadRequestException(msg);
    }
  }

  /**
   * Cancel an open option order.
   * Uses direct eapi/v1/order DELETE endpoint (private).
   */
  async cancelOptionOrder(
    credentials: OptionCredentials,
    contractSymbol: string,
    binanceOrderId: string,
    userId?: string,
  ): Promise<any> {
    const exchange = this.getExchange(credentials, userId);

    try {
      return await (exchange as any).eapiPrivateDeleteOrder({
        symbol: contractSymbol,
        orderId: binanceOrderId,
      });
    } catch (error: any) {
      this.logger.error(`cancelOptionOrder failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Cancel all open orders for a contract or by underlying.
   * Uses direct eapi/v1/allOpenOrdersByUnderlying DELETE endpoint (private).
   */
  async cancelAllOptionOrders(
    credentials: OptionCredentials,
    contractSymbol: string,
    userId?: string,
  ): Promise<any> {
    const exchange = this.getExchange(credentials, userId);
    const underlying = contractSymbol.split('-')[0];

    try {
      return await (exchange as any).eapiPrivateDeleteAllOpenOrdersByUnderlying({
        underlying: `${underlying}USDT`,
      });
    } catch (error: any) {
      this.logger.error(`cancelAllOptionOrders failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Fetch a single order by ID.
   * Uses direct eapi/v1/order GET endpoint (private).
   */
  async fetchOrder(
    credentials: OptionCredentials,
    contractSymbol: string,
    binanceOrderId: string,
    userId?: string,
  ): Promise<any> {
    const exchange = this.getExchange(credentials, userId);

    try {
      return await (exchange as any).eapiPrivateGetOrder({
        symbol: contractSymbol,
        orderId: binanceOrderId,
      });
    } catch (error: any) {
      this.logger.error(`fetchOrder failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Fetch open orders for options.
   * Uses direct eapi/v1/openOrders GET endpoint (private).
   */
  async fetchOpenOrders(
    credentials: OptionCredentials,
    contractSymbol?: string,
    userId?: string,
  ): Promise<any[]> {
    const exchange = this.getExchange(credentials, userId);

    try {
      const params: any = {};
      if (contractSymbol) {
        params.symbol = contractSymbol;
      }
      const orders = await (exchange as any).eapiPrivateGetOpenOrders(params);
      return Array.isArray(orders) ? orders : [];
    } catch (error: any) {
      this.logger.error(`fetchOpenOrders failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Fetch order history.
   * Uses direct eapi/v1/historyOrders GET endpoint (private).
   */
  async fetchOrderHistory(
    credentials: OptionCredentials,
    contractSymbol?: string,
    limit: number = 50,
    userId?: string,
  ): Promise<any[]> {
    const exchange = this.getExchange(credentials, userId);

    try {
      const params: any = { limit: limit.toString() };
      if (contractSymbol) {
        params.symbol = contractSymbol;
      }
      const orders = await (exchange as any).eapiPrivateGetHistoryOrders(params);
      return Array.isArray(orders) ? orders : [];
    } catch (error: any) {
      this.logger.error(`fetchOrderHistory failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Fetch current option positions.
   * Uses direct eapi/v1/position GET endpoint (private).
   *
   * NOTE: ccxt's unified fetchPositions() routes to futures (fapi) endpoints
   * which fails for options. We use the direct eapi endpoint instead.
   */
  async fetchPositions(
    credentials: OptionCredentials,
    userId?: string,
  ): Promise<OptionsPositionDto[]> {
    const exchange = this.getExchange(credentials, userId);

    try {
      const rawPositions: any[] = await this.withRetry(
        () => (exchange as any).eapiPrivateGetPosition(),
        'fetchPositions',
      );
      const positions = Array.isArray(rawPositions) ? rawPositions : [];

      return positions
        .filter((p: any) => parseFloat(p.quantity || '0') !== 0)
        .map((p: any) => ({
          positionId: '',
          contractSymbol: p.symbol || '',
          underlying: (p.symbol || '').split('-')[0],
          strike: parseFloat(p.strikePrice || '0'),
          expiry: p.expiryDate
            ? new Date(parseInt(p.expiryDate)).toISOString()
            : '',
          optionType: (p.optionSide || p.side || '').toUpperCase().startsWith('C')
            ? OptionTypeEnum.CALL
            : OptionTypeEnum.PUT,
          quantity: parseFloat(p.quantity || '0'),
          avgPremium: parseFloat(p.entryPrice || '0'),
          currentPremium: parseFloat(p.markPrice || '0'),
          unrealizedPnl: parseFloat(p.unrealizedPNL || p.unrealizedPnl || '0'),
          realizedPnl: parseFloat(p.realizedPNL || p.realizedPnl || '0'),
          greeks: {
            delta: parseFloat(p.delta || '0'),
            gamma: parseFloat(p.gamma || '0'),
            theta: parseFloat(p.theta || '0'),
            vega: parseFloat(p.vega || '0'),
          },
          isOpen: true,
        }));
    } catch (error: any) {
      this.logger.warn(`fetchPositions via eapi failed after retries: ${error.message}`);
      // Return empty positions instead of crashing — user may not have options enabled
      return [];
    }
  }

  /**
   * Fetch options account balance.
   * Uses direct eapi/v1/account GET endpoint (private).
   *
   * NOTE: ccxt's unified fetchBalance() routes to futures (fapi) endpoints.
   * We use the direct eapi endpoint instead.
   */
  async fetchBalance(
    credentials: OptionCredentials,
    userId?: string,
  ): Promise<OptionsAccountDto> {
    const exchange = this.getExchange(credentials, userId);

    try {
      // Binance Options uses /eapi/v1/marginAccount (not /account)
      const account: any = await this.withRetry(
        () => (exchange as any).eapiPrivateGetMarginAccount(),
        'fetchBalance',
      );
      // Response: [{ asset, equity, maxWithdrawAmount, availableBalance, unrealizedPNL, marginBalance, ... }]
      const assets = Array.isArray(account) ? account : (account?.asset || []);
      const usdtAsset = assets.find((a: any) => a.asset === 'USDT');

      return {
        totalBalance: parseFloat(usdtAsset?.equity || '0'),
        availableBalance: parseFloat(usdtAsset?.availableBalance || usdtAsset?.available || '0'),
        unrealizedPnl: parseFloat(usdtAsset?.unrealizedPNL || '0'),
        marginBalance: parseFloat(usdtAsset?.marginBalance || '0'),
      };
    } catch (error: any) {
      this.logger.warn(`fetchBalance via eapi failed: ${error.message}`);
      // Return zeroes instead of crashing
      return { totalBalance: 0, availableBalance: 0, unrealizedPnl: 0, marginBalance: 0 };
    }
  }

  /**
   * Fetch user's option trades (fills).
   * Uses direct eapi/v1/userTrades GET endpoint (private).
   */
  async fetchMyTrades(
    credentials: OptionCredentials,
    contractSymbol?: string,
    limit: number = 50,
    userId?: string,
  ): Promise<any[]> {
    const exchange = this.getExchange(credentials, userId);

    try {
      const params: any = { limit: limit.toString() };
      if (contractSymbol) {
        params.symbol = contractSymbol;
      }
      const trades = await (exchange as any).eapiPrivateGetUserTrades(params);
      return Array.isArray(trades) ? trades : [];
    } catch (error: any) {
      this.logger.error(`fetchMyTrades failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Remove cached exchange instance for a user (e.g., on disconnect).
   */
  removeInstance(userId: string): void {
    this.exchangeInstances.delete(userId);
  }

  /**
   * Clear all cached instances (e.g., on module destroy).
   */
  clearAllInstances(): void {
    this.exchangeInstances.clear();
    this.exchangeInfoCache = null;
  }
}
