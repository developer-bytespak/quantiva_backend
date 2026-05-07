import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { randomUUID } from 'crypto';

/**
 * client_order_id prefixes used to identify orders our backend placed
 * automatically on behalf of the user (as opposed to manual orders the
 * user placed themselves directly in Alpaca). The orphan-cleanup cron
 * only cancels orders whose client_order_id starts with one of these
 * prefixes — never touches user-placed orders.
 */
export const ALPACA_CLIENT_ID_TP_PREFIX = 'ta-tp-';
export const ALPACA_CLIENT_ID_SL_PREFIX = 'ta-sl-';
export const ALPACA_CLIENT_ID_TA_PREFIX = 'ta-';

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
   * GET /v2/clock — authoritative US market clock from Alpaca. Honors
   * holidays and early-close days (which a local Mon–Fri 09:30–16:00 ET
   * computation does not). Returns the raw Alpaca payload:
   *   { timestamp, is_open, next_open, next_close }
   */
  async getClock(apiKey?: string, apiSecret?: string): Promise<any> {
    const keyToUse = apiKey || this.apiKey;
    const isPaperKey = keyToUse?.startsWith('PK');
    const client = isPaperKey ? this.paperApiClient : this.apiClient;

    const res = await client.get('/v2/clock', {
      headers: this.getAuthHeaders(apiKey, apiSecret),
    });
    return res.data;
  }

  /**
   * Get account information including balance
   */
  async getAccountInfo(apiKey?: string, apiSecret?: string): Promise<any> {
    // Detect if it's a paper or live key based on the key prefix
    const keyToUse = apiKey || this.apiKey;
    const isPaperKey = keyToUse?.startsWith('PK');
    const client = isPaperKey ? this.paperApiClient : this.apiClient;
    
    try {
      const res = await client.get('/v2/account', {
        headers: this.getAuthHeaders(apiKey, apiSecret),
      });
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
   * Pattern Day Trader status derived from /v2/account.
   *
   * `daytrade_count` is Alpaca's authoritative count of day trades in the
   * rolling 5-business-day window. The 4th day trade triggers PDT flagging
   * under SEC rules — Alpaca's PDT protection blocks the order that would
   * be the 4th, so users below $25K equity can place 3 before being stopped.
   *
   * `daytradesRemaining` is null for accounts ≥ $25K (PDT does not apply —
   * UI should hide the counter). Otherwise it's max(0, 3 - daytrade_count).
   *
   * Equity and an `isPdtRestricted` derived flag were intentionally dropped:
   * equity is already exposed on the dashboard payload as `totals.spot`, and
   * `isPdtRestricted` collapses to `isPatternDayTrader` whenever the caller
   * has gated on `daytradesRemaining !== null` (which already encodes the
   * sub-$25K subject-to-PDT condition).
   *
   * Stocks only — crypto is exempt from PDT. Caller is responsible for only
   * invoking this on Alpaca stock connections.
   */
  async getDayTradeStatus(
    apiKey: string,
    apiSecret: string,
  ): Promise<{
    daytradeCount: number;
    daytradesRemaining: number | null;
    isPatternDayTrader: boolean;
  }> {
    const account = await this.getAccountInfo(apiKey, apiSecret);
    const equity = parseFloat(account.equity ?? '0') || 0;
    const daytradeCount = parseInt(account.daytrade_count ?? '0', 10) || 0;
    const subjectToPdt = equity < 25_000;
    return {
      daytradeCount,
      daytradesRemaining: subjectToPdt ? Math.max(0, 3 - daytradeCount) : null,
      isPatternDayTrader: !!account.pattern_day_trader,
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
   * Get orders with optional filters. Alpaca's /v2/orders endpoint accepts
   * status='open' | 'closed' | 'all' and a limit up to 500. Default limit
   * stays at 100 for backwards compatibility with existing callers.
   */
  async getOrders(
    apiKey?: string,
    apiSecret?: string,
    status: 'open' | 'closed' | 'all' = 'open',
    limit = 100,
  ): Promise<any[]> {
    const client = this.getClientForKey(apiKey);
    const res = await client.get('/v2/orders', {
      headers: this.getAuthHeaders(apiKey, apiSecret),
      params: {
        status,
        limit: Math.min(Math.max(limit, 1), 500),
        direction: 'desc',
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

      // Translate Alpaca API errors into clear HttpExceptions so the frontend
      // gets actionable messages instead of opaque 500s. Match by message text
      // rather than numeric codes — Alpaca's codes are not well-documented and
      // may change. The fallback at the end re-throws the original error so
      // unknown failures still bubble up unchanged.
      const httpStatus = error?.response?.status;
      const data = error?.response?.data;
      if (httpStatus && data && typeof data === 'object') {
        const alpacaMessage: string = (data.message || '').toString();
        const lower = alpacaMessage.toLowerCase();

        if (lower.includes('wash trade')) {
          throw new HttpException(
            {
              success: false,
              code: 'WASH_TRADE_BLOCKED',
              message:
                'An opposite-side order on this symbol is still active. Most often this means a previous buy has not finished filling yet. Wait for it to fill, or cancel the existing order, then retry.',
              alpacaMessage,
              existingOrderId: data.existing_order_id,
            },
            HttpStatus.CONFLICT,
          );
        }

        // Sell rejected because Alpaca does not yet see a position to sell.
        // Common cause: the buy that created the position has not finished
        // filling, so the shares are not available to sell yet.
        if (
          lower.includes('position not found') ||
          lower.includes('no position') ||
          lower.includes('may only sell positions you currently hold') ||
          lower.includes('you do not have any holdings')
        ) {
          throw new HttpException(
            {
              success: false,
              code: 'POSITION_NOT_AVAILABLE',
              message:
                'You cannot sell this symbol yet. The buy that creates this position has not finished filling. Wait a few seconds and retry, or check the order status.',
              alpacaMessage,
            },
            HttpStatus.BAD_REQUEST,
          );
        }

        if (lower.includes('insufficient qty') || lower.includes('insufficient quantity')) {
          throw new HttpException(
            {
              success: false,
              code: 'INSUFFICIENT_QUANTITY',
              message:
                'Not enough shares available to sell. Either the buy has not finished filling, the shares are held by an existing TP/SL order, or you do not own this many shares.',
              alpacaMessage,
            },
            HttpStatus.BAD_REQUEST,
          );
        }

        if (
          lower.includes('insufficient buying power') ||
          lower.includes('insufficient day trading buying power')
        ) {
          throw new HttpException(
            {
              success: false,
              code: 'INSUFFICIENT_BUYING_POWER',
              message: 'Not enough buying power to place this order.',
              alpacaMessage,
            },
            HttpStatus.BAD_REQUEST,
          );
        }

        if (lower.includes('pattern day') || lower.includes('pdt')) {
          throw new HttpException(
            {
              success: false,
              code: 'PDT_RESTRICTED',
              message:
                'Pattern Day Trader rules block this trade. Account equity is below $25,000.',
              alpacaMessage,
            },
            HttpStatus.FORBIDDEN,
          );
        }

        if (
          lower.includes('market is closed') ||
          lower.includes('market closed') ||
          lower.includes('extended hours')
        ) {
          throw new HttpException(
            {
              success: false,
              code: 'MARKET_CLOSED',
              message:
                'The market is currently closed for this symbol. Try again during regular trading hours.',
              alpacaMessage,
            },
            HttpStatus.BAD_REQUEST,
          );
        }

        if (httpStatus === 422) {
          throw new HttpException(
            {
              success: false,
              code: 'INVALID_ORDER',
              message: alpacaMessage || 'Order validation failed.',
            },
            HttpStatus.BAD_REQUEST,
          );
        }

        if (httpStatus === 403) {
          throw new HttpException(
            {
              success: false,
              code: 'ALPACA_FORBIDDEN',
              message: alpacaMessage || 'Alpaca rejected the order.',
            },
            HttpStatus.FORBIDDEN,
          );
        }
      }

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
   * Cancel a single order by ID. Used for orphan cleanup and manual cancels.
   * Returns silently on 404/422 ("order already finalized") — if the order is
   * already filled or canceled, the cleanup is effectively a no-op.
   */
  async cancelOrder(apiKey: string, apiSecret: string, orderId: string): Promise<void> {
    if (!orderId) return;
    const client = this.getClientForKey(apiKey);
    try {
      await client.delete(`/v2/orders/${orderId}`, {
        headers: this.getAuthHeaders(apiKey, apiSecret),
      });
      this.logger.log(`Alpaca order ${orderId} canceled`);
    } catch (error: any) {
      const status = error?.response?.status;
      if (status === 404 || status === 422) {
        this.logger.debug(
          `Alpaca order ${orderId} cancel skipped (status ${status}): already finalized`,
        );
        return;
      }
      this.logger.warn(`Alpaca cancelOrder ${orderId} failed: ${error?.message}`);
      throw error;
    }
  }

  /**
   * Orphan cleanup helper: cancel every OPEN sell order on a given symbol.
   * Used by the top-trade auto-protection flow to clear stale TP/SL legs
   * before attaching new ones. If a user had a previous auto-trade where the
   * Stop-Loss fired (closing the position) but the Take-Profit was never
   * canceled, we'd otherwise reject the next buy with a wash-trade error.
   * Returns the list of order IDs that were canceled.
   */
  async cancelOpenSellOrdersForSymbol(
    apiKey: string,
    apiSecret: string,
    symbol: string,
  ): Promise<string[]> {
    const alpacaSymbol = this.convertToAlpacaSymbol(symbol);
    const openOrders = await this.getOrders(apiKey, apiSecret, 'open', 500);
    // Only cancel orders we placed (identified by the `ta-` client_order_id
    // prefix). Orders the user placed directly in Alpaca lack this prefix
    // and are never touched by our cleanup logic.
    const matches = (openOrders || []).filter((o: any) => {
      const sym = (o.symbol || '').toUpperCase();
      const side = (o.side || '').toLowerCase();
      const clientId = (o.client_order_id || '') as string;
      return (
        sym === alpacaSymbol.toUpperCase() &&
        side === 'sell' &&
        clientId.startsWith(ALPACA_CLIENT_ID_TA_PREFIX)
      );
    });
    if (matches.length === 0) return [];

    this.logger.log(
      `Canceling ${matches.length} auto-placed sell order(s) on ${alpacaSymbol} before placing new protection`,
    );

    const canceledIds: string[] = [];
    for (const o of matches) {
      try {
        await this.cancelOrder(apiKey, apiSecret, o.id);
        canceledIds.push(o.id);
      } catch (err: any) {
        this.logger.warn(
          `Failed to cancel orphan order ${o.id} on ${alpacaSymbol}: ${err?.message}`,
        );
      }
    }
    return canceledIds;
  }

  /**
   * Attach TP/SL protection to an existing position using Alpaca's OCO
   * (One-Cancels-Other) order class. A single API call submits both legs
   * as a linked pair — Alpaca locks the shares once for the pair and
   * server-side auto-cancels the unfilled leg when the other fills.
   *
   * This replaces the prior two-independent-orders implementation, which
   * caused the "insufficient qty available" / orphan bug class: TP would
   * place first, lock all shares, and SL would fail with `available: 0`,
   * leaving an orphan TP on Alpaca. OCO makes that scenario structurally
   * impossible. See ALPACA_OCO_MIGRATION_PLAN.md.
   *
   * Note: bracket (`order_class: 'bracket'`) is NOT used here because
   * bracket requires atomic entry+TP+SL submission and cannot attach to
   * an already-filled position. OCO is a different order_class that does
   * support post-fill attachment.
   *
   * Rollback: set ALPACA_USE_OCO=false to revert to the legacy two-orders
   * path without redeploying. The legacy branch is preserved in this method
   * for emergency rollback only — remove after 30 days of clean OCO ops.
   *
   * Stocks require whole-share quantities for LIMIT/STOP orders, so callers
   * must floor fractional positions before invoking this method (or pass the
   * exact quantity for crypto symbols, which support fractionals).
   */
  async placeProtectionOrders(
    apiKey: string,
    apiSecret: string,
    symbol: string,
    quantity: number,
    takeProfitPrice: number,
    stopLossPrice: number,
  ): Promise<{ takeProfitOrderId: string; stopLossOrderId: string }> {
    const alpacaSymbol = this.convertToAlpacaSymbol(symbol);
    const client = this.getClientForKey(apiKey);
    const headers = this.getAuthHeaders(apiKey, apiSecret);

    // Alpaca rejects stock orders with sub-penny precision on prices ≥ $1
    // ("invalid limit_price. sub-penny increment does not fulfill minimum
    // pricing criteria", code 42210000). Round both legs to the nearest cent
    // before submitting. The top-trade universe is liquid mid-to-large caps
    // well above $1, so 2-decimal rounding is safe across all symbols.
    const roundToCents = (n: number) => (Math.round(n * 100) / 100).toFixed(2);
    const tpPriceRounded = roundToCents(takeProfitPrice);
    const slPriceRounded = roundToCents(stopLossPrice);

    const useOco =
      (process.env.ALPACA_USE_OCO ?? 'true').toLowerCase() !== 'false';

    if (useOco) {
      // OCO path. Verified body shape against live Alpaca on 2026-05-07:
      //   - top-level `type: 'limit'` is required
      //   - leg prices live in nested `take_profit` / `stop_loss` objects
      //   - response: parent order represents the TP leg; legs[0] is the SL
      //   - shares lock once for the pair; auto-cancel of the other leg
      //     happens server-side in <10ms when one fills
      this.logger.log(
        `Placing Alpaca OCO protection: ${quantity} ${alpacaSymbol} TP=${tpPriceRounded} SL=${slPriceRounded}`,
      );

      // Tag with the `ta-tp-` prefix so the orphan-cleanup cron (still alive
      // during the migration as a safety net) recognizes this as one of ours.
      const ocoClientId = `${ALPACA_CLIENT_ID_TP_PREFIX}${randomUUID()}`;

      const ocoBody = {
        symbol: alpacaSymbol,
        qty: quantity.toString(),
        side: 'sell',
        type: 'limit',
        order_class: 'oco',
        time_in_force: 'gtc',
        take_profit: { limit_price: tpPriceRounded },
        stop_loss: { stop_price: slPriceRounded },
        client_order_id: ocoClientId,
      };

      try {
        const res = await this.postOrderWithRaceRetry(
          client,
          headers,
          ocoBody,
          'OCO',
        );
        const tpOrderId = res?.id ?? '';
        const slOrderId = res?.legs?.[0]?.id ?? '';

        if (!tpOrderId || !slOrderId) {
          // Defensive: 200 OK but the response shape was unexpected. Cancel
          // whatever came back so we don't leave an orphan, then surface the
          // error to the caller's existing ocoError handling.
          this.logger.error(
            `Alpaca OCO returned unexpected shape: parent=${tpOrderId} sl=${slOrderId}`,
          );
          if (tpOrderId) {
            await this.cancelOrder(apiKey, apiSecret, tpOrderId).catch(() => {});
          }
          throw new Error(
            `Alpaca OCO returned unexpected shape (parent=${tpOrderId}, sl=${slOrderId})`,
          );
        }

        return { takeProfitOrderId: tpOrderId, stopLossOrderId: slOrderId };
      } catch (error: any) {
        this.logger.error(
          `Error placing Alpaca OCO protection: ${error?.message}`,
          error?.response?.data,
        );
        throw error;
      }
    }

    // --- Legacy fallback: two separate orders ---
    // Reachable only via ALPACA_USE_OCO=false. Known limitation: when TP
    // places first it locks all shares, causing SL to fail with
    // "insufficient qty available" and leaving an orphan TP on Alpaca.
    // The orphan-cleanup cron and queued-trade retry exist to mitigate
    // this — see ALPACA_ORDER_FLOWS_CURRENT.md.
    this.logger.warn(
      `Placing Alpaca legacy two-order protection (OCO disabled via env): ${quantity} ${alpacaSymbol} TP=${tpPriceRounded} SL=${slPriceRounded}`,
    );

    const tpClientId = `${ALPACA_CLIENT_ID_TP_PREFIX}${randomUUID()}`;
    const slClientId = `${ALPACA_CLIENT_ID_SL_PREFIX}${randomUUID()}`;

    const tpBody = {
      symbol: alpacaSymbol,
      qty: quantity.toString(),
      side: 'sell',
      type: 'limit',
      limit_price: tpPriceRounded,
      time_in_force: 'gtc',
      client_order_id: tpClientId,
    };

    const slBody = {
      symbol: alpacaSymbol,
      qty: quantity.toString(),
      side: 'sell',
      type: 'stop',
      stop_price: slPriceRounded,
      time_in_force: 'gtc',
      client_order_id: slClientId,
    };

    try {
      // Each leg retries independently on race errors so that if TP succeeds
      // on the first attempt and SL hits the race, we retry only SL — we
      // don't re-place TP and end up with a duplicate.
      const tpRes = await this.postOrderWithRaceRetry(client, headers, tpBody, 'TP');
      const slRes = await this.postOrderWithRaceRetry(client, headers, slBody, 'SL');

      return {
        takeProfitOrderId: tpRes?.id || '',
        stopLossOrderId: slRes?.id || '',
      };
    } catch (error: any) {
      this.logger.error(
        `Error placing Alpaca legacy protection: ${error.message}`,
        error?.response?.data,
      );
      throw error;
    }
  }

  /**
   * POST an order with built-in retry for Alpaca's sub-second race condition
   * where TP/SL placement arrives before the buy has fully settled. Retries
   * only on known race-error phrases; real errors (insufficient buying power,
   * market closed, etc.) bubble up immediately without retry so the user
   * sees them fast. Max 3 attempts, 500ms backoff between attempts.
   */
  private async postOrderWithRaceRetry(
    client: AxiosInstance,
    headers: Record<string, string | undefined>,
    body: Record<string, any>,
    leg: 'TP' | 'SL' | 'OCO',
  ): Promise<any> {
    const maxAttempts = 3;
    const backoffMs = 500;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await client.post('/v2/orders', body, { headers });
        if (attempt > 1) {
          this.logger.log(
            `Alpaca protection ${leg} placed on retry attempt ${attempt} (race condition resolved)`,
          );
        }
        return res.data;
      } catch (err: any) {
        const status = err?.response?.status;
        const msg = ((err?.response?.data?.message ?? '') + '').toLowerCase();
        const isRaceError =
          (status === 403 || status === 422) &&
          (msg.includes('insufficient qty') ||
            msg.includes('insufficient quantity') ||
            msg.includes('position not found') ||
            msg.includes('no position') ||
            msg.includes('may only sell positions you currently hold') ||
            msg.includes('you do not have any holdings'));

        if (isRaceError && attempt < maxAttempts) {
          this.logger.warn(
            `Alpaca protection ${leg} hit race condition (attempt ${attempt}/${maxAttempts}): ${msg}. Retrying in ${backoffMs}ms.`,
          );
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }

        // Either a non-race error (bubble up immediately so caller sees the
        // real reason), or we've exhausted retries on a persistent race
        // (caller's existing error-translation + ocoError fallback handles it).
        throw err;
      }
    }

    // Unreachable: either we returned on success or threw above. Included for
    // TypeScript's control-flow analysis.
    throw new Error(`Alpaca protection ${leg}: exhausted ${maxAttempts} attempts`);
  }

  /**
   * Fetch recent trades for a stock symbol from Alpaca's Data API and map
   * them to the RecentTradeDto shape used by the unified /trades/:symbol
   * endpoint: { id, price, quantity, time, isBuyerMaker }. Alpaca doesn't
   * expose which side was the maker on retail data, so isBuyerMaker is
   * always false — frontends that use this for ticker-tape style display
   * still get price/size/timestamp correctly.
   */
  async getRecentTrades(
    apiKey: string,
    apiSecret: string,
    symbol: string,
    limit: number = 50,
  ): Promise<
    Array<{
      id: string;
      price: number;
      quantity: number;
      time: number;
      isBuyerMaker: boolean;
    }>
  > {
    const client = this.getDataApiClient(apiKey, apiSecret);
    const sym = symbol.toUpperCase();
    const requestLimit = Math.min(Math.max(limit, 1), 10000);
    const res = await client.get<{
      trades?: Array<{ t: string; x?: string; p: number; s: number; c?: string[]; i?: number; z?: string }>;
    }>(`/v2/stocks/${sym}/trades`, { params: { limit: requestLimit, feed: 'iex' } });
    const trades = res.data?.trades ?? [];
    return trades.map((t, idx) => ({
      id: String(t.i ?? idx),
      price: Number(t.p) || 0,
      quantity: Number(t.s) || 0,
      time: t.t ? new Date(t.t).getTime() : Date.now(),
      isBuyerMaker: false,
    }));
  }

  /**
   * True for any symbol that looks like a crypto trade on the Alpaca side.
   * Used to block crypto orders on Alpaca connections in the user-initiated
   * unified flow (ExchangesService.placeOrder). NOT applied inside this
   * service's placeOrder so that the strategies paper-trading flow — which
   * calls AlpacaService.placeOrder directly with env-configured keys — can
   * still exercise Alpaca's supported cryptos on its shared paper account.
   *
   * Matches:
   *  - Slash-separated symbols like "BTC/USD", "ETH/USDT"
   *  - Binance-style crypto quotes: "BTCUSDT", "ETHUSDC"
   *  - Bare base symbols in the ALPACA_SUPPORTED_CRYPTO list: "BTC", "ETH"
   *  - Base/USD forms where base is in the crypto list: "BTCUSD"
   *
   * Does NOT match regular stock tickers like "AAPL", "KO", "MSFT", "BRK.B".
   */
  isAlpacaCryptoSymbol(symbol: string): boolean {
    if (!symbol) return false;
    const upper = symbol.toUpperCase().trim();

    if (upper.includes('/')) return true;
    if (upper.endsWith('USDT') || upper.endsWith('USDC')) return true;

    const cryptoSet = new Set(ALPACA_SUPPORTED_CRYPTO);
    if (cryptoSet.has(upper)) return true;

    if (upper.endsWith('USD')) {
      const base = upper.slice(0, -3);
      if (cryptoSet.has(base)) return true;
    }

    return false;
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
   * Uses end=now and returns the last `limit` bars so charts (e.g. 8H) show latest data.
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
    const end = new Date();
    const requestLimit = Math.min(10000, Math.max(limit, 500));
    const res = await client.get<{ bars?: Record<string, AlpacaBarDto[]> }>('/v2/stocks/bars', {
      params: {
        symbols: sym,
        timeframe: alpacaTf,
        start: start.toISOString(),
        end: end.toISOString(),
        limit: requestLimit,
        adjustment: 'split',
        feed: 'iex',
      },
    });
    const bars = res.data?.bars?.[sym] ?? [];
    return bars.length <= limit ? bars : bars.slice(-limit);
  }

  /**
   * Fetch tickers for one or more stock symbols and map each to the same shape
   * Binance and Bybit return: { symbol, price, change24h, changePercent24h, volume24h }.
   * This lets the unified controller call this method from its Alpaca branch
   * without any shape adaptation downstream. Alpaca's Data API requires
   * credentials even for "public" market data, so apiKey/apiSecret are required.
   */
  async getTickerPrices(
    apiKey: string,
    apiSecret: string,
    symbols: string[],
  ): Promise<
    Array<{
      symbol: string;
      price: number;
      change24h: number;
      changePercent24h: number;
      volume24h: number;
    }>
  > {
    if (!symbols || symbols.length === 0) return [];
    const upperSymbols = symbols.map((s) => s.toUpperCase());
    const client = this.getDataApiClient(apiKey, apiSecret);
    const res = await client.get<Record<string, AlpacaSnapshot>>('/v2/stocks/snapshots', {
      params: { symbols: upperSymbols.join(','), feed: 'iex' },
    });
    const out: Array<{
      symbol: string;
      price: number;
      change24h: number;
      changePercent24h: number;
      volume24h: number;
    }> = [];
    for (const sym of upperSymbols) {
      const snapshot = res.data?.[sym];
      if (!snapshot) continue;
      const price = toNumOrZero(snapshot.latestTrade?.p ?? snapshot.latestQuote?.ap);
      const prevClose = toNumOrZero(snapshot.prevDailyBar?.c ?? snapshot.dailyBar?.c);
      let change24h = 0;
      let changePercent24h = 0;
      if (prevClose > 0 && price > 0) {
        change24h = price - prevClose;
        changePercent24h = (change24h / prevClose) * 100;
      }
      out.push({
        symbol: sym,
        price,
        change24h,
        changePercent24h,
        volume24h: snapshot.dailyBar?.v ?? 0,
      });
    }
    return out;
  }

  /**
   * Fetch historical candles for a stock symbol and map them to the same shape
   * Binance/Bybit return: { openTime, open, high, low, close, volume, closeTime }.
   * Alpaca bars only expose the bar's start timestamp; closeTime is left equal
   * to openTime because charts read openTime and Alpaca's discrete bars don't
   * carry a separate end timestamp. startTime/endTime params are accepted but
   * ignored by this wrapper for now — getStockBars computes its own start
   * window from the requested limit and timeframe.
   */
  async getCandlestickData(
    apiKey: string,
    apiSecret: string,
    symbol: string,
    interval: string,
    limit: number,
    _startTime?: number,
    _endTime?: number,
  ): Promise<
    Array<{
      openTime: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
      closeTime: number;
    }>
  > {
    const bars = await this.getStockBars(apiKey, apiSecret, symbol, interval, limit);
    return bars.map((b) => {
      const openTime = new Date(b.t).getTime();
      return {
        openTime,
        open: b.o,
        high: b.h,
        low: b.l,
        close: b.c,
        volume: b.v,
        closeTime: openTime,
      };
    });
  }

  private mapDataApiTimeframe(tf: string): string {
    // Map Binance/Bybit-style interval strings to Alpaca's CamelCase form.
    // Covers the full set Alpaca supports so price-performance, market-detail,
    // and candle endpoints can request any timeframe without a second mapping.
    const m: Record<string, string> = {
      '1m': '1Min', '5m': '5Min', '15m': '15Min', '30m': '30Min',
      '1h': '1Hour', '2h': '2Hour', '4h': '4Hour', '6h': '6Hour', '8h': '8Hour', '12h': '12Hour',
      '1d': '1Day', '1w': '1Week', '1M': '1Month',
      // Identity mappings so an already-Alpaca-formatted string passes through.
      '1Min': '1Min', '5Min': '5Min', '15Min': '15Min', '30Min': '30Min',
      '1Hour': '1Hour', '2Hour': '2Hour', '4Hour': '4Hour', '6Hour': '6Hour', '8Hour': '8Hour', '12Hour': '12Hour',
      '1Day': '1Day', '1Week': '1Week', '1Month': '1Month',
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
