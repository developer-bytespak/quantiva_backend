import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { BinanceService } from '../modules/exchanges/integrations/binance.service';
import { BybitService } from '../modules/exchanges/integrations/bybit.service';
import { ExchangesService } from '../modules/exchanges/exchanges.service';
import { CacheService } from '../modules/exchanges/services/cache.service';
import { CacheKeyManager } from '../modules/exchanges/services/cache-key-manager';
import { BinanceMarketStreamService } from '../modules/binance/binance-market-stream.service';

interface Subscription {
  connectionId: string;
  symbol: string;
  exchangeName: string;
  interval?: NodeJS.Timeout;
}

/**
 * WebSocket gateway for real-time market detail page updates.
 *
 * Clients subscribe to a symbol via:
 *   socket.emit('subscribe', { connectionId, symbol })
 *
 * Server pushes:
 *   - 'ticker-update'   every ~5 seconds
 *   - 'candle-update'   every ~30 seconds
 *
 * Clients unsubscribe via:
 *   socket.emit('unsubscribe', { symbol })
 *
 * Automatically cleans up on disconnect.
 */
@WebSocketGateway({
  namespace: 'market-detail',
  cors: {
    origin: '*', // In production, restrict this
    credentials: true,
  },
})
export class MarketDetailGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(MarketDetailGateway.name);

  // socket.id → active subscriptions
  private readonly subscriptions = new Map<string, Subscription>();

  // Shared ticker intervals per symbol (multiple sockets, one interval)
  private readonly sharedTickerIntervals = new Map<string, {
    interval: NodeJS.Timeout;
    subscribers: Set<string>; // socket IDs
  }>();

  private readonly TICKER_INTERVAL_MS = 5_000;   // 5 seconds
  private readonly CANDLE_INTERVAL_MS = 30_000;   // 30 seconds

  constructor(
    private readonly binanceService: BinanceService,
    private readonly bybitService: BybitService,
    private readonly exchangesService: ExchangesService,
    private readonly cacheService: CacheService,
    private readonly marketStream: BinanceMarketStreamService,
  ) {}

  // ── Lifecycle ────────────────────────────────────────────

  async handleConnection(client: Socket): Promise<void> {
    this.logger.log(`Market-detail client connected: ${client.id}`);
  }

  async handleDisconnect(client: Socket): Promise<void> {
    this.logger.log(`Market-detail client disconnected: ${client.id}`);
    this.cleanupClient(client.id);
  }

  // ── Subscribe ────────────────────────────────────────────

  @SubscribeMessage('subscribe')
  async handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { connectionId: string; symbol: string },
  ): Promise<void> {
    const { connectionId, symbol } = data;

    if (!connectionId || !symbol) {
      client.emit('error', { message: 'connectionId and symbol are required' });
      return;
    }

    // Clean up any existing subscription for this client
    this.cleanupClient(client.id);

    try {
      // Determine exchange for this connection
      const connection = await this.exchangesService.getConnectionById(connectionId);
      if (!connection?.exchange) {
        client.emit('error', { message: 'Connection not found' });
        return;
      }

      const exchangeName = connection.exchange.name.toLowerCase();

      // Register subscription
      this.subscriptions.set(client.id, {
        connectionId,
        symbol,
        exchangeName,
      });

      // Join a socket.io room for this symbol
      const room = `market:${symbol}`;
      client.join(room);

      // Subscribe to kline stream for Binance (zero weight candle updates)
      if (exchangeName === 'binance') {
        this.marketStream.subscribeKline(symbol, '1m');
      }

      // Setup shared ticker push for this symbol
      this.setupSharedTicker(symbol, exchangeName, client.id);

      // Send initial ticker immediately
      await this.pushTickerUpdate(symbol, exchangeName);

      this.logger.log(
        `Client ${client.id} subscribed to ${symbol} on ${exchangeName}`,
      );
      client.emit('subscribed', { symbol, exchange: exchangeName });
    } catch (error: any) {
      this.logger.error(`Subscribe error: ${error.message}`);
      client.emit('error', { message: error.message });
    }
  }

  // ── Unsubscribe ──────────────────────────────────────────

  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { symbol: string },
  ): void {
    this.cleanupClient(client.id);
    client.emit('unsubscribed', { symbol: data?.symbol });
  }

  // ── Internal ─────────────────────────────────────────────

  /**
   * Setup or join a shared ticker interval for a symbol.
   * Multiple clients watching the same symbol share one interval.
   */
  private setupSharedTicker(
    symbol: string,
    exchangeName: string,
    socketId: string,
  ): void {
    const key = `${exchangeName}:${symbol}`;
    const existing = this.sharedTickerIntervals.get(key);

    if (existing) {
      // Just add this socket to subscribers
      existing.subscribers.add(socketId);
      return;
    }

    // Create new shared interval
    const subscribers = new Set<string>([socketId]);

    const interval = setInterval(async () => {
      await this.pushTickerUpdate(symbol, exchangeName);
    }, this.TICKER_INTERVAL_MS);

    // Also push candle updates at a slower rate
    const candleInterval = setInterval(async () => {
      await this.pushCandleUpdate(symbol, exchangeName);
    }, this.CANDLE_INTERVAL_MS);

    this.sharedTickerIntervals.set(key, {
      interval,
      subscribers,
    });

    // Store candle interval reference for cleanup
    (this.sharedTickerIntervals.get(key) as any)._candleInterval = candleInterval;
  }

  /**
   * Push ticker update to all clients in the symbol room
   */
  private async pushTickerUpdate(
    symbol: string,
    exchangeName: string,
  ): Promise<void> {
    try {
      let ticker;

      if (exchangeName === 'bybit') {
        const tickers = await this.bybitService.getTickerPrices([symbol]);
        ticker = tickers[0] || null;
      } else if (this.marketStream.isConnected()) {
        // Stream-first for Binance — zero REST weight
        const stream = this.marketStream.get24hStats(symbol.toUpperCase().replace(/USDT$/i, '') + 'USDT');
        if (stream) {
          ticker = {
            price: stream.price,
            change24h: stream.price - stream.open,
            changePercent24h: stream.priceChangePercent,
          };
        }
      }

      // Fallback to REST if stream didn't provide data
      if (!ticker && exchangeName !== 'bybit') {
        const tickers = await this.binanceService.getTickerPrices([symbol]);
        ticker = tickers[0] || null;
      }

      if (ticker) {
        this.server.to(`market:${symbol}`).emit('ticker-update', {
          symbol,
          price: ticker.price,
          change24h: ticker.change24h,
          changePercent24h: ticker.changePercent24h,
          timestamp: Date.now(),
        });
      }
    } catch (error: any) {
      this.logger.warn(`Ticker push error for ${symbol}: ${error.message}`);
    }
  }

  /**
   * Push latest candle update to all clients in the symbol room
   */
  private async pushCandleUpdate(
    symbol: string,
    exchangeName: string,
  ): Promise<void> {
    try {
      if (exchangeName === 'bybit') {
        const candles = await this.bybitService.getCandlestickData(symbol, '1m', 5);
        if (candles && candles.length > 0) {
          this.server.to(`market:${symbol}`).emit('candle-update', {
            symbol,
            interval: '1m',
            candles: candles.slice(-5),
            timestamp: Date.now(),
          });
        }
        return;
      }

      // Binance: try stream cache first (zero weight)
      const formatted = symbol.toUpperCase().replace(/USDT$/i, '') + 'USDT';
      const streamKline = this.marketStream.getKline(formatted, '1m');
      if (streamKline) {
        this.server.to(`market:${symbol}`).emit('candle-update', {
          symbol,
          interval: '1m',
          candles: [{
            openTime: streamKline.openTime,
            open: streamKline.open,
            high: streamKline.high,
            low: streamKline.low,
            close: streamKline.close,
            volume: streamKline.volume,
            closeTime: streamKline.closeTime,
          }],
          timestamp: Date.now(),
        });
        return;
      }

      // Fallback to REST
      const candles = await this.binanceService.getCandlestickData(symbol, '1m', 5);
      if (candles && candles.length > 0) {
        this.server.to(`market:${symbol}`).emit('candle-update', {
          symbol,
          interval: '1m',
          candles: candles.slice(-5),
          timestamp: Date.now(),
        });
      }
    } catch (error: any) {
      this.logger.warn(`Candle push error for ${symbol}: ${error.message}`);
    }
  }

  /**
   * Clean up all subscriptions for a disconnecting client
   */
  private cleanupClient(socketId: string): void {
    const sub = this.subscriptions.get(socketId);
    if (!sub) return;

    this.subscriptions.delete(socketId);

    // Remove from shared interval subscriber list
    const key = `${sub.exchangeName}:${sub.symbol}`;
    const shared = this.sharedTickerIntervals.get(key);
    if (shared) {
      shared.subscribers.delete(socketId);

      // If no more subscribers, tear down the interval
      if (shared.subscribers.size === 0) {
        clearInterval(shared.interval);
        if ((shared as any)._candleInterval) {
          clearInterval((shared as any)._candleInterval);
        }
        this.sharedTickerIntervals.delete(key);

        // Unsubscribe kline stream for Binance when no subscribers left
        if (sub.exchangeName === 'binance') {
          this.marketStream.unsubscribeKline(sub.symbol, '1m');
        }

        this.logger.debug(`Cleaned up shared interval for ${key}`);
      }
    }
  }
}
