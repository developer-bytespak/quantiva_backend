import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { Logger } from '@nestjs/common';
import { OptionCredentials } from '../options-venue.interface';
import { ALPACA_URLS, ALPACA_DEFAULT_FEED } from './alpaca-contract-specs';

/**
 * Thin axios wrapper around Alpaca's Trading + Market Data APIs scoped to
 * options endpoints. Lives inside the options module so we can evolve the
 * surface area independently of the broader `AlpacaService` used for stocks.
 *
 * Paper vs live is detected by API-key prefix (`PK*` = paper, `AK*` = live),
 * matching the convention established in
 * [alpaca.service.ts](quantiva_backend/q_nest/src/modules/exchanges/integrations/alpaca.service.ts).
 * Data API base is shared between paper and live accounts.
 */
export class AlpacaOptionsClient {
  private readonly logger = new Logger(AlpacaOptionsClient.name);
  private readonly trading: AxiosInstance;
  private readonly data: AxiosInstance;

  /**
   * @param credentials decrypted user creds from ExchangesService
   * @param isPaperOverride optional override; defaults to key-prefix detection
   */
  constructor(
    private readonly credentials: OptionCredentials,
    isPaperOverride?: boolean,
  ) {
    const isPaper =
      typeof isPaperOverride === 'boolean'
        ? isPaperOverride
        : credentials.apiKey?.startsWith('PK') === true;

    this.trading = axios.create({
      baseURL: isPaper ? ALPACA_URLS.tradingPaper : ALPACA_URLS.tradingLive,
      timeout: 10_000,
      headers: this.authHeaders(),
    });
    this.data = axios.create({
      baseURL: ALPACA_URLS.data,
      timeout: 10_000,
      headers: this.authHeaders(),
    });
  }

  private authHeaders() {
    return {
      'APCA-API-KEY-ID': this.credentials.apiKey,
      'APCA-API-SECRET-KEY': this.credentials.apiSecret,
    };
  }

  // ── Trading API (account + positions + orders) ──────────────────

  async getAccount<T = any>(): Promise<T> {
    const res = await this.trading.get<T>('/v2/account');
    return res.data;
  }

  async getAllPositions<T = any>(): Promise<T[]> {
    const res = await this.trading.get<T[]>('/v2/positions');
    return Array.isArray(res.data) ? res.data : [];
  }

  async getOptionsContract<T = any>(symbolOrId: string): Promise<T> {
    const res = await this.trading.get<T>(
      `/v2/options/contracts/${encodeURIComponent(symbolOrId)}`,
    );
    return res.data;
  }

  async listOptionsContracts<T = any>(params: {
    underlying_symbols?: string;
    expiration_date?: string;
    expiration_date_gte?: string;
    expiration_date_lte?: string;
    type?: 'call' | 'put';
    strike_price_gte?: string;
    strike_price_lte?: string;
    status?: 'active' | 'inactive';
    page_token?: string;
    limit?: number;
  }): Promise<T> {
    const res = await this.trading.get<T>('/v2/options/contracts', { params });
    return res.data;
  }

  // ── Market Data API (chain, greeks, quotes) ─────────────────────

  /**
   * Alpaca option chain endpoint. Returns an object keyed by OCC symbol whose
   * values include `latestTrade`, `latestQuote`, `greeks` and
   * `impliedVolatility` in a single round-trip.
   */
  async getOptionsChainSnapshot<T = any>(
    underlying: string,
    params: {
      feed?: 'opra' | 'indicative';
      limit?: number;
      type?: 'call' | 'put';
      strike_price_gte?: string;
      strike_price_lte?: string;
      expiration_date?: string;
      expiration_date_gte?: string;
      expiration_date_lte?: string;
      page_token?: string;
      updated_since?: string;
      root_symbol?: string;
    } = {},
    config: AxiosRequestConfig = {},
  ): Promise<T> {
    const res = await this.data.get<T>(
      `/v1beta1/options/snapshots/${encodeURIComponent(underlying)}`,
      {
        ...config,
        params: { feed: ALPACA_DEFAULT_FEED, ...params },
      },
    );
    return res.data;
  }

  /** Single-contract snapshot. Same endpoint as chain, but for one OCC symbol. */
  async getOptionSnapshot<T = any>(occSymbol: string): Promise<T> {
    const res = await this.data.get<T>('/v1beta1/options/snapshots', {
      params: { symbols: occSymbol, feed: ALPACA_DEFAULT_FEED },
    });
    return res.data;
  }

  /** Latest bid/ask for an OCC symbol. */
  async getOptionLatestQuote<T = any>(occSymbol: string): Promise<T> {
    const res = await this.data.get<T>('/v1beta1/options/quotes/latest', {
      params: { symbols: occSymbol, feed: ALPACA_DEFAULT_FEED },
    });
    return res.data;
  }

  // ── Order placement ──────────────────────────────────────────────

  /**
   * Place any `/v2/orders` payload. Callers build the body; we handle the
   * POST + auth headers + error pass-through. Alpaca's error body already
   * includes a human-readable `message`, so we surface it directly.
   */
  async createOrder<T = any>(body: Record<string, any>): Promise<T> {
    try {
      const res = await this.trading.post<T>('/v2/orders', body);
      return res.data;
    } catch (error: any) {
      const msg =
        error?.response?.data?.message ||
        error?.response?.data?.toString?.() ||
        error?.message ||
        'Alpaca order placement failed';
      const err: any = new Error(msg);
      err.status = error?.response?.status;
      err.alpacaBody = error?.response?.data;
      throw err;
    }
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.trading.delete(`/v2/orders/${encodeURIComponent(orderId)}`);
  }

  async getOrder<T = any>(orderId: string): Promise<T> {
    const res = await this.trading.get<T>(`/v2/orders/${encodeURIComponent(orderId)}`);
    return res.data;
  }

  async listOrders<T = any>(params: {
    status?: 'open' | 'closed' | 'all';
    limit?: number;
    after?: string;
    until?: string;
    direction?: 'asc' | 'desc';
    nested?: boolean;
    symbols?: string;
  }): Promise<T[]> {
    const res = await this.trading.get<T[]>('/v2/orders', { params });
    return Array.isArray(res.data) ? res.data : [];
  }

  async exercisePosition<T = any>(symbolOrId: string): Promise<T> {
    const res = await this.trading.post<T>(
      `/v2/positions/${encodeURIComponent(symbolOrId)}/exercise`,
    );
    return res.data;
  }
}
