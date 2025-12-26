import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import WebSocket from 'ws';
import { EventEmitter } from 'events';

type BinanceConnectionState = 'CONNECTING' | 'CONNECTED' | 'RATE_LIMITED' | 'DISCONNECTED' | 'ERROR';

interface UserConnection {
  listenKey: string;
  ws: WebSocket | null;
  lastKeepalive: number;
  reconnectAttempts: number;
  keepaliveTimer?: NodeJS.Timeout;
  reconnectTimer?: NodeJS.Timeout;
  retryTimer?: NodeJS.Timeout;
  state: BinanceConnectionState;
}

@Injectable()
export class BinanceUserWsService extends EventEmitter implements OnModuleDestroy {
  private readonly logger = new Logger(BinanceUserWsService.name);
  private readonly connections = new Map<string, UserConnection>();
  private readonly lastBalances = new Map<string, Record<string, { free: string; locked: string; timestamp: number }>>();
  // Store last orders per user as a map of orderId -> orderUpdate
  private readonly lastOrders = new Map<string, Map<string, any>>();
  private readonly userRateLimitUntil = new Map<string, number>();
  private readonly MAX_RECONNECT_ATTEMPTS = 10;
  private readonly KEEPALIVE_INTERVAL = 30 * 60 * 1000; // 30 minutes
  private readonly baseUrl: string;
  private readonly wsEndpoint: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;

  constructor(private readonly configService: ConfigService) {
    super();
    this.baseUrl = configService.get('TESTNET_BASE_URL', 'https://testnet.binance.vision');
    this.wsEndpoint = configService.get('TESTNET_WS_ENDPOINT', 'wss://stream.testnet.binance.vision:9443');
    this.apiKey = configService.get('TESTNET_API_KEY', '');
    this.apiSecret = configService.get('TESTNET_API_SECRET', '');

    if (!this.apiKey || !this.apiSecret) {
      this.logger.warn('TESTNET_API_KEY or TESTNET_API_SECRET not configured');
    }
  }

  async onModuleDestroy() {
    this.logger.log('Cleaning up all WebSocket connections...');
    for (const [userId, connection] of this.connections.entries()) {
      await this.disconnect(userId);
    }
  }

  /**
   * Connect a user to their data stream
   */
  async connect(userId: string): Promise<void> {
    // Check if already connected
    const existing = this.connections.get(userId);
    if (existing?.ws?.readyState === WebSocket.OPEN) {
      this.logger.log(`User ${userId} already connected`);
      return;
    }

    // Reuse existing listenKey if connection exists and is still valid
    if (existing?.listenKey && existing.state !== 'DISCONNECTED') {
      this.logger.log(`[UserDataStream] Reusing existing listenKey for user ${userId}`);
      return this.connectWithListenKey(userId, existing.listenKey);
    }

    // Check if user is currently rate-limited
    const rateLimitedUntil = this.userRateLimitUntil.get(userId);
    if (rateLimitedUntil && Date.now() < rateLimitedUntil) {
      const remainingMs = rateLimitedUntil - Date.now();
      this.logger.warn(`[UserDataStream] User ${userId} is rate-limited for ${Math.ceil(remainingMs / 1000)}s more`);
      this.emitBinanceStatus(userId, 'RATE_LIMITED', rateLimitedUntil);
      return;
    }

    this.logger.log(`[UserDataStream] Connecting user ${userId}`);
    this.emitBinanceStatus(userId, 'CONNECTING');

    try {
      // Request listenKey
      const listenKey = await this.createListenKey(userId);
      await this.connectWithListenKey(userId, listenKey);
    } catch (error) {
      // If rate limited, schedule automatic retry
      if (error.message === 'RATE_LIMITED') {
        const rateLimitedUntil = this.userRateLimitUntil.get(userId);
        if (rateLimitedUntil) {
          this.scheduleRetry(userId, rateLimitedUntil);
        }
        return; // Don't throw - let retry mechanism handle it
      }
      
      this.logger.error(`[UserDataStream] Failed to connect user ${userId}: ${error.message}`);
      this.emitBinanceStatus(userId, 'ERROR', undefined, error.message);
    }
  }

  /**
   * Connect using an existing listenKey
   */
  private async connectWithListenKey(userId: string, listenKey: string): Promise<void> {
    try {
      // Create WebSocket connection
      const ws = new WebSocket(`${this.wsEndpoint}/ws/${listenKey}`);
      
      const connection: UserConnection = {
        listenKey,
        ws,
        lastKeepalive: Date.now(),
        reconnectAttempts: 0,
        state: 'CONNECTING',
      };

      this.connections.set(userId, connection);

      // Setup WebSocket event handlers
      ws.on('open', () => {
        this.logger.log(`[UserDataStream] Connected for user ${userId}`);
        connection.reconnectAttempts = 0;
        connection.state = 'CONNECTED';
        this.emitBinanceStatus(userId, 'CONNECTED');
        
        // Start keepalive timer
        this.startKeepalive(userId);
      });

      ws.on('message', (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(userId, message);
        } catch (error) {
          this.logger.error(`[UserDataStream] Failed to parse message: ${error.message}`);
        }
      });

      ws.on('error', (error) => {
        this.logger.error(`[UserDataStream] WebSocket error for user ${userId}: ${error.message}`);
        connection.state = 'ERROR';
        this.emitBinanceStatus(userId, 'ERROR', undefined, error.message);
      });

      ws.on('close', (code, reason) => {
        this.logger.warn(`[UserDataStream] Connection closed for user ${userId}: ${code} - ${reason}`);
        connection.state = 'DISCONNECTED';
        this.emitBinanceStatus(userId, 'DISCONNECTED');
        this.stopKeepalive(userId);
        
        // Attempt reconnection
        this.reconnect(userId, connection.reconnectAttempts + 1);
      });

    } catch (error) {
      this.logger.error(`[UserDataStream] Failed to create WebSocket for user ${userId}: ${error.message}`);
      this.emitBinanceStatus(userId, 'ERROR', undefined, error.message);
      throw error;
    }
  }

  /**
   * Disconnect a user's data stream
   */
  async disconnect(userId: string): Promise<void> {
    const connection = this.connections.get(userId);
    if (!connection) {
      return;
    }

    this.logger.log(`[UserDataStream] Disconnecting user ${userId}`);

    // Stop all timers
    this.stopKeepalive(userId);
    if (connection.reconnectTimer) {
      clearTimeout(connection.reconnectTimer);
    }
    if (connection.retryTimer) {
      clearTimeout(connection.retryTimer);
    }

    // Close WebSocket
    if (connection.ws) {
      connection.ws.removeAllListeners();
      if (connection.ws.readyState === WebSocket.OPEN) {
        connection.ws.close();
      }
    }

    // Delete listenKey
    try {
      await this.deleteListenKey(connection.listenKey);
    } catch (error) {
      this.logger.error(`Failed to delete listenKey: ${error.message}`);
    }

    this.connections.delete(userId);
    this.userRateLimitUntil.delete(userId);
    this.emitBinanceStatus(userId, 'DISCONNECTED');
  }

  /**
   * Create a new listenKey from Binance
   */
  private async createListenKey(userId: string): Promise<string> {
    try {
      this.logger.log(`Requesting listenKey from Binance for user ${userId}...`);
      const response = await axios.post(
        `${this.baseUrl}/api/v3/userDataStream`,
        {},
        {
          headers: {
            'X-MBX-APIKEY': this.apiKey,
          },
          timeout: 10000,
        }
      );

      this.logger.log(`Successfully created listenKey for user ${userId}`);
      return response.data.listenKey;
    } catch (error) {
      const statusCode = error?.response?.status;
      const errorMsg = error?.response?.data?.msg || error.message;
      
      // Detect rate limiting
      if (statusCode === 429 || statusCode === 418 || errorMsg?.includes('rate limit')) {
        this.logger.error(`⛔ BINANCE RATE LIMITED - Cannot create listenKey. Status: ${statusCode}, Message: ${errorMsg}`);
        
        // Set per-user cooldown
        const cooldownMs = 10 * 60 * 1000; // 10 minutes by default
        const rateLimitedUntil = Date.now() + cooldownMs;
        this.userRateLimitUntil.set(userId, rateLimitedUntil);
        
        this.logger.warn(`⏳ User ${userId} rate-limited until ${new Date(rateLimitedUntil).toISOString()}`);
        this.emitBinanceStatus(userId, 'RATE_LIMITED', rateLimitedUntil);
        throw new Error('RATE_LIMITED');
      } else if (statusCode === 400) {
        this.logger.error(`❌ Bad Request (400) - Possible rate limit or API key issue: ${errorMsg}`);
        throw new Error('BAD_REQUEST');
      }
      
      this.logger.error(`Failed to create listenKey: ${errorMsg}`);
      throw new Error('Failed to create listenKey');
    }
  }

  /**
   * Keepalive for listenKey (extend validity)
   */
  private async keepAlive(listenKey: string): Promise<void> {
    try {
      await axios.put(
        `${this.baseUrl}/api/v3/userDataStream`,
        {},
        {
          headers: {
            'X-MBX-APIKEY': this.apiKey,
          },
          params: { listenKey },
        }
      );

      this.logger.log(`ListenKey keepalive successful`);
    } catch (error) {
      this.logger.error(`ListenKey keepalive failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Delete listenKey when done
   */
  private async deleteListenKey(listenKey: string): Promise<void> {
    try {
      await axios.delete(
        `${this.baseUrl}/api/v3/userDataStream`,
        {
          headers: {
            'X-MBX-APIKEY': this.apiKey,
          },
          params: { listenKey },
        }
      );

      this.logger.log(`ListenKey deleted`);
    } catch (error) {
      this.logger.error(`Failed to delete listenKey: ${error.message}`);
    }
  }

  /**
   * Start keepalive timer for a connection
   */
  private startKeepalive(userId: string): void {
    const connection = this.connections.get(userId);
    if (!connection) return;

    connection.keepaliveTimer = setInterval(async () => {
      try {
        await this.keepAlive(connection.listenKey);
        connection.lastKeepalive = Date.now();
      } catch (error) {
        this.logger.error(`Keepalive failed for user ${userId}, will reconnect`);
        // Reconnect will be triggered by WebSocket close event
        connection.ws?.close();
      }
    }, this.KEEPALIVE_INTERVAL);
  }

  /**
   * Stop keepalive timer
   */
  private stopKeepalive(userId: string): void {
    const connection = this.connections.get(userId);
    if (connection?.keepaliveTimer) {
      clearInterval(connection.keepaliveTimer);
      connection.keepaliveTimer = undefined;
    }
  }

  /**
   * Reconnect with exponential backoff
   */
  private reconnect(userId: string, attempt: number): void {
    const connection = this.connections.get(userId);
    if (!connection) return;

    if (attempt > this.MAX_RECONNECT_ATTEMPTS) {
      this.logger.error(`[UserDataStream] Max reconnection attempts reached for user ${userId}`);
      this.emit('error', { 
        userId, 
        code: 'MAX_RECONNECT_ATTEMPTS', 
        message: 'Failed to reconnect after maximum attempts' 
      });
      this.connections.delete(userId);
      return;
    }

    // Exponential backoff with jitter: 1s, 2s, 4s, 8s, 16s, 32s, max 60s
    const baseDelay = Math.min(1000 * Math.pow(2, attempt - 1), 60000);
    const jitter = Math.random() * 500; // 0-500ms jitter
    const delay = baseDelay + jitter;

    this.logger.warn(`[UserDataStream] Reconnecting attempt ${attempt}/${this.MAX_RECONNECT_ATTEMPTS} for user ${userId} in ${Math.round(delay)}ms`);

    connection.reconnectAttempts = attempt;
    connection.reconnectTimer = setTimeout(async () => {
      try {
        // Clean up old connection
        if (connection.ws) {
          connection.ws.removeAllListeners();
          connection.ws.close();
        }
        
        // Attempt new connection
        await this.connect(userId);
      } catch (error) {
        this.logger.error(`Reconnection failed: ${error.message}`);
      }
    }, delay);
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(userId: string, data: any): void {
    const eventType = data.e;

    switch (eventType) {
      case 'outboundAccountPosition':
        this.handleBalanceUpdate(data, userId);
        break;
      case 'executionReport':
        this.handleOrderUpdate(data, userId);
        break;
      case 'balanceUpdate':
        this.handleBalanceUpdate(data, userId);
        break;
      default:
        this.logger.debug(`Received event type: ${eventType}`);
    }
  }

  /**
   * Handle balance update events
   */
  private handleBalanceUpdate(data: any, userId: string): void {
    try {
      // Extract balance updates from outboundAccountPosition or balanceUpdate
      const balances = data.B || [data]; // B is array in outboundAccountPosition

      for (const balance of balances) {
        const asset = balance.a || balance.A; // lowercase for balanceUpdate, uppercase for outboundAccountPosition
        const free = balance.f || balance.F;
        const locked = balance.l || balance.L;

        if (asset && (free !== undefined || locked !== undefined)) {
          const timestamp = data.E || Date.now();

          // Update in-memory last balance for user (safe, no external calls)
          const userBalances = this.lastBalances.get(userId) || {};
          userBalances[asset] = { free: String(free || '0'), locked: String(locked || '0'), timestamp };
          this.lastBalances.set(userId, userBalances);

          this.emit('balance:update', {
            userId,
            asset,
            free: free || '0',
            locked: locked || '0',
            timestamp,
          });

          this.logger.log(`[BalanceUpdate] User ${userId}, ${asset}: free=${free}, locked=${locked}`);
        }
      }
    } catch (error) {
      this.logger.error(`Failed to handle balance update: ${error.message}`);
    }
  }

  /**
   * Handle order update events (executionReport)
   */
  private handleOrderUpdate(data: any, userId: string): void {
    try {
      const orderUpdate = {
        userId,
        orderId: data.i?.toString(),
        clientOrderId: data.c,
        symbol: data.s,
        side: data.S, // BUY or SELL
        type: data.o, // LIMIT, MARKET, etc.
        status: data.X, // NEW, PARTIALLY_FILLED, FILLED, CANCELED, REJECTED, EXPIRED
        price: data.p,
        quantity: data.q,
        executedQuantity: data.z,
        cumulativeQuoteQuantity: data.Z,
        timestamp: data.E || data.T || Date.now(),
        timeInForce: data.f,
        commissionAsset: data.N,
        commission: data.n,
      };

      // Persist last order state in-memory
      const userOrders = this.lastOrders.get(userId) || new Map<string, any>();
      if (orderUpdate.orderId) {
        userOrders.set(orderUpdate.orderId, orderUpdate);
      }
      this.lastOrders.set(userId, userOrders);

      this.emit('order:update', orderUpdate);

      this.logger.log(
        `[OrderUpdate] User ${userId}, Order ${orderUpdate.orderId}, ` +
        `${orderUpdate.symbol} ${orderUpdate.side} ${orderUpdate.status}, ` +
        `filled: ${orderUpdate.executedQuantity}/${orderUpdate.quantity}`
      );
    } catch (error) {
      this.logger.error(`Failed to handle order update: ${error.message}`);
    }
  }

  /**
   * Check if user is connected
   */
  isConnected(userId: string): boolean {
    const connection = this.connections.get(userId);
    return connection?.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Get connection stats
   */
  getStats() {
    const stats = {
      totalConnections: this.connections.size,
      connections: Array.from(this.connections.entries()).map(([userId, conn]) => ({
        userId,
        connected: conn.ws?.readyState === WebSocket.OPEN,
        reconnectAttempts: conn.reconnectAttempts,
        lastKeepalive: conn.lastKeepalive,
        lastBalance: this.lastBalances.get(userId) || null,
      })),
    };
    return stats;
  }

  /**
   * Returns rate limit status for a specific user (read-only)
   */
  getRateLimitStatus(userId?: string) {
    const now = Date.now();
    
    if (userId) {
      const rateLimitedUntil = this.userRateLimitUntil.get(userId);
      if (rateLimitedUntil && rateLimitedUntil > now) {
        return { rateLimited: true, remainingMs: rateLimitedUntil - now };
      }
      return { rateLimited: false, remainingMs: 0 };
    }
    
    // Check if any user is rate-limited (for global health check)
    const anyRateLimited = Array.from(this.userRateLimitUntil.values())
      .some(until => until > now);
    
    return { rateLimited: anyRateLimited, remainingMs: 0 };
  }

  /**
   * Get last known balance for a user (if any)
   */
  getLastBalance(userId: string) {
    return this.lastBalances.get(userId) || null;
  }

  /**
   * Get last known orders for a user (if any) as an array sorted by timestamp desc
   */
  getLastOrders(userId: string) {
    const map = this.lastOrders.get(userId);
    if (!map) return [];
    const arr = Array.from(map.values());
    arr.sort((a: any, b: any) => (b.timestamp || 0) - (a.timestamp || 0));
    return arr;
  }

  /**
   * Emit Binance connection status to clients (state-based, not error-based)
   */
  private emitBinanceStatus(
    userId: string, 
    state: BinanceConnectionState, 
    retryAt?: number,
    message?: string
  ): void {
    this.emit('binance:status', { 
      userId, 
      state, 
      retryAt: retryAt || null,
      message: message || null
    });
  }

  /**
   * Schedule automatic retry after rate limit expires
   */
  private scheduleRetry(userId: string, rateLimitedUntil: number): void {
    const connection = this.connections.get(userId);
    if (!connection) return;

    // Clear any existing retry timer
    if (connection.retryTimer) {
      clearTimeout(connection.retryTimer);
    }

    const retryDelay = rateLimitedUntil - Date.now() + 1000; // Add 1s buffer
    if (retryDelay <= 0) {
      // Rate limit already expired, retry immediately
      this.logger.log(`[UserDataStream] Rate limit expired for user ${userId}, retrying now`);
      this.connect(userId);
      return;
    }

    this.logger.log(`[UserDataStream] Scheduling automatic retry for user ${userId} in ${Math.ceil(retryDelay / 1000)}s`);
    connection.retryTimer = setTimeout(() => {
      this.logger.log(`[UserDataStream] Automatic retry triggered for user ${userId}`);
      this.connect(userId);
    }, retryDelay);
  }
}
