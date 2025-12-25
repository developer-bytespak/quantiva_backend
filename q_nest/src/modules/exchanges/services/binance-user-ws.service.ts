import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import WebSocket from 'ws';
import { EventEmitter } from 'events';

interface UserConnection {
  listenKey: string;
  ws: WebSocket | null;
  lastKeepalive: number;
  reconnectAttempts: number;
  keepaliveTimer?: NodeJS.Timeout;
  reconnectTimer?: NodeJS.Timeout;
}

@Injectable()
export class BinanceUserWsService extends EventEmitter implements OnModuleDestroy {
  private readonly logger = new Logger(BinanceUserWsService.name);
  private readonly connections = new Map<string, UserConnection>();
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

    try {
      this.logger.log(`[UserDataStream] Connecting user ${userId}`);

      // Request listenKey
      const listenKey = await this.createListenKey();
      
      // Create WebSocket connection
      const ws = new WebSocket(`${this.wsEndpoint}/ws/${listenKey}`);
      
      const connection: UserConnection = {
        listenKey,
        ws,
        lastKeepalive: Date.now(),
        reconnectAttempts: 0,
      };

      this.connections.set(userId, connection);

      // Setup WebSocket event handlers
      ws.on('open', () => {
        this.logger.log(`[UserDataStream] Connected for user ${userId}`);
        connection.reconnectAttempts = 0;
        this.emit('connection:status', { userId, connected: true });
        
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
        this.emit('error', { userId, code: 'WS_ERROR', message: error.message });
      });

      ws.on('close', (code, reason) => {
        this.logger.warn(`[UserDataStream] Connection closed for user ${userId}: ${code} - ${reason}`);
        this.emit('connection:status', { userId, connected: false });
        this.stopKeepalive(userId);
        
        // Attempt reconnection
        this.reconnect(userId, connection.reconnectAttempts + 1);
      });

    } catch (error) {
      this.logger.error(`[UserDataStream] Failed to connect user ${userId}: ${error.message}`);
      
      // If rate limited, don't emit error - just log it
      if (error.message === 'RATE_LIMITED' || error.message === 'BAD_REQUEST') {
        this.emit('error', { 
          userId, 
          code: 'RATE_LIMITED', 
          message: 'Binance API rate limited. Please wait 10-15 minutes before refreshing.' 
        });
        return; // Don't throw - allow app to continue with REST fallback
      }
      
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

    // Stop timers
    this.stopKeepalive(userId);
    if (connection.reconnectTimer) {
      clearTimeout(connection.reconnectTimer);
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
    this.emit('connection:status', { userId, connected: false });
  }

  /**
   * Create a new listenKey from Binance
   */
  private async createListenKey(): Promise<string> {
    try {
      this.logger.log('Requesting listenKey from Binance...');
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

      this.logger.log('Successfully created listenKey');
      return response.data.listenKey;
    } catch (error) {
      const statusCode = error?.response?.status;
      const errorMsg = error?.response?.data?.msg || error.message;
      
      // Detect rate limiting
      if (statusCode === 429 || statusCode === 418 || errorMsg?.includes('rate limit')) {
        this.logger.error(`⛔ BINANCE RATE LIMITED - Cannot create listenKey. Status: ${statusCode}, Message: ${errorMsg}`);
        this.logger.warn('⏳ Wait 10-15 minutes before attempting to reconnect');
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
          this.emit('balance:update', {
            userId,
            asset,
            free: free || '0',
            locked: locked || '0',
            timestamp: data.E || Date.now(),
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
      })),
    };
    return stats;
  }
}
