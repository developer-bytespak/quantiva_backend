import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import WebSocket from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { OPTIONS_STREAM_CONFIG } from '../options.config';

/**
 * Snapshot of a single option contract built from the @optionMarkPrice stream.
 * Field names mirror the frontend DTO so consumers can merge without extra mapping.
 */
export interface OptionMarkSnapshot {
  symbol: string;         // BTC-260626-150000-P
  markPrice: number;      // mp
  bidPrice: number;       // bo
  askPrice: number;       // ao
  bidQty: number;         // bq
  askQty: number;         // aq
  bidIV: number;          // b
  askIV: number;          // a
  markIV: number;         // vo (from the mark stream this is implied vol, not volume)
  delta: number;          // d
  theta: number;          // t
  gamma: number;          // g
  vega: number;           // v
  high24h: number;        // hl
  low24h: number;         // ll
  ts: number;             // event time we stored this at (ms)
}

export interface OptionIndexSnapshot {
  underlying: string;     // BTC
  indexPrice: number;     // i (from the same mark-price payload)
  ts: number;
}

/**
 * Persistent backend→Binance WebSocket for options market data.
 *
 * One connection streams mark/Greeks/bid-ask/IV/index for every contract of every
 * subscribed underlying. Keeps upstream Binance load O(underlyings), not O(users).
 *
 * Endpoint discovered via binance/binance-connector-python
 * (constant DERIVATIVES_TRADING_OPTIONS_WS_STREAMS_PROD_URL): wss://fstream.binance.com
 * Path pattern: /market/stream?streams=<s1>/<s2>/...
 */
@Injectable()
export class OptionsBinanceStreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OptionsBinanceStreamService.name);

  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private dailyCycleTimer: NodeJS.Timeout | null = null;
  private destroyed = false;

  // Per-underlying mark snapshots (lowercase -> Map<contractSymbol, snapshot>)
  private readonly marks = new Map<string, Map<string, OptionMarkSnapshot>>();
  // Per-underlying index price (uppercase key, e.g. 'BTC')
  private readonly indexes = new Map<string, OptionIndexSnapshot>();

  private readonly agent: HttpsProxyAgent | undefined;

  constructor() {
    const proxyUrl = process.env.BINANCE_PROXY_URL;
    this.agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
  }

  onModuleInit() {
    if (!OPTIONS_STREAM_CONFIG.ENABLED) {
      this.logger.warn('OPTIONS_WS_ENABLED=false — stream service is a no-op, REST fallback will handle all market data');
      return;
    }
    if (OPTIONS_STREAM_CONFIG.UNDERLYINGS.length === 0) {
      this.logger.warn('No underlyings configured for options WS; skipping connect');
      return;
    }
    this.connect();
  }

  async onModuleDestroy() {
    this.destroyed = true;
    this.clearTimers();
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  // ── Public read API ─────────────────────────────────────────────

  /** Index price for an underlying (e.g. 'BTC'). null if never received or stale. */
  getIndex(underlying: string): number | null {
    const snap = this.indexes.get(underlying.toUpperCase());
    if (!snap) return null;
    if (!this.isFresh(snap.ts)) return null;
    return snap.indexPrice;
  }

  /** Single contract snapshot by Binance symbol. null if unknown or stale. */
  getMark(contractSymbol: string): OptionMarkSnapshot | null {
    const underlying = contractSymbol.split('-')[0]?.toLowerCase();
    if (!underlying) return null;
    const map = this.marks.get(underlying);
    const snap = map?.get(contractSymbol);
    if (!snap) return null;
    if (!this.isFresh(snap.ts)) return null;
    return snap;
  }

  /** All contract snapshots for an underlying (e.g. 'BTC'). Empty map if none or all stale. */
  getMarksForUnderlying(underlying: string): Map<string, OptionMarkSnapshot> {
    const map = this.marks.get(underlying.toLowerCase());
    if (!map || map.size === 0) return new Map();
    // Return a filtered copy containing only fresh entries (avoid mutating the live store)
    const now = Date.now();
    const fresh = new Map<string, OptionMarkSnapshot>();
    for (const [k, v] of map.entries()) {
      if (now - v.ts < OPTIONS_STREAM_CONFIG.STALE_MS) fresh.set(k, v);
    }
    return fresh;
  }

  /** Is this service's WS connection currently open and streaming? */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // ── Connection lifecycle ────────────────────────────────────────

  private connect(): void {
    if (this.destroyed) return;
    this.clearTimers();

    const streams = OPTIONS_STREAM_CONFIG.UNDERLYINGS
      .map((u) => `${u.toLowerCase()}usdt@optionMarkPrice`)
      .join('/');
    const url = `${OPTIONS_STREAM_CONFIG.ENDPOINT}?streams=${streams}`;

    const via = this.agent ? ' via proxy' : ' direct';
    this.logger.log(`Connecting options WS${via}; ${OPTIONS_STREAM_CONFIG.UNDERLYINGS.length} underlying streams`);

    try {
      this.ws = new WebSocket(url, this.agent ? ({ agent: this.agent } as any) : undefined);
    } catch (err: any) {
      this.logger.error(`WS construction failed: ${err.message}`);
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => this.onOpen());
    this.ws.on('message', (buf) => this.onMessage(buf));
    this.ws.on('error', (err) => this.onError(err));
    this.ws.on('close', (code, reason) => this.onClose(code, reason?.toString?.() || ''));
    this.ws.on('ping', () => { try { this.ws?.pong(); } catch { /* ignore */ } });
  }

  private onOpen(): void {
    this.reconnectAttempts = 0;
    this.logger.log('Options WS connected');
    // Pre-empt the 24-hour forced disconnect
    this.dailyCycleTimer = setTimeout(() => {
      this.logger.log('Daily cycle: reconnecting to refresh WS session');
      this.reconnect();
    }, OPTIONS_STREAM_CONFIG.DAILY_CYCLE_MS);
  }

  private onMessage(buf: WebSocket.RawData): void {
    let msg: any;
    try {
      msg = JSON.parse(buf.toString());
    } catch (err: any) {
      this.logger.warn(`Invalid JSON from WS: ${err.message}`);
      return;
    }

    const stream: string | undefined = msg?.stream;
    const data = msg?.data;
    if (!stream || !data) return;

    // btcusdt@optionMarkPrice -> underlying key = 'btc'
    const streamParts = stream.split('@');
    const streamTopic = streamParts[1];
    if (streamTopic !== 'optionMarkPrice') return;

    const underlyingLc = streamParts[0].replace(/usdt$/, '');
    const underlyingUc = underlyingLc.toUpperCase();

    const arr = Array.isArray(data) ? data : [data];
    if (arr.length === 0) return;

    let marksMap = this.marks.get(underlyingLc);
    if (!marksMap) {
      marksMap = new Map();
      this.marks.set(underlyingLc, marksMap);
    }

    const now = Date.now();

    // The 'i' (index) field is present on every entry — use the last one for index
    let lastIndex = 0;

    for (const item of arr) {
      const symbol: string = item.s;
      if (!symbol) continue;

      const idx = parseFloat(item.i || '0');
      if (isFinite(idx) && idx > 0) lastIndex = idx;

      marksMap.set(symbol, {
        symbol,
        markPrice: parseFloat(item.mp || '0'),
        bidPrice: parseFloat(item.bo || '0'),
        askPrice: parseFloat(item.ao || '0'),
        bidQty: parseFloat(item.bq || '0'),
        askQty: parseFloat(item.aq || '0'),
        bidIV: parseFloat(item.b || '0'),
        askIV: parseFloat(item.a || '0'),
        markIV: parseFloat(item.vo || '0'),
        delta: parseFloat(item.d || '0'),
        theta: parseFloat(item.t || '0'),
        gamma: parseFloat(item.g || '0'),
        vega: parseFloat(item.v || '0'),
        high24h: parseFloat(item.hl || '0'),
        low24h: parseFloat(item.ll || '0'),
        ts: now,
      });
    }

    if (lastIndex > 0) {
      this.indexes.set(underlyingUc, { underlying: underlyingUc, indexPrice: lastIndex, ts: now });
    }
  }

  private onError(err: Error): void {
    this.logger.warn(`Options WS error: ${err.message}`);
    // onClose will follow and drive the reconnect
  }

  private onClose(code: number, reason: string): void {
    if (this.destroyed) return;
    this.logger.warn(`Options WS closed (code=${code} reason="${reason}")`);
    this.ws = null;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    this.clearTimers();
    this.reconnectAttempts += 1;
    const delay = Math.min(
      OPTIONS_STREAM_CONFIG.RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1),
      OPTIONS_STREAM_CONFIG.RECONNECT_MAX_DELAY_MS,
    );
    this.logger.log(`Options WS reconnect attempt ${this.reconnectAttempts} in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private reconnect(): void {
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.connect();
  }

  private clearTimers(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.dailyCycleTimer) { clearTimeout(this.dailyCycleTimer); this.dailyCycleTimer = null; }
  }

  private isFresh(ts: number): boolean {
    return Date.now() - ts < OPTIONS_STREAM_CONFIG.STALE_MS;
  }
}
