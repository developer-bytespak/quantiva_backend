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
import { OptionsBinanceService } from './services/options-binance.service';
import { ExchangesService } from '../exchanges/exchanges.service';
import { WsAuthService } from '../../gateways/ws-auth.service';

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
    origin: ['http://quantiva-hq.vercel.app','https://www.bytes-test-5.com', 'https://quantiva-hq.vercel.app', 'http://localhost:3001'],
    credentials: true,
  },
})
export class OptionsGateway implements OnGatewayConnection, OnGatewayDisconnect {
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
    }
  >();

  private readonly TICKER_INTERVAL_MS = 5_000;
  private readonly CHAIN_INTERVAL_MS = 15_000;

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

    // Chain update at 15s interval
    const chainInterval = setInterval(async () => {
      await this.pushChainUpdate(underlying, credentials, userId);
    }, this.CHAIN_INTERVAL_MS);

    // Underlying spot price at 5s interval
    const tickerInterval = setInterval(async () => {
      await this.pushTickerUpdate(underlying, credentials, userId);
    }, this.TICKER_INTERVAL_MS);

    this.sharedIntervals.set(key, {
      chainInterval,
      tickerInterval,
      subscribers,
      credentials,
    });
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
      // Use eapi index endpoint for underlying price (public, reliable)
      const exchange = this.optionsBinance.getExchange(
        credentials,
        userId,
      );
      const indexData = await (exchange as any).eapiPublicGetIndex({
        underlying: `${underlying}USDT`,
      });

      this.server.to(`options:${underlying}`).emit('ticker-update', {
        underlying,
        price: parseFloat(indexData?.indexPrice || '0'),
        change24h: 0,
        changePercent24h: 0,
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
    if (shared) {
      shared.subscribers.delete(socketId);

      if (shared.subscribers.size === 0) {
        clearInterval(shared.chainInterval);
        clearInterval(shared.tickerInterval);
        this.sharedIntervals.delete(key);
        this.logger.debug(`Cleaned up shared options interval for ${key}`);
      }
    }
  }
}
