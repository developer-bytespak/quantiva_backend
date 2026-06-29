import { HttpStatus, Injectable, Logger } from '@nestjs/common';
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
export class BinanceUSService {
  private readonly logger = new Logger(BinanceUSService.name);
  private readonly baseUrl = 'https://api.binance.us';
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
   * Creates a signature for Binance.US API requests
   */
  private createSignature(queryString: string, secret: string): string {
    const crypto = require('crypto');
    return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
  }

  /**
   * Gets Binance.US server time to sync with local time
   */
  private async getBinanceServerTime(): Promise<number> {
    try {
      const response = await this.makePublicRequest('/api/v3/time');
      return response.serverTime;
    } catch (error) {
      // Fallback to local time if server time fetch fails
      this.logger.warn('Failed to fetch Binance.US server time, using local time');
      return Date.now();
    }
  }

  /**
   * Makes a signed request to Binance.US API with retry logic
   */
  private async makeSignedRequest(
    endpoint: string,
    apiKey: string,
    apiSecret: string,
    params: Record<string, any> = {},
    retryTimestampError: boolean = true,
  ): Promise<any> {
    // Use Binance.US server time for better synchronization
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

        // 403 Forbidden – usually IP whitelist: request from an IP not allowed on the API key
        if (error.response?.status === 403) {
          const msg =
            error.response?.data?.msg ||
            'Access denied (403). Your Binance.US API key may have IP restrictions. In Binance.US API Management, either add this server’s IP to the whitelist or disable "Restrict access to trusted IPs only" to allow the connection.';
          throw new InvalidApiKeyException(msg);
        }

        // Handle specific Binance.US error codes
        if (error.response?.data?.code) {
          const binanceCode = error.response.data.code;
          const binanceMsg = error.response.data.msg || 'Binance.US API error';

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
              `BINANCE_US_${binanceCode}`,
            );
          }

          throw new BinanceApiException(binanceMsg, `BINANCE_US_${binanceCode}`);
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
      lastError?.message || 'Failed to connect to Binance.US API',
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
      throw new BinanceApiException(error.message || 'Failed to fetch data from Binance.US');
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Cache for Binance.US tradeable USD base assets (e.g. 'BTC','ETH','SOL')
  private tradeableSymbolsCache: { symbols: Set<string>; fetchedAt: number } | null = null;
  private readonly TRADEABLE_CACHE_TTL_MS = 5 * 60_000; // 5 minutes

  /**
   * Returns the set of base assets that have an active TRADING pair with USD quote on Binance.US.
   * Uses a 5-minute in-memory cache to avoid hammering exchangeInfo.
   * No API key required — public endpoint.
   */
  async getTradeableBaseAssets(): Promise<Set<string>> {
    if (
      this.tradeableSymbolsCache &&
      Date.now() - this.tradeableSymbolsCache.fetchedAt < this.TRADEABLE_CACHE_TTL_MS
    ) {
      return this.tradeableSymbolsCache.symbols;
    }
    try {
      const data = await this.makePublicRequest('/api/v3/exchangeInfo');
      const symbols = new Set<string>(
        (data.symbols as any[])
          .filter((s) => s.status === 'TRADING' && s.quoteAsset === 'USD')
          .map((s) => s.baseAsset as string),
      );
      this.tradeableSymbolsCache = { symbols, fetchedAt: Date.now() };
      this.logger.log(`Binance.US tradeable USD base assets cached: ${symbols.size} symbols`);
      return symbols;
    } catch (error: any) {
      this.logger.error(`Failed to fetch Binance.US tradeable symbols: ${error.message}`);
      if (this.tradeableSymbolsCache) return this.tradeableSymbolsCache.symbols;
      return new Set();
    }
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
   * Fetches account info from Binance.US (used internally to avoid redundant calls)
   */
  async getAccountInfo(apiKey: string, apiSecret: string): Promise<BinanceAccountInfo> {
    return this.makeSignedRequest('/api/v3/account', apiKey, apiSecret) as Promise<BinanceAccountInfo>;
  }

  /**
   * Gets the free balance of a single asset. Used by the closePosition flow
   * to sell the user's ACTUAL current balance (not the stale dashboard qty).
   * Returns both `free` (actually tradeable right now) and `total` (free +
   * locked) so callers can distinguish a true small balance from an unlock
   * race after a just-cancelled TP/SL order.
   */
  async getAssetFreeBalance(
    apiKey: string,
    apiSecret: string,
    asset: string,
  ): Promise<{ free: number; total: number }> {
    try {
      const info = await this.getAccountInfo(apiKey, apiSecret);
      const row = (info?.balances || []).find(
        (b) => b.asset?.toUpperCase() === asset.toUpperCase(),
      );
      if (!row) return { free: 0, total: 0 };
      const free = parseFloat(row.free || '0');
      const locked = parseFloat(row.locked || '0');
      return { free, total: free + locked };
    } catch {
      return { free: 0, total: 0 };
    }
  }

  /**
   * Binance.US dust sweeper used after a close-position market SELL — the
   * Binance.US counterpart of BinanceService.convertDustToUsdt, but built
   * against Binance.US's *different* dust API:
   *   - GET  /sapi/v1/asset/query/dust-assets?toAsset=<target> → which holdings
   *     are convertible right now. Binance.US only lists assets whose value is
   *     inside its $0.01–$20 dust window, so this doubles as the eligibility
   *     gate, and its `withinRestrictedTime` flag reflects the 6h cooldown.
   *   - POST /sapi/v1/asset/dust  with fromAsset[]=…&toAsset=<target> → convert.
   *
   * Unlike global Binance there is NO /sapi/v1/convert endpoint here, so this
   * single dust call is the only programmatic path — but it CAN target USDT
   * directly (global can only dust-to-BNB). Mirrors the global method's
   * contract: returns `{ ok, toAmount, reason, method }` and never throws.
   *
   * Note: this clears ordinary residual dust ($0.01–$20). Sub-cent dust (below
   * Binance.US's $0.01 floor) has no API path on Binance.US either and will
   * return ok:false with a clear reason.
   */
  async convertDustToUsdt(
    apiKey: string,
    apiSecret: string,
    fromAsset: string,
    toAsset: string = 'USDT',
  ): Promise<{
    ok: boolean;
    toAmount?: number;
    reason?: string;
    method?: 'dust' | 'none';
  }> {
    const requested = fromAsset.toUpperCase();
    const target = toAsset.toUpperCase();
    try {
      // Step 1: ask Binance.US which assets are convertible to `target` right
      // now. The response only includes holdings inside the $0.01–$20 dust
      // window, so membership here IS the eligibility check.
      const eligible = await this.fetchDustConvertibleAssets(apiKey, apiSecret, target);

      // 6h cooldown: if we're inside the restricted window the POST will be
      // rejected — bail early with a clear reason rather than burning a doomed
      // call (and the user's cooldown) on it.
      if (eligible.withinRestrictedTime) {
        return {
          ok: false,
          method: 'none',
          reason: 'within Binance.US 6h dust-conversion cooldown',
        };
      }

      if (!eligible.assets.some((a) => a.fromAsset === requested)) {
        this.logger.log(
          `Dust-convert ${requested}→${target}: not on Binance.US convertible list ` +
            `(eligible=${eligible.assets.length}). Skipping — value is likely below ` +
            `Binance.US's $0.01 minimum or above its $20 dust ceiling.`,
        );
        return {
          ok: false,
          method: 'none',
          reason: 'asset not dust-convertible per Binance.US (outside $0.01–$20)',
        };
      }

      // Step 2: bundle every convertible asset into the single allowed call.
      // Binance.US gates conversions behind a 6h cooldown, so we clear as much
      // dust as possible at once — same batching rationale as the global path.
      //
      // NEVER include the target asset itself: the dust-assets list can return
      // a small balance of the target (a few dollars of USDT is itself "dust"),
      // but asking Binance.US to convert USDT→USDT is rejected as "This asset is
      // not supported" — and it fails the WHOLE batch atomically.
      const assetList = Array.from(
        new Set<string>([requested, ...eligible.assets.map((a) => a.fromAsset)]),
      ).filter((a) => a && a !== target);

      if (assetList.length === 0) {
        return {
          ok: true,
          toAmount: 0,
          method: 'none',
          reason: 'nothing to convert (only the target asset was eligible)',
        };
      }

      this.logger.log(
        `Dust-convert ${requested}→${target}: eligible=${eligible.assets.length}, batch=[${assetList.join(', ')}]`,
      );

      // Try the full bundle first; if it's rejected (one sibling asset may be
      // unsupported, and Binance.US fails the batch atomically), fall back to
      // converting ONLY the asset the user is closing so their position still
      // clears. A rejected call performs no conversion, so the 6h cooldown is
      // not consumed and the retry is safe.
      const batches = assetList.length > 1 ? [assetList, [requested]] : [assetList];
      let lastReason: string | undefined;
      for (const batch of batches) {
        try {
          const result = await this.postDustConvert(apiKey, apiSecret, batch, target);
          const transferred = parseFloat(result?.totalTransferred ?? '0') || 0;
          this.logger.log(
            `Dust-convert success: [${batch.join(', ')}] → ${transferred} ${target} (after fees)`,
          );
          return { ok: true, toAmount: transferred, method: 'dust' };
        } catch (err: any) {
          lastReason = err?.message || 'dust convert failed';
          this.logger.warn(`Dust-convert batch [${batch.join(', ')}] failed: ${lastReason}`);
        }
      }
      return { ok: false, method: 'none', reason: lastReason };
    } catch (err: any) {
      // Surface auth / rate-limit distinctly so the caller doesn't misread them
      // as "dust simply unavailable".
      const reason = err?.message || 'unknown error';
      this.logger.warn(`convertDustToUsdt(${requested}) failed: ${reason}`);
      return { ok: false, method: 'none', reason };
    }
  }

  /**
   * GET /sapi/v1/asset/query/dust-assets — lists the assets currently
   * convertible to `toAsset` (only those inside Binance.US's $0.01–$20 dust
   * window) plus the `withinRestrictedTime` cooldown flag. Returns an empty,
   * non-restricted result on failure so the caller fails closed (treats the
   * asset as not convertible) rather than attempting a doomed POST.
   */
  private async fetchDustConvertibleAssets(
    apiKey: string,
    apiSecret: string,
    toAsset: string,
  ): Promise<{
    assets: Array<{ fromAsset: string; usdValue: number }>;
    withinRestrictedTime: boolean;
  }> {
    try {
      const result = await this.makeSignedRequest(
        '/sapi/v1/asset/query/dust-assets',
        apiKey,
        apiSecret,
        { toAsset: toAsset.toUpperCase() },
      );
      const rows = Array.isArray(result?.convertibleAssets) ? result.convertibleAssets : [];
      return {
        assets: rows.map((r: any) => ({
          fromAsset: String(r?.fromAsset || '').toUpperCase(),
          usdValue: parseFloat(r?.usdValueConvertedAsset ?? '0') || 0,
        })),
        withinRestrictedTime: result?.withinRestrictedTime === true,
      };
    } catch (err: any) {
      this.logger.warn(`fetchDustConvertibleAssets failed: ${err?.message ?? err}`);
      return { assets: [], withinRestrictedTime: false };
    }
  }

  /**
   * POST /sapi/v1/asset/dust — converts the listed assets' dust to `toAsset`.
   * `fromAsset` is a repeated query param (fromAsset=BTC&fromAsset=ETH), which
   * the object form of URLSearchParams used elsewhere can't produce (it would
   * coerce the array to one comma-joined value), so we build the signed query
   * manually with append().
   */
  private async postDustConvert(
    apiKey: string,
    apiSecret: string,
    fromAssets: string[],
    toAsset: string,
  ): Promise<any> {
    const serverTime = await this.getBinanceServerTime();
    const params = new URLSearchParams();
    for (const a of fromAssets) params.append('fromAsset', a);
    params.append('toAsset', toAsset);
    params.append('timestamp', serverTime.toString());
    params.append('recvWindow', '60000');

    const queryString = params.toString();
    const signature = this.createSignature(queryString, apiSecret);
    const url = `/sapi/v1/asset/dust?${queryString}&signature=${signature}`;

    try {
      const response = await this.apiClient.post(url, null, {
        headers: { 'X-MBX-APIKEY': apiKey },
      });
      return response.data;
    } catch (error: any) {
      if (error.response?.data?.code) {
        const code = error.response.data.code;
        const msg = error.response.data.msg || 'Binance.US dust convert error';
        if (code === -2015 || code === -1022) throw new InvalidApiKeyException(msg);
        if (code === -1003) throw new BinanceRateLimitException(msg);
        throw new BinanceApiException(msg, `BINANCE_US_${code}`);
      }
      throw new BinanceApiException(
        error.response?.data?.msg || error.message || 'Failed to convert dust on Binance.US',
      );
    }
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
      const balancesWithValue = accountInfo.balances.filter((b) =>
        parseFloat(b.free) > 0 || parseFloat(b.locked) > 0,
      );

      if (balancesWithValue.length === 0) {
        return [];
      }

      // Treat fiat/stable balances as $1 so portfolio can be calculated even without ticker pairs.
      const STABLE_ASSETS = new Set(['USD', 'USDT', 'USDC', 'BUSD', 'TUSD', 'USDP', 'DAI', 'FDUSD']);
      const priceMap = new Map<string, number>();
      for (const asset of STABLE_ASSETS) {
        priceMap.set(asset, 1);
      }

      // Fetch prices only for non-stable assets.
      const symbols = balancesWithValue
        .filter((b) => !STABLE_ASSETS.has(b.asset))
        .map((b) => `${b.asset}USDT`);

      if (symbols.length > 0) {
        const prices = await this.getTickerPrices(symbols);
        for (const p of prices) {
          priceMap.set(p.symbol.replace('USDT', ''), p.price);
        }
      }

      const positions: PositionDto[] = balancesWithValue
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
      // Binance.US API allows fetching multiple tickers
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

  /**
   * Maps Binance.US interval to API format
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
   * Fetches exchangeInfo once and:
   * 1. Adjusts quantity to comply with LOT_SIZE (step size)
   * 2. Validates that the order notional value meets NOTIONAL / MIN_NOTIONAL filter
   */
  private async validateAndAdjustQuantity(
    symbol: string,
    quantity: number,
    orderType: 'MARKET' | 'LIMIT',
    price?: number,
  ): Promise<string> {
    try {
      const info = await this.makePublicRequest('/api/v3/exchangeInfo', { symbol });
      const filters: any[] = info?.symbols?.[0]?.filters ?? [];

      let adjustedQuantity = quantity;
      let decimalPlaces = 8;

      const lotSizeFilter = filters.find((f) => f.filterType === 'LOT_SIZE');
      if (lotSizeFilter) {
        const stepSize: string = lotSizeFilter.stepSize;
        const step = parseFloat(stepSize);
        if (step > 0) {
          decimalPlaces = (stepSize.replace(/0+$/, '').split('.')[1] ?? '').length;
          adjustedQuantity = Math.floor(quantity / step) * step;
        }
      }

      const adjustedQtyStr = adjustedQuantity.toFixed(decimalPlaces);

      const notionalFilter =
        filters.find((f) => f.filterType === 'NOTIONAL') ??
        filters.find((f) => f.filterType === 'MIN_NOTIONAL');

      if (notionalFilter) {
        const minNotional = parseFloat(
          notionalFilter.minNotional ?? notionalFilter.minNotionalValue ?? '0',
        );

        if (minNotional > 0) {
          let effectivePrice = price;
          if (!effectivePrice || orderType === 'MARKET') {
            const ticker = await this.makePublicRequest('/api/v3/ticker/price', { symbol });
            effectivePrice = parseFloat(ticker.price);
          }

          const notional = adjustedQuantity * effectivePrice;
          if (notional < minNotional) {
            throw new BinanceApiException(
              `Order value $${notional.toFixed(4)} is below the minimum required $${minNotional} for ${symbol}. ` +
                `Increase your quantity.`,
              'BINANCE_US_-1013',
            );
          }
        }
      }

      return adjustedQtyStr;
    } catch (error) {
      if (error instanceof BinanceApiException) throw error;
      // Fallback to raw quantity if exchangeInfo is temporarily unavailable.
      return quantity.toString();
    }
  }

  /**
   * Rounds a price to comply with PRICE_FILTER tickSize for the symbol.
   */
  private async roundPriceToTickSize(symbol: string, price: number): Promise<string> {
    try {
      const info = await this.makePublicRequest('/api/v3/exchangeInfo', { symbol });
      const filters: any[] = info?.symbols?.[0]?.filters ?? [];
      const priceFilter = filters.find((f) => f.filterType === 'PRICE_FILTER');
      if (!priceFilter) return price.toFixed(8);

      const tickSize: string = priceFilter.tickSize;
      const tick = parseFloat(tickSize);
      if (tick <= 0) return price.toFixed(8);

      const decimalPlaces = (tickSize.replace(/0+$/, '').split('.')[1] ?? '').length;
      const rounded = Math.round(price / tick) * tick;
      return rounded.toFixed(decimalPlaces);
    } catch {
      return price.toFixed(8);
    }
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
   * Makes a signed POST request to Binance.US API
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
        const binanceMsg = error.response.data.msg || 'Binance.US API error';

        if (binanceCode === -2015 || binanceCode === -1022) {
          throw new InvalidApiKeyException(binanceMsg);
        }

        if (binanceCode === -1003) {
          throw new BinanceRateLimitException(binanceMsg);
        }

        throw new BinanceApiException(binanceMsg, `BINANCE_US_${binanceCode}`);
      }

      if (error.response?.status === 400) {
        const msg =
          error.response?.data?.msg ||
          error.response?.data?.message ||
          error.message ||
          'Bad request to Binance.US API';
        throw new BinanceApiException(msg, 'BINANCE_US_BAD_REQUEST', HttpStatus.BAD_REQUEST);
      }

      throw new BinanceApiException(error.message || 'Failed to place order');
    }
  }

  /**
   * Makes a signed DELETE request to Binance.US API
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
        const binanceMsg = error.response.data.msg || 'Binance.US API error';

        if (binanceCode === -2015 || binanceCode === -1022) {
          throw new InvalidApiKeyException(binanceMsg);
        }

        if (binanceCode === -1003) {
          throw new BinanceRateLimitException(binanceMsg);
        }

        throw new BinanceApiException(binanceMsg, `BINANCE_US_${binanceCode}`);
      }

      if (error.response?.status === 400) {
        const msg =
          error.response?.data?.msg ||
          error.response?.data?.message ||
          error.message ||
          'Bad request to Binance.US API';
        throw new BinanceApiException(msg, 'BINANCE_US_BAD_REQUEST', HttpStatus.BAD_REQUEST);
      }

      throw new BinanceApiException(error.message || 'Failed to delete order');
    }
  }

  /**
   * Normalizes an incoming symbol to a Binance.US trading pair.
   * Spot-holding endpoints return just the base asset (e.g. "BTC"), but
   * Binance.US orders/cancels need a pair ("BTCUSD"). Also folds USDT→USD
   * since Binance.US quotes in USD, not USDT.
   */
  resolveTradingPair(symbol: string): string {
    const inSymUp = (symbol || '').toUpperCase().trim();
    const inKnownQuotes = ['USD', 'USDT', 'USDC', 'BUSD', 'BTC', 'ETH', 'BNB'];
    const isPair = inKnownQuotes.some(
      (q) => inSymUp.endsWith(q) && inSymUp.length > q.length,
    );
    if (isPair && inSymUp.endsWith('USDT')) {
      return inSymUp.replace(/USDT$/, 'USD');
    }
    if (!isPair) {
      return `${inSymUp}USD`;
    }
    return inSymUp;
  }

  /**
   * Places an order on Binance.US
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

      symbol = this.resolveTradingPair(symbol);

      // Validate and adjust quantity to comply with LOT_SIZE and MIN_NOTIONAL filters
      const adjustedQuantity = await this.validateAndAdjustQuantity(symbol, quantity, type, price);

      const params: Record<string, any> = {
        symbol,
        side: side.toUpperCase(),
        type: type === 'MARKET' ? 'MARKET' : 'LIMIT',
        quantity: adjustedQuantity,
      };

      if (type === 'LIMIT') {
        params.price = price!.toString();
        params.timeInForce = 'GTC'; // Good Till Cancel
      }

      const order = await this.makeSignedPostRequest('/api/v3/order', apiKey, apiSecret, params);

      const executedQty = parseFloat(order.executedQty || order.origQty || '0');
      const rawPrice = parseFloat(order.price || '0');
      const quoteQty = parseFloat(order.cummulativeQuoteQty || '0');
      let executionPrice =
        rawPrice === 0 && executedQty > 0 && quoteQty > 0
          ? quoteQty / executedQty
          : rawPrice;

      // For some MARKET responses, Binance.US may still return incomplete price fields.
      // Query the order once to compute average fill price from cummulativeQuoteQty.
      if (executionPrice <= 0 && order.orderId && order.symbol) {
        try {
          const orderDetails = await this.makeSignedRequest('/api/v3/order', apiKey, apiSecret, {
            symbol: order.symbol,
            orderId: order.orderId.toString(),
          });
          const detailExecutedQty = parseFloat(orderDetails.executedQty || executedQty.toString() || '0');
          const detailQuoteQty = parseFloat(orderDetails.cummulativeQuoteQty || '0');
          if (detailExecutedQty > 0 && detailQuoteQty > 0) {
            executionPrice = detailQuoteQty / detailExecutedQty;
          }
        } catch {
          // Keep initial values if details fetch fails.
        }
      }

      // When commission is charged in base asset, the tradable amount is less than executedQty.
      const knownQuotes = ['USD', 'USDT', 'BUSD', 'BTC', 'ETH', 'BNB'];
      const symUp = (order.symbol || symbol || '').toUpperCase();
      const quote = knownQuotes.find((q) => symUp.endsWith(q)) ?? '';
      const baseAsset = quote ? symUp.slice(0, symUp.length - quote.length) : '';
      const fills: Array<{ commission: string; commissionAsset: string }> = order.fills || [];
      const baseAssetFees = fills.reduce((sum: number, fill: any) => {
        return baseAsset && (fill.commissionAsset || '').toUpperCase() === baseAsset
          ? sum + parseFloat(fill.commission || '0')
          : sum;
      }, 0);
      const receivedQty = baseAssetFees > 0 ? Math.max(0, executedQty - baseAssetFees) : executedQty;

      return {
        orderId: order.orderId.toString(),
        symbol: order.symbol,
        side: order.side as 'BUY' | 'SELL',
        type: order.type,
        quantity: receivedQty,
        price: executionPrice,
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
   * @param apiKey - Binance.US API key
   * @param apiSecret - Binance.US API secret
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

      // Binance.US rejects OCO when quantity/price precision exceeds symbol filters.
      const [roundedTpPrice, roundedSlPrice, roundedSlLimitPrice, adjustedQty] = await Promise.all([
        this.roundPriceToTickSize(symbol, takeProfitPrice),
        this.roundPriceToTickSize(symbol, stopLossPrice),
        this.roundPriceToTickSize(symbol, effectiveStopLimitPrice),
        this.validateAndAdjustQuantity(symbol, quantity, 'LIMIT', takeProfitPrice),
      ]);

      const params: Record<string, any> = {
        symbol,
        side: side.toUpperCase(),
        quantity: adjustedQty,
        price: roundedTpPrice,        // Take profit limit price
        stopPrice: roundedSlPrice,    // Stop trigger price
        stopLimitPrice: roundedSlLimitPrice, // Stop limit price
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
   * Cancels ALL open orders (regular + OCO legs) for a specific symbol.
   * Used by the "close position" flow to free up locked base-coin balance
   * before a market SELL.
   */
  async cancelAllOpenOrdersForSymbol(
    apiKey: string,
    apiSecret: string,
    symbol: string,
  ): Promise<string[]> {
    try {
      const result = await this.makeSignedDeleteRequest(
        '/api/v3/openOrders',
        apiKey,
        apiSecret,
        { symbol },
      );
      const arr = Array.isArray(result) ? result : [];
      const ids = arr.map((o: any) => String(o?.orderId ?? o?.origClientOrderId ?? '')).filter(Boolean);
      if (ids.length > 0) {
        this.logger.log(`Cancelled ${ids.length} open order(s) on ${symbol} (Binance.US) before close-position sell`);
      }
      return ids;
    } catch (error: any) {
      const msg = (error?.response?.data?.msg || error?.message || '').toLowerCase();
      if (msg.includes('unknown order') || error?.response?.data?.code === -2011) {
        return [];
      }
      this.logger.warn(`cancelAllOpenOrdersForSymbol (Binance.US) ${symbol} failed: ${error?.message || error}`);
      return [];
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
   * Get all orders for a symbol (NEW, FILLED, CANCELED, EXPIRED)
   * Binance US API: GET /api/v3/allOrders
   */
  async getAllOrders(
    apiKey: string,
    apiSecret: string,
    symbol: string,
    params?: { orderId?: number; startTime?: number; endTime?: number; limit?: number },
  ): Promise<any[]> {
    try {
      const queryParams: Record<string, any> = {
        symbol: symbol.toUpperCase(),
        limit: Math.min(params?.limit || 500, 1000),
      };
      if (params?.orderId) queryParams.orderId = params.orderId;
      if (params?.startTime) queryParams.startTime = params.startTime;
      if (params?.endTime) queryParams.endTime = params.endTime;

      const orders = await this.makeSignedRequest('/api/v3/allOrders', apiKey, apiSecret, queryParams);

      return orders.map((o: any) => ({
        orderId: o.orderId?.toString(),
        symbol: o.symbol,
        side: o.side,
        type: o.type,
        status: o.status,
        quantity: parseFloat(o.origQty || '0'),
        executedQty: parseFloat(o.executedQty || '0'),
        price: parseFloat(o.price || '0'),
        cummulativeQuoteQty: parseFloat(o.cummulativeQuoteQty || '0'),
        stopPrice: o.stopPrice ? parseFloat(o.stopPrice) : null,
        timeInForce: o.timeInForce,
        time: o.time,
        updateTime: o.updateTime,
        isWorking: o.isWorking,
      }));
    } catch (error: any) {
      if (error instanceof BinanceApiException) throw error;
      throw new BinanceApiException(`Failed to fetch all orders for ${symbol}: ${error.message}`);
    }
  }

  /**
   * Get filled trade executions for a symbol (with commission and buyer/seller side)
   * Binance US API: GET /api/v3/myTrades
   */
  async getMyTrades(
    apiKey: string,
    apiSecret: string,
    symbol: string,
    params?: { orderId?: number; startTime?: number; endTime?: number; limit?: number },
  ): Promise<any[]> {
    try {
      const queryParams: Record<string, any> = {
        symbol: symbol.toUpperCase(),
        limit: Math.min(params?.limit || 500, 1000),
      };
      if (params?.orderId) queryParams.orderId = params.orderId;
      if (params?.startTime) queryParams.startTime = params.startTime;
      if (params?.endTime) queryParams.endTime = params.endTime;

      const trades = await this.makeSignedRequest('/api/v3/myTrades', apiKey, apiSecret, queryParams);

      return trades.map((t: any) => ({
        id: t.id,
        orderId: t.orderId,
        symbol: t.symbol,
        price: parseFloat(t.price),
        qty: parseFloat(t.qty),
        quoteQty: parseFloat(t.quoteQty),
        commission: parseFloat(t.commission),
        commissionAsset: t.commissionAsset,
        time: t.time,
        isBuyer: t.isBuyer,
        isMaker: t.isMaker,
      }));
    } catch (error: any) {
      if (error instanceof BinanceApiException) throw error;
      throw new BinanceApiException(`Failed to fetch trades for ${symbol}: ${error.message}`);
    }
  }

  /**
   * Fetches deposit history for user (Binance.US)
   * Endpoint: /sapi/v1/capital/deposit/hisrec
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
        status: deposit.status,
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
      throw new BinanceApiException(`Failed to fetch Binance.US deposit history: ${error.message}`);
    }
  }

  /**
   * Fetches withdrawal history for user (Binance.US)
   * Endpoint: /sapi/v1/capital/withdraw/history
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
      if (status !== undefined) params.status = status;
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
        status: withdrawal.status,
        completeTime: withdrawal.completeTime,
        applyTime: withdrawal.applyTime,
        transferType: withdrawal.transferType,
        info: withdrawal.info,
      }));
    } catch (error: any) {
      if (error instanceof BinanceApiException || error instanceof InvalidApiKeyException) {
        throw error;
      }
      throw new BinanceApiException(`Failed to fetch Binance.US withdrawal history: ${error.message}`);
    }
  }
}
