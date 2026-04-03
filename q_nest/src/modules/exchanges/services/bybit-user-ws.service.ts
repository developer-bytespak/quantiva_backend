import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import * as crypto from 'crypto';

type BybitConnectionState = 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'ERROR';

interface UserConnection {
  ws: WebSocket | null;
  reconnectAttempts: number;
  pingTimer?: NodeJS.Timeout;
  reconnectTimer?: NodeJS.Timeout;
  state: BybitConnectionState;
}

@Injectable()
export class BybitUserWsService extends EventEmitter implements OnModuleDestroy {
  private readonly logger = new Logger(BybitUserWsService.name);
  private readonly WS_URL = 'wss://stream.bybit.com/v5/private';
  private readonly connections = new Map<string, UserConnection>();
  private readonly userApiKeys = new Map<string, { apiKey: string; apiSecret: string }>();
  private readonly lastBalances = new Map<string, Record<string, { free: string; locked: string; timestamp: number }>>();
  private readonly lastOrders = new Map<string, Map<string, any>>();
  private readonly MAX_RECONNECT_ATTEMPTS = 10;
  private readonly PING_INTERVAL = 20 * 1000; // 20 seconds (Bybit requires ping every 30s)

  async onModuleDestroy() {
    this.logger.log('Cleaning up all Bybit WebSocket connections...');
    for (const userId of this.connections.keys()) {
      await this.disconnect(userId);
    }
  }

  /**
   * Generate Bybit WebSocket auth signature.
   * Format: HMAC-SHA256(expires + apiKey)
   */
  private createAuthMessage(apiKey: string, apiSecret: string): any {
    const expires = Date.now() + 10000; // 10 seconds from now
    const signature = crypto
      .createHmac('sha256', apiSecret)
      .update(`GET/realtime${expires}`)
      .digest('hex');

    return {
      op: 'auth',
      args: [apiKey, expires, signature],
    };
  }

  /**
   * Connect a user to Bybit's private WebSocket stream.
   */
  async connect(userId: string, apiKey?: string, apiSecret?: string): Promise<void> {
    if (apiKey && apiSecret) {
      this.userApiKeys.set(userId, { apiKey, apiSecret });
    }

    const creds = this.userApiKeys.get(userId);
    if (!creds) {
      throw new Error('API keys required for Bybit WebSocket');
    }

    // Already connected
    const existing = this.connections.get(userId);
    if (existing?.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    this.logger.log(`[BybitWS] Connecting user ${userId}`);

    try {
      const ws = new WebSocket(this.WS_URL);

      const connection: UserConnection = {
        ws,
        reconnectAttempts: 0,
        state: 'CONNECTING',
      };
      this.connections.set(userId, connection);

      ws.on('open', () => {
        this.logger.log(`[BybitWS] Connected, authenticating user ${userId}`);
        connection.state = 'CONNECTING';

        // Authenticate
        const authMsg = this.createAuthMessage(creds.apiKey, creds.apiSecret);
        ws.send(JSON.stringify(authMsg));
      });

      ws.on('message', (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(userId, msg, ws);
        } catch {
          // ignore parse errors
        }
      });

      ws.on('error', (error) => {
        this.logger.error(`[BybitWS] Error for user ${userId}: ${error.message}`);
        connection.state = 'ERROR';
        this.emit('bybit:status', { userId, state: 'ERROR', message: error.message });
      });

      ws.on('close', (code, reason) => {
        this.logger.warn(`[BybitWS] Closed for user ${userId}: code=${code}`);
        connection.state = 'DISCONNECTED';
        this.stopPing(userId);
        this.emit('bybit:status', { userId, state: 'DISCONNECTED' });
        this.reconnect(userId, connection.reconnectAttempts + 1);
      });

    } catch (error: any) {
      this.logger.error(`[BybitWS] Failed to connect user ${userId}: ${error.message}`);
    }
  }

  /**
   * Disconnect a user's WebSocket.
   */
  async disconnect(userId: string): Promise<void> {
    const connection = this.connections.get(userId);
    if (!connection) return;

    this.stopPing(userId);
    if (connection.reconnectTimer) clearTimeout(connection.reconnectTimer);

    if (connection.ws) {
      connection.ws.removeAllListeners();
      if (connection.ws.readyState === WebSocket.OPEN) {
        connection.ws.close();
      }
    }

    this.connections.delete(userId);
    this.userApiKeys.delete(userId);
    this.logger.log(`[BybitWS] Disconnected user ${userId}`);
  }

  /**
   * Handle all incoming WebSocket messages.
   */
  private handleMessage(userId: string, msg: any, ws: WebSocket): void {
    // Auth response
    if (msg.op === 'auth') {
      if (msg.success) {
        this.logger.log(`[BybitWS] Authenticated user ${userId}, subscribing to channels`);
        const connection = this.connections.get(userId);
        if (connection) {
          connection.state = 'CONNECTED';
          connection.reconnectAttempts = 0;
        }
        this.emit('bybit:status', { userId, state: 'CONNECTED' });

        // Subscribe to wallet and order channels
        ws.send(JSON.stringify({
          op: 'subscribe',
          args: ['wallet', 'order', 'execution'],
        }));

        // Start ping/pong keepalive
        this.startPing(userId, ws);
      } else {
        this.logger.error(`[BybitWS] Auth failed for user ${userId}: ${msg.ret_msg}`);
        this.emit('bybit:status', { userId, state: 'ERROR', message: msg.ret_msg });
      }
      return;
    }

    // Pong response
    if (msg.op === 'pong') {
      return;
    }

    // Subscribe response
    if (msg.op === 'subscribe') {
      if (msg.success) {
        this.logger.log(`[BybitWS] Subscribed to channels for user ${userId}`);
      }
      return;
    }

    // Data messages
    const topic = msg.topic;
    if (!topic) return;

    if (topic === 'wallet') {
      this.handleWalletUpdate(userId, msg.data);
    } else if (topic === 'order') {
      this.handleOrderUpdate(userId, msg.data);
    } else if (topic === 'execution') {
      this.handleExecutionUpdate(userId, msg.data);
    }
  }

  /**
   * Handle wallet balance updates.
   * Bybit sends: { accountType, coin: [{ coin, walletBalance, availableToWithdraw, ... }] }
   */
  private handleWalletUpdate(userId: string, data: any[]): void {
    try {
      for (const account of data) {
        for (const coin of (account.coin || [])) {
          const asset = coin.coin;
          const walletBalance = coin.walletBalance || '0';
          const available = coin.availableToWithdraw || walletBalance;
          const locked = coin.locked || '0';
          const timestamp = Date.now();

          // Update cached balance
          const userBalances = this.lastBalances.get(userId) || {};
          userBalances[asset] = {
            free: available || String(parseFloat(walletBalance) - parseFloat(locked)),
            locked,
            timestamp,
          };
          this.lastBalances.set(userId, userBalances);

          this.emit('balance:update', {
            userId,
            asset,
            free: userBalances[asset].free,
            locked,
            timestamp,
          });

          this.logger.debug(`[BybitWS] Balance: user=${userId} ${asset} balance=${walletBalance} available=${available}`);
        }
      }
    } catch (error: any) {
      this.logger.error(`[BybitWS] Failed to handle wallet update: ${error.message}`);
    }
  }

  /**
   * Handle order updates.
   * Bybit sends: [{ orderId, symbol, side, orderType, orderStatus, qty, price, ... }]
   */
  private handleOrderUpdate(userId: string, data: any[]): void {
    try {
      for (const order of data) {
        const orderUpdate = {
          userId,
          orderId: order.orderId,
          symbol: order.symbol,
          side: order.side === 'Buy' ? 'BUY' : 'SELL',
          type: order.orderType,
          status: order.orderStatus,
          price: order.price || order.avgPrice || '0',
          quantity: order.qty || '0',
          executedQuantity: order.cumExecQty || '0',
          cumulativeQuoteQuantity: order.cumExecValue || '0',
          timestamp: parseInt(order.updatedTime || order.createdTime || '0', 10) || Date.now(),
          triggerPrice: order.triggerPrice || '0',
        };

        // Cache order
        const userOrders = this.lastOrders.get(userId) || new Map<string, any>();
        userOrders.set(orderUpdate.orderId, orderUpdate);
        this.lastOrders.set(userId, userOrders);

        this.emit('order:update', orderUpdate);

        this.logger.debug(
          `[BybitWS] Order: user=${userId} ${orderUpdate.symbol} ${orderUpdate.side} ${orderUpdate.status}`,
        );
      }
    } catch (error: any) {
      this.logger.error(`[BybitWS] Failed to handle order update: ${error.message}`);
    }
  }

  /**
   * Handle execution (trade fill) updates.
   */
  private handleExecutionUpdate(userId: string, data: any[]): void {
    try {
      for (const exec of data) {
        this.emit('execution:update', {
          userId,
          execId: exec.execId,
          orderId: exec.orderId,
          symbol: exec.symbol,
          side: exec.side === 'Buy' ? 'BUY' : 'SELL',
          price: exec.execPrice,
          qty: exec.execQty,
          fee: exec.execFee,
          feeCurrency: exec.feeCurrency,
          timestamp: parseInt(exec.execTime || '0', 10) || Date.now(),
        });
      }
    } catch (error: any) {
      this.logger.error(`[BybitWS] Failed to handle execution update: ${error.message}`);
    }
  }

  /**
   * Start ping/pong keepalive (Bybit requires ping every 30s).
   */
  private startPing(userId: string, ws: WebSocket): void {
    const connection = this.connections.get(userId);
    if (!connection) return;

    connection.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ op: 'ping' }));
      }
    }, this.PING_INTERVAL);
  }

  private stopPing(userId: string): void {
    const connection = this.connections.get(userId);
    if (connection?.pingTimer) {
      clearInterval(connection.pingTimer);
      connection.pingTimer = undefined;
    }
  }

  /**
   * Reconnect with exponential backoff.
   */
  private reconnect(userId: string, attempt: number): void {
    const connection = this.connections.get(userId);
    if (!connection) return;

    if (attempt > this.MAX_RECONNECT_ATTEMPTS) {
      this.logger.error(`[BybitWS] Max reconnect attempts for user ${userId}`);
      this.connections.delete(userId);
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, attempt - 1), 60000) + Math.random() * 500;

    this.logger.warn(`[BybitWS] Reconnecting user ${userId} in ${Math.round(delay)}ms (attempt ${attempt})`);

    connection.reconnectAttempts = attempt;
    connection.reconnectTimer = setTimeout(async () => {
      try {
        if (connection.ws) {
          connection.ws.removeAllListeners();
          connection.ws.close();
        }
        await this.connect(userId);
      } catch {
        // reconnect will be retried on close
      }
    }, delay);
  }

  // --- Public read methods (same interface as BinanceUserWsService) ---

  isConnected(userId: string): boolean {
    return this.connections.get(userId)?.ws?.readyState === WebSocket.OPEN;
  }

  getLastBalance(userId: string) {
    return this.lastBalances.get(userId) || null;
  }

  getLastOrders(userId: string) {
    const map = this.lastOrders.get(userId);
    if (!map) return [];
    return Array.from(map.values()).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  }

  getStats() {
    return {
      totalConnections: this.connections.size,
      connections: Array.from(this.connections.entries()).map(([userId, conn]) => ({
        userId,
        connected: conn.ws?.readyState === WebSocket.OPEN,
        reconnectAttempts: conn.reconnectAttempts,
        state: conn.state,
      })),
    };
  }
}
