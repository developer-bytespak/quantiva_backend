import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import WebSocket from 'ws';
import { EventEmitter } from 'events';

/**
 * Cached ticker data sourced from the Binance !miniTicker@arr WebSocket stream.
 */
export interface StreamTickerData {
  symbol: string;
  /** Last (close) price */
  price: number;
  /** 24h open price */
  open: number;
  /** 24h high */
  high: number;
  /** 24h low */
  low: number;
  /** 24h base-asset volume */
  volume: number;
  /** 24h quote-asset volume */
  quoteVolume: number;
  /** Calculated: ((close - open) / open) * 100 */
  priceChangePercent: number;
  /** Unix-ms of last WS update */
  updatedAt: number;
}

/**
 * Cached kline (candlestick) data sourced from <symbol>@kline_<interval> streams.
 */
export interface StreamKlineData {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  isClosed: boolean;
}

/**
 * Maintains a persistent WebSocket connection to Binance market-data streams
 * and caches the latest ticker / kline data in memory.
 *
 * All consumers read from the in-memory Maps → zero Binance REST weight.
 *
 * Connections:
 *   1. `!miniTicker@arr` — all-symbols 24h mini-ticker, pushed every ~1 s.
 *   2. Combined kline stream — dynamic subscribe/unsubscribe per symbol+interval.
 *
 * Events emitted (for downstream like gateways):
 *   - 'ticker'  → (symbol: string, data: StreamTickerData)
 *   - 'kline'   → (symbol: string, interval: string, data: StreamKlineData)
 */
@Injectable()
export class BinanceMarketStreamService extends EventEmitter implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BinanceMarketStreamService.name);

  // ── Configuration ────────────────────────────────────────
  private readonly WS_BASE = 'wss://stream.binance.com:9443';
  private readonly MAX_RECONNECT_DELAY_MS = 30_000;
  private readonly RECONNECT_24H_MS = 23 * 60 * 60 * 1000; // reconnect 1 h before Binance's 24 h cutoff

  // ── Ticker stream state ──────────────────────────────────
  private tickerWs: WebSocket | null = null;
  private tickerReconnectAttempts = 0;
  private tickerReconnectTimer: NodeJS.Timeout | null = null;
  private ticker24hTimer: NodeJS.Timeout | null = null;
  private readonly tickers = new Map<string, StreamTickerData>();
  private tickerFirstDataLogged = false;

  // ── Kline stream state ───────────────────────────────────
  private klineWs: WebSocket | null = null;
  private klineReconnectAttempts = 0;
  private klineReconnectTimer: NodeJS.Timeout | null = null;
  private readonly klineSubscriptions = new Set<string>(); // "btcusdt@kline_1m"
  private readonly klines = new Map<string, StreamKlineData>(); // "BTCUSDT:1m" → data

  // ── Lifecycle ────────────────────────────────────────────

  async onModuleInit(): Promise<void> {
    this.logger.log('Starting Binance market-data WebSocket streams…');
    this.connectTickerStream();
    this.connectKlineStream();
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log('Shutting down Binance market-data WebSocket streams…');
    this.closeTickerStream();
    this.closeKlineStream();
  }

  // ════════════════════════════════════════════════════════
  //  PUBLIC API — consumed by BinanceService & gateways
  // ════════════════════════════════════════════════════════

  /** Whether the ticker stream is live and has data. */
  isConnected(): boolean {
    return this.tickerWs?.readyState === WebSocket.OPEN && this.tickers.size > 0;
  }

  /** Get cached price for a single symbol (e.g. "BTCUSDT"). Returns `undefined` if unknown. */
  getPrice(symbol: string): number | undefined {
    return this.tickers.get(symbol.toUpperCase())?.price;
  }

  /** Get full 24h stats from stream cache. Returns `undefined` if not available. */
  get24hStats(symbol: string): StreamTickerData | undefined {
    return this.tickers.get(symbol.toUpperCase());
  }

  /** Get all cached prices as a Map<symbol, price>. */
  getAllPrices(): Map<string, number> {
    const map = new Map<string, number>();
    for (const [sym, data] of this.tickers) {
      map.set(sym, data.price);
    }
    return map;
  }

  /** Get cached kline for symbol + interval (e.g. "BTCUSDT", "1m"). */
  getKline(symbol: string, interval: string): StreamKlineData | undefined {
    return this.klines.get(`${symbol.toUpperCase()}:${interval}`);
  }

  /**
   * Subscribe to a kline stream so we receive real-time candle updates.
   * Safe to call multiple times — duplicates are ignored.
   */
  subscribeKline(symbol: string, interval: string): void {
    const stream = `${symbol.toLowerCase()}@kline_${interval}`;
    if (this.klineSubscriptions.has(stream)) return;
    if (this.klineSubscriptions.size >= 1024) {
      this.logger.warn('Kline subscription limit (1024) reached — ignoring');
      return;
    }
    this.klineSubscriptions.add(stream);
    this.sendKlineSubscribe([stream]);
  }

  /**
   * Unsubscribe from a kline stream when no more clients need it.
   */
  unsubscribeKline(symbol: string, interval: string): void {
    const stream = `${symbol.toLowerCase()}@kline_${interval}`;
    if (!this.klineSubscriptions.has(stream)) return;
    this.klineSubscriptions.delete(stream);
    this.klines.delete(`${symbol.toUpperCase()}:${interval}`);
    this.sendKlineUnsubscribe([stream]);
  }

  // ════════════════════════════════════════════════════════
  //  TICKER STREAM — !miniTicker@arr
  // ════════════════════════════════════════════════════════

  private connectTickerStream(): void {
    this.closeTickerStream();

    const url = `${this.WS_BASE}/ws/!miniTicker@arr`;
    this.logger.log(`Connecting to ticker stream: ${url}`);

    const ws = new WebSocket(url);
    this.tickerWs = ws;

    ws.on('open', () => {
      this.logger.log('══ TICKER STREAM CONNECTED ══');
      this.tickerReconnectAttempts = 0;
      this.tickerFirstDataLogged = false;

      // Schedule proactive reconnect before Binance's 24 h limit
      this.ticker24hTimer = setTimeout(() => {
        this.logger.log('Proactive 24 h ticker reconnect');
        this.connectTickerStream();
      }, this.RECONNECT_24H_MS);
    });

    ws.on('message', (raw: WebSocket.Data) => {
      try {
        const arr = JSON.parse(raw.toString());
        if (!Array.isArray(arr)) return;
        const now = Date.now();
        for (const t of arr) {
          const symbol: string = t.s;
          const close = parseFloat(t.c);
          const open = parseFloat(t.o);
          const data: StreamTickerData = {
            symbol,
            price: close,
            open,
            high: parseFloat(t.h),
            low: parseFloat(t.l),
            volume: parseFloat(t.v),
            quoteVolume: parseFloat(t.q),
            priceChangePercent: open !== 0 ? ((close - open) / open) * 100 : 0,
            updatedAt: now,
          };
          this.tickers.set(symbol, data);
        }
        // Log summary on first batch so Render logs confirm data is flowing
        if (!this.tickerFirstDataLogged) {
          this.tickerFirstDataLogged = true;
          const btc = this.tickers.get('BTCUSDT')?.price;
          const eth = this.tickers.get('ETHUSDT')?.price;
          const bnb = this.tickers.get('BNBUSDT')?.price;
          this.logger.log(
            `══ STREAM DATA FLOWING ══ ${this.tickers.size} symbols cached | ` +
            `BTC=$${btc?.toFixed(2) ?? '?'} ETH=$${eth?.toFixed(2) ?? '?'} BNB=$${bnb?.toFixed(2) ?? '?'}`,
          );
        }
        // Emit a batch event so listeners can push selectively
        this.emit('ticker-batch', now);
      } catch (e: any) {
        this.logger.warn(`Ticker parse error: ${e.message}`);
      }
    });

    ws.on('ping', (data) => ws.pong(data));

    ws.on('error', (err) => {
      this.logger.error(`Ticker stream error: ${err.message}`);
    });

    ws.on('close', (code, reason) => {
      this.logger.warn(`══ TICKER STREAM CLOSED ══ code=${code} reason=${reason} | had ${this.tickers.size} symbols cached`);
      this.scheduleTickerReconnect();
    });
  }

  private closeTickerStream(): void {
    if (this.ticker24hTimer) { clearTimeout(this.ticker24hTimer); this.ticker24hTimer = null; }
    if (this.tickerReconnectTimer) { clearTimeout(this.tickerReconnectTimer); this.tickerReconnectTimer = null; }
    if (this.tickerWs) {
      this.tickerWs.removeAllListeners();
      if (this.tickerWs.readyState === WebSocket.OPEN || this.tickerWs.readyState === WebSocket.CONNECTING) {
        this.tickerWs.close();
      }
      this.tickerWs = null;
    }
  }

  private scheduleTickerReconnect(): void {
    const delay = Math.min(1000 * Math.pow(2, this.tickerReconnectAttempts), this.MAX_RECONNECT_DELAY_MS);
    this.tickerReconnectAttempts++;
    this.logger.log(`══ TICKER RECONNECT ══ in ${delay}ms (attempt ${this.tickerReconnectAttempts})`);
    this.tickerReconnectTimer = setTimeout(() => this.connectTickerStream(), delay);
  }

  // ════════════════════════════════════════════════════════
  //  KLINE (COMBINED) STREAM
  // ════════════════════════════════════════════════════════

  private connectKlineStream(): void {
    this.closeKlineStream();

    // Open a plain combined stream connection — subscriptions are sent after open
    const url = `${this.WS_BASE}/stream`;
    this.logger.log(`Connecting kline combined stream: ${url}`);

    const ws = new WebSocket(url);
    this.klineWs = ws;

    ws.on('open', () => {
      this.logger.log('══ KLINE STREAM CONNECTED ══');
      this.klineReconnectAttempts = 0;

      // Re-subscribe to all active kline streams
      if (this.klineSubscriptions.size > 0) {
        this.sendKlineSubscribe([...this.klineSubscriptions]);
      }
    });

    ws.on('message', (raw: WebSocket.Data) => {
      try {
        const msg = JSON.parse(raw.toString());
        // Combined stream wraps: { stream: "btcusdt@kline_1m", data: { ... } }
        if (!msg.stream || !msg.data) return;
        const kEvent = msg.data;
        if (kEvent.e !== 'kline') return;

        const k = kEvent.k;
        const symbol: string = kEvent.s; // "BTCUSDT"
        const interval: string = k.i;     // "1m"
        const kline: StreamKlineData = {
          openTime: k.t,
          open: parseFloat(k.o),
          high: parseFloat(k.h),
          low: parseFloat(k.l),
          close: parseFloat(k.c),
          volume: parseFloat(k.v),
          closeTime: k.T,
          isClosed: k.x,
        };

        this.klines.set(`${symbol}:${interval}`, kline);
        this.emit('kline', symbol, interval, kline);
      } catch (e: any) {
        this.logger.warn(`Kline parse error: ${e.message}`);
      }
    });

    ws.on('ping', (data) => ws.pong(data));

    ws.on('error', (err) => {
      this.logger.error(`Kline stream error: ${err.message}`);
    });

    ws.on('close', (code, reason) => {
      this.logger.warn(`══ KLINE STREAM CLOSED ══ code=${code} reason=${reason} | ${this.klineSubscriptions.size} active subscriptions`);
      this.scheduleKlineReconnect();
    });
  }

  private closeKlineStream(): void {
    if (this.klineReconnectTimer) { clearTimeout(this.klineReconnectTimer); this.klineReconnectTimer = null; }
    if (this.klineWs) {
      this.klineWs.removeAllListeners();
      if (this.klineWs.readyState === WebSocket.OPEN || this.klineWs.readyState === WebSocket.CONNECTING) {
        this.klineWs.close();
      }
      this.klineWs = null;
    }
  }

  private scheduleKlineReconnect(): void {
    const delay = Math.min(1000 * Math.pow(2, this.klineReconnectAttempts), this.MAX_RECONNECT_DELAY_MS);
    this.klineReconnectAttempts++;
    this.logger.log(`Reconnecting kline stream in ${delay}ms (attempt ${this.klineReconnectAttempts})`);
    this.klineReconnectTimer = setTimeout(() => this.connectKlineStream(), delay);
  }

  /** Send SUBSCRIBE command to the kline combined stream. */
  private sendKlineSubscribe(streams: string[]): void {
    if (!this.klineWs || this.klineWs.readyState !== WebSocket.OPEN || streams.length === 0) return;
    this.klineWs.send(JSON.stringify({ method: 'SUBSCRIBE', params: streams, id: Date.now() }));
    this.logger.debug(`Subscribed kline streams: ${streams.join(', ')}`);
  }

  /** Send UNSUBSCRIBE command to the kline combined stream. */
  private sendKlineUnsubscribe(streams: string[]): void {
    if (!this.klineWs || this.klineWs.readyState !== WebSocket.OPEN || streams.length === 0) return;
    this.klineWs.send(JSON.stringify({ method: 'UNSUBSCRIBE', params: streams, id: Date.now() }));
    this.logger.debug(`Unsubscribed kline streams: ${streams.join(', ')}`);
  }
}
