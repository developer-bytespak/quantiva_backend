import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Logger, UseGuards } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { BinanceUserWsService } from '../modules/exchanges/services/binance-user-ws.service';

@WebSocketGateway({
  namespace: 'paper-trading',
  cors: {
    origin: '*', // In production, restrict this to your frontend domain
    credentials: true,
  },
})
export class PaperTradingGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(PaperTradingGateway.name);
  private readonly userSockets = new Map<string, Set<string>>(); // userId -> Set of socket IDs

  constructor(private readonly binanceUserWsService: BinanceUserWsService) {
    // Subscribe to BinanceUserWsService events
    this.setupBinanceEventListeners();
  }

  /**
   * Setup listeners for Binance WebSocket events
   */
  private setupBinanceEventListeners(): void {
    // Forward balance updates to connected clients
    this.binanceUserWsService.on('balance:update', (data) => {
      const { userId, ...payload } = data;
      this.emitToUser(userId, 'balance:update', payload);
    });

    // Forward order updates to connected clients
    this.binanceUserWsService.on('order:update', (data) => {
      const { userId, ...payload } = data;
      this.emitToUser(userId, 'order:update', payload);
    });

    // Forward connection status to clients
    this.binanceUserWsService.on('connection:status', (data) => {
      const { userId, ...payload } = data;
      this.emitToUser(userId, 'connection:status', payload);
    });

    // Forward errors to clients
    this.binanceUserWsService.on('error', (data) => {
      const { userId, ...payload } = data;
      this.emitToUser(userId, 'error', payload);
    });
  }

  /**
   * Emit event to all sockets of a specific user
   */
  private emitToUser(userId: string, event: string, data: any): void {
    const socketIds = this.userSockets.get(userId);
    if (socketIds && socketIds.size > 0) {
      socketIds.forEach((socketId) => {
        this.server.to(socketId).emit(event, data);
      });
    }
  }

  /**
   * Handle new client connection
   */
  async handleConnection(client: Socket): Promise<void> {
    try {
      // Extract userId from auth/handshake
      // For now, we'll use a default user or extract from query params
      // In production, verify JWT token here
      const userId = client.handshake.auth?.userId || 
                     client.handshake.query?.userId as string || 
                     'default-user';

      this.logger.log(`Client connected: ${client.id}, userId: ${userId}`);

      // Track socket for this user
      if (!this.userSockets.has(userId)) {
        this.userSockets.set(userId, new Set());
      }
      this.userSockets.get(userId)!.add(client.id);

      // Store userId in socket data for later reference
      client.data.userId = userId;

      // Join user-specific room
      await client.join(`user:${userId}`);

      // Send connection confirmation
      client.emit('connection:status', { 
        connected: true, 
        message: 'Connected to paper trading WebSocket' 
      });

    } catch (error) {
      this.logger.error(`Connection error: ${error.message}`);
      client.emit('error', { code: 'CONNECTION_ERROR', message: error.message });
      client.disconnect();
    }
  }

  /**
   * Handle client disconnection
   */
  async handleDisconnect(client: Socket): Promise<void> {
    const userId = client.data.userId;
    this.logger.log(`Client disconnected: ${client.id}, userId: ${userId}`);

    if (userId) {
      // Remove socket from user tracking
      const socketIds = this.userSockets.get(userId);
      if (socketIds) {
        socketIds.delete(client.id);
        
        // If no more sockets for this user, disconnect from Binance
        if (socketIds.size === 0) {
          this.logger.log(`No more active connections for user ${userId}, disconnecting from Binance`);
          this.userSockets.delete(userId);
          
          // Delay disconnection to allow for quick reconnects
          setTimeout(async () => {
            const currentSockets = this.userSockets.get(userId);
            if (!currentSockets || currentSockets.size === 0) {
              await this.binanceUserWsService.disconnect(userId);
            }
          }, 5000); // 5 second grace period
        }
      }
    }
  }

  /**
   * Handle subscribe to account data stream
   */
  @SubscribeMessage('subscribe:account')
  async handleSubscribeAccount(@ConnectedSocket() client: Socket): Promise<void> {
    const userId = client.data.userId;
    
    if (!userId) {
      client.emit('error', { code: 'NO_USER_ID', message: 'User ID not found' });
      return;
    }

    try {
      this.logger.log(`Subscribing to account data for user ${userId}`);
      
      // Connect to Binance user data stream
      await this.binanceUserWsService.connect(userId);
      
      client.emit('connection:status', { 
        connected: true, 
        message: 'Subscribed to account updates' 
      });
    } catch (error) {
      this.logger.error(`Failed to subscribe to account: ${error.message}`);
      client.emit('error', { 
        code: 'SUBSCRIBE_FAILED', 
        message: 'Failed to subscribe to account updates' 
      });
    }
  }

  /**
   * Handle unsubscribe from account data stream
   */
  @SubscribeMessage('unsubscribe:account')
  async handleUnsubscribeAccount(@ConnectedSocket() client: Socket): Promise<void> {
    const userId = client.data.userId;
    
    if (!userId) {
      return;
    }

    try {
      this.logger.log(`Unsubscribing from account data for user ${userId}`);
      
      // Check if other sockets for this user are still connected
      const socketIds = this.userSockets.get(userId);
      if (!socketIds || socketIds.size <= 1) {
        await this.binanceUserWsService.disconnect(userId);
      }
      
      client.emit('connection:status', { 
        connected: false, 
        message: 'Unsubscribed from account updates' 
      });
    } catch (error) {
      this.logger.error(`Failed to unsubscribe from account: ${error.message}`);
    }
  }

  /**
   * Handle ping for connection health check
   */
  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() client: Socket): void {
    client.emit('pong', { timestamp: Date.now() });
  }

  /**
   * Get connection stats (for monitoring/debugging)
   */
  @SubscribeMessage('get:stats')
  handleGetStats(@ConnectedSocket() client: Socket): void {
    const stats = this.binanceUserWsService.getStats();
    client.emit('stats', {
      ...stats,
      gatewayConnections: this.userSockets.size,
    });
  }
}
