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
import { OptionsAlpacaService } from './services/options-alpaca.service';
import { OptionCredentials } from './services/options-venue.interface';
import { ExchangesService } from '../exchanges/exchanges.service';
import { WsAuthService } from '../../gateways/ws-auth.service';
import { OPTIONS_POLLING_CONFIG } from './options.config';

type SubscriptionVenue = 'BINANCE' | 'ALPACA';

interface OptionsSubscription {
  connectionId: string;
  underlying: string;
  userId: string;
  venue: SubscriptionVenue;
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

  // Shared intervals per (venue, underlying) pair — multiple subscribers to
  // the same venue-underlying tuple share one poller. Keyed as
  // `${venue}:${underlying}` so ALPACA:AAPL and BINANCE:BTC never collide.
  private readonly sharedIntervals = new Map<
    string,
    {
      venue: SubscriptionVenue;
      underlying: string;
      chainInterval: NodeJS.Timeout;
      tickerInterval: NodeJS.Timeout;
      subscribers: Set<string>; // socket IDs
      // Alpaca only: credentials from the first subscriber, used to poll the
      // credentialed data endpoints. Options chain data is market-wide so
      // it's safe to share the response across subscribers regardless of
      // whose creds fetched it. Null for Binance (public endpoints).
      credentials: OptionCredentials | null;
    }
  >();

  private readonly TICKER_INTERVAL_MS = OPTIONS_POLLING_CONFIG.TICKER_INTERVAL_MS;
  private readonly CHAIN_INTERVAL_MS = OPTIONS_POLLING_CONFIG.CHAIN_INTERVAL_MS;

  constructor(
    private readonly optionsBinance: OptionsBinanceService,
    private readonly optionsAlpaca: OptionsAlpacaService,
    private readonly exchangesService: ExchangesService,
    private readonly wsAuthService: WsAuthService,
  ) {}

  private pollerKey(venue: SubscriptionVenue, underlying: string): string {
    return `${venue}:${underlying}`;
  }

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
      const connection = await this.exchangesService.getConnectionById(connectionId);
      if (!connection) {
        client.emit('error', { message: 'Invalid connection' });
        return;
      }

      const userId = connection.user_id;
      const exchangeName = (connection as any).exchange?.name?.toLowerCase() || '';
      const venue: SubscriptionVenue = exchangeName === 'alpaca' ? 'ALPACA' : 'BINANCE';
      const up = underlying.toUpperCase();

      // Alpaca market data requires credentials — fetch once and cache on
      // the shared poller. Binance crypto chain is public, no creds needed.
      let credentials: OptionCredentials | null = null;
      if (venue === 'ALPACA') {
        try {
          credentials = await this.exchangesService.getDecryptedCredentials(connectionId);
        } catch (err: any) {
          client.emit('error', {
            message: 'Could not decrypt Alpaca credentials for live stream',
          });
          return;
        }
      }

      // Register subscription
      this.subscriptions.set(client.id, {
        connectionId,
        underlying: up,
        userId,
        venue,
      });

      // Room includes venue so a user on both connections could receive
      // both venues' data without cross-talk.
      const room = `options:${venue}:${up}`;
      client.join(room);

      this.setupSharedPolling(venue, up, client.id, credentials);

      // Send initial data immediately
      await this.pushChainUpdate(venue, up);

      client.emit('subscribed', { venue, underlying: up });
      this.logger.log(
        `Client ${client.id} subscribed to options:${venue}:${up}`,
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
    venue: SubscriptionVenue,
    underlying: string,
    socketId: string,
    credentials: OptionCredentials | null,
  ): void {
    const key = this.pollerKey(venue, underlying);
    const existing = this.sharedIntervals.get(key);

    if (existing) {
      existing.subscribers.add(socketId);
      // Upgrade cached creds if the existing poller didn't have any yet
      // (race between two Alpaca subscribers).
      if (!existing.credentials && credentials) {
        existing.credentials = credentials;
      }
      return;
    }

    const subscribers = new Set<string>([socketId]);

    const shared = {
      venue,
      underlying,
      chainInterval: null as unknown as NodeJS.Timeout,
      tickerInterval: null as unknown as NodeJS.Timeout,
      subscribers,
      credentials,
    };
    this.sharedIntervals.set(key, shared);

    shared.chainInterval = setInterval(() => {
      this.pushChainUpdate(venue, underlying).catch((err) =>
        this.logger.warn(`Chain interval error for ${key}: ${err.message}`),
      );
    }, this.CHAIN_INTERVAL_MS);

    shared.tickerInterval = setInterval(() => {
      this.pushTickerUpdate(venue, underlying).catch((err) =>
        this.logger.warn(`Ticker interval error for ${key}: ${err.message}`),
      );
    }, this.TICKER_INTERVAL_MS);
  }

  private async pushChainUpdate(
    venue: SubscriptionVenue,
    underlying: string,
  ): Promise<void> {
    try {
      const key = this.pollerKey(venue, underlying);
      const shared = this.sharedIntervals.get(key);

      let chain;
      if (venue === 'ALPACA') {
        const creds = shared?.credentials;
        if (!creds) {
          // All Alpaca subscribers have disconnected in between intervals —
          // nothing to do until a new subscriber refreshes creds.
          return;
        }
        chain = await this.optionsAlpaca.fetchOptionsChain(creds, underlying);
      } else {
        chain = await this.optionsBinance.fetchOptionsChain(null, underlying);
      }

      this.server.to(`options:${venue}:${underlying}`).emit('chain-update', {
        venue,
        underlying,
        chain,
        timestamp: Date.now(),
      });
    } catch (error: any) {
      this.logger.warn(
        `Options chain push error for ${venue}:${underlying}: ${error.message}`,
      );
    }
  }

  private async pushTickerUpdate(
    venue: SubscriptionVenue,
    underlying: string,
  ): Promise<void> {
    try {
      if (venue === 'ALPACA') {
        // Alpaca's underlying spot price comes out of the chain's dailyBar —
        // the chain poller already emits it, so we don't double-fetch here.
        // A future Phase 4b may add a dedicated equity ticker poll.
        return;
      }

      const [indexResult, tickerResult] = await Promise.allSettled([
        this.optionsBinance.getCachedIndex(underlying),
        this.optionsBinance.getCachedSpotTicker24h(underlying),
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

      this.server.to(`options:${venue}:${underlying}`).emit('ticker-update', {
        venue,
        underlying,
        price,
        change24h,
        changePercent24h,
        timestamp: Date.now(),
      });
    } catch (error: any) {
      this.logger.warn(
        `Options ticker push error for ${venue}:${underlying}: ${error.message}`,
      );
    }
  }

  // ── Cleanup ──────────────────────────────────────────────

  private cleanupClient(socketId: string): void {
    const sub = this.subscriptions.get(socketId);
    if (!sub) return;

    this.subscriptions.delete(socketId);

    const key = this.pollerKey(sub.venue, sub.underlying);
    const shared = this.sharedIntervals.get(key);
    if (!shared) return;

    shared.subscribers.delete(socketId);

    if (shared.subscribers.size === 0) {
      clearInterval(shared.chainInterval);
      clearInterval(shared.tickerInterval);
      this.sharedIntervals.delete(key);
      this.logger.debug(`Cleaned up shared options interval for ${key}`);
    }
    // Binance polling uses the shared public exchange instance (no creds).
    // Alpaca polling holds a cached credentials ref that is dropped when
    // the last subscriber for this (venue, underlying) disconnects above.
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
