import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Logger, OnModuleDestroy } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { OptionsBinanceService } from './services/options-binance.service';
import { ExchangesService } from '../exchanges/exchanges.service';
import { WsAuthService } from '../../gateways/ws-auth.service';
import { OPTIONS_POLLING_CONFIG } from './options.config';

interface OptionsSubscription {
  connectionId: string;
  underlying: string;
  userId: string;
}

/**
 * WebSocket gateway for real-time options data streaming.
 *
 * Clients subscribe via:
 *   socket.emit('subscribe', { connectionId, underlying })
 *
 * Server pushes:
 *   - 'chain-update'   every ~15 seconds   (full options chain for underlying)
 *   - 'ticker-update'  every ~5 seconds    (underlying spot price)
 *
 * Clients unsubscribe via:
 *   socket.emit('unsubscribe', { underlying })
 */
@WebSocketGateway({
  namespace: 'options',
  cors: {
    // TODO: Update origin when hosted on AWS — replace Vercel URL with AWS domain
    origin: ['http://quantiva-hq.vercel.app','https://bytes-test-5.com', 'https://quantiva-hq.vercel.app', 'http://localhost:3001'],
    credentials: true,
  },
})
export class OptionsGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(OptionsGateway.name);

  // socket.id → subscription info
  private readonly subscriptions = new Map<string, OptionsSubscription>();

  // Shared intervals per underlying (multiple clients share one poller)
  private readonly sharedIntervals = new Map<
    string,
    {
      chainInterval: NodeJS.Timeout;
      tickerInterval: NodeJS.Timeout;
      subscribers: Set<string>; // socket IDs
      credentials: { apiKey: string; apiSecret: string };
      userId: string;
    }
  >();

  private readonly TICKER_INTERVAL_MS = OPTIONS_POLLING_CONFIG.TICKER_INTERVAL_MS;
  private readonly CHAIN_INTERVAL_MS = OPTIONS_POLLING_CONFIG.CHAIN_INTERVAL_MS;

  constructor(
    private readonly optionsBinance: OptionsBinanceService,
    private readonly exchangesService: ExchangesService,
    private readonly wsAuthService: WsAuthService,
  ) {}

  // ── Lifecycle ────────────────────────────────────────────

  handleConnection(client: Socket): void {
    // Verify JWT token
    const authResult = this.wsAuthService.verifyConnection(client);
    if (!authResult.authenticated) {
      this.logger.warn(`Unauthorized options connection: ${client.id} — ${authResult.error}`);
      client.emit('error', { code: 'UNAUTHORIZED', message: authResult.error || 'Authentication required' });
      client.disconnect();
      return;
    }
    client.data.userId = authResult.userId;
    this.logger.log(`Options client connected: ${client.id}, userId: ${authResult.userId}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`Options client disconnected: ${client.id}`);
    this.cleanupClient(client.id);
  }

  // ── Subscribe ────────────────────────────────────────────

  @SubscribeMessage('subscribe')
  async handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: { connectionId: string; underlying: string },
  ): Promise<void> {
    const { connectionId, underlying } = data;

    if (!connectionId || !underlying) {
      client.emit('error', {
        message: 'connectionId and underlying are required',
      });
      return;
    }

    // Clean previous subscription for this client
    this.cleanupClient(client.id);

    try {
      // Verify connection and derive userId from DB (not from client)
      const connection =
        await this.exchangesService.getConnectionById(connectionId);
      if (!connection) {
        client.emit('error', { message: 'Invalid connection' });
        return;
      }

      const userId = connection.user_id;

      const credentials =
        await this.exchangesService.getDecryptedCredentials(connectionId);

      // Register subscription
      this.subscriptions.set(client.id, {
        connectionId,
        underlying: underlying.toUpperCase(),
        userId,
      });

      // Join room
      const room = `options:${underlying.toUpperCase()}`;
      client.join(room);

      // Setup shared polling
      this.setupSharedPolling(
        underlying.toUpperCase(),
        credentials,
        client.id,
        userId,
      );

      // Send initial data immediately
      await this.pushChainUpdate(
        underlying.toUpperCase(),
        credentials,
        userId,
      );

      client.emit('subscribed', { underlying: underlying.toUpperCase() });
      this.logger.log(
        `Client ${client.id} subscribed to options:${underlying.toUpperCase()}`,
      );
    } catch (error: any) {
      this.logger.error(`Options subscribe error: ${error.message}`);
      client.emit('error', { message: error.message });
    }
  }

  // ── Unsubscribe ──────────────────────────────────────────

  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { underlying: string },
  ): void {
    this.cleanupClient(client.id);
    client.emit('unsubscribed', { underlying: data?.underlying });
  }

  // ── Internal polling ─────────────────────────────────────

  private setupSharedPolling(
    underlying: string,
    credentials: { apiKey: string; apiSecret: string },
    socketId: string,
    userId: string,
  ): void {
    const key = underlying;
    const existing = this.sharedIntervals.get(key);

    if (existing) {
      existing.subscribers.add(socketId);
      return;
    }

    const subscribers = new Set<string>([socketId]);

    // Store shared state first so intervals can reference the latest credentials
    const shared = {
      chainInterval: null as unknown as NodeJS.Timeout,
      tickerInterval: null as unknown as NodeJS.Timeout,
      subscribers,
      credentials,
      userId,
    };
    this.sharedIntervals.set(key, shared);

    // Chain update at 15s interval — reads from shared.credentials (rotated on disconnect)
    shared.chainInterval = setInterval(async () => {
      await this.pushChainUpdate(underlying, shared.credentials, shared.userId);
    }, this.CHAIN_INTERVAL_MS);

    // Underlying spot price at 5s interval
    shared.tickerInterval = setInterval(async () => {
      await this.pushTickerUpdate(underlying, shared.credentials, shared.userId);
    }, this.TICKER_INTERVAL_MS);
  }

  private async pushChainUpdate(
    underlying: string,
    credentials: { apiKey: string; apiSecret: string },
    userId: string,
  ): Promise<void> {
    try {
      const chain = await this.optionsBinance.fetchOptionsChain(
        credentials,
        underlying,
        userId,
      );

      this.server.to(`options:${underlying}`).emit('chain-update', {
        underlying,
        chain,
        timestamp: Date.now(),
      });
    } catch (error: any) {
      this.logger.warn(
        `Options chain push error for ${underlying}: ${error.message}`,
      );
    }
  }

  private async pushTickerUpdate(
    underlying: string,
    credentials: { apiKey: string; apiSecret: string },
    userId: string,
  ): Promise<void> {
    try {
      const exchange = this.optionsBinance.getExchange(
        credentials,
        userId,
      );

      // Fetch index price and 24h spot ticker in parallel
      const [indexResult, tickerResult] = await Promise.allSettled([
        (exchange as any).eapiPublicGetIndex({ underlying: `${underlying}USDT` }),
        (exchange as any).publicGetTicker24hr({ symbol: `${underlying}USDT` }),
      ]);

      const price = indexResult.status === 'fulfilled'
        ? parseFloat(indexResult.value?.indexPrice || '0')
        : 0;
      const change24h = tickerResult.status === 'fulfilled'
        ? parseFloat(tickerResult.value?.priceChange || '0')
        : 0;
      const changePercent24h = tickerResult.status === 'fulfilled'
        ? parseFloat(tickerResult.value?.priceChangePercent || '0')
        : 0;

      this.server.to(`options:${underlying}`).emit('ticker-update', {
        underlying,
        price,
        change24h,
        changePercent24h,
        timestamp: Date.now(),
      });
    } catch (error: any) {
      this.logger.warn(
        `Options ticker push error for ${underlying}: ${error.message}`,
      );
    }
  }

  // ── Cleanup ──────────────────────────────────────────────

  private cleanupClient(socketId: string): void {
    const sub = this.subscriptions.get(socketId);
    if (!sub) return;

    this.subscriptions.delete(socketId);

    const key = sub.underlying;
    const shared = this.sharedIntervals.get(key);
    if (!shared) return;

    shared.subscribers.delete(socketId);

    if (shared.subscribers.size === 0) {
      // No subscribers left — tear down intervals
      clearInterval(shared.chainInterval);
      clearInterval(shared.tickerInterval);
      this.sharedIntervals.delete(key);
      this.logger.debug(`Cleaned up shared options interval for ${key}`);
    } else {
      // Rotate credentials to the next active subscriber to prevent stale creds
      const nextSocketId = shared.subscribers.values().next().value;
      const nextSub = this.subscriptions.get(nextSocketId);
      if (nextSub) {
        this.exchangesService
          .getDecryptedCredentials(nextSub.connectionId)
          .then((creds) => {
            shared.credentials = creds;
            shared.userId = nextSub.userId;
            this.logger.debug(
              `Rotated options credentials for ${key} to client ${nextSocketId}`,
            );
          })
          .catch((err) =>
            this.logger.warn(`Credential rotation failed for ${key}: ${err.message}`),
          );
      }
    }
  }

  // ── Module destroy — clean up all intervals on shutdown ──

  onModuleDestroy(): void {
    for (const [key, shared] of this.sharedIntervals) {
      clearInterval(shared.chainInterval);
      clearInterval(shared.tickerInterval);
      this.logger.debug(`Shutdown: cleared options intervals for ${key}`);
    }
    this.sharedIntervals.clear();
    this.subscriptions.clear();
  }
}
