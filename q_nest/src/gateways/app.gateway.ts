import { Logger } from '@nestjs/common';
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { NotificationsService } from 'src/modules/notifications/notifications.service';
import { WsAuthService } from './ws-auth.service';

@WebSocketGateway({
  cors: {
    // TODO: Update origin when hosted on AWS — replace Vercel URL with AWS domain
    origin: ['http://quantiva-hq.vercel.app','https://bytes-test-5.com', 'https://quantiva-hq.vercel.app', 'http://localhost:3001'],
    credentials: true,
  },
})
export class AppGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(AppGateway.name);
  private readonly onlineUsers = new Set<string>();

  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly wsAuthService: WsAuthService,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    // Verify JWT token and extract userId
    const authResult = this.wsAuthService.verifyConnection(client);
    if (!authResult.authenticated || !authResult.userId) {
      this.logger.warn(`Unauthorized connection attempt: ${client.id} — ${authResult.error}`);
      client.emit('error', { code: 'UNAUTHORIZED', message: authResult.error || 'Authentication required' });
      client.disconnect();
      return;
    }

    const userId = authResult.userId;
    client.data.userId = userId;
    this.logger.log(`AppGateway handleConnection ${userId}`);

    client.join(`user:${userId}`);

    client.emit('connection:status', {
      connected: true,
      userId,
      socketId: client.id,
      onlineUsers: [...this.onlineUsers],
    });
  }

  handleDisconnect(client: Socket): void {
    const userId = client.data?.userId as string;

    if (userId && this.onlineUsers.delete(userId)) {
      this.logger.log(`Disconnected: ${client.id} | User: ${userId}`);
      this.server.emit('getOnlineUser', [...this.onlineUsers]);
    }
  }

  @SubscribeMessage('mark_notification_read')
  async handleMarkNotificationRead(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { notificationId: string },
  ): Promise<void> {
    const userId = client.data?.userId as string;
    const result = await this.notificationsService.markNotificationRead(payload.notificationId);
    if (userId) {
      if (result.success) {
        this.server.to(`user:${userId}`).emit('notification:read', { success: true, message: 'Notification marked as read' });
      } else {
        this.server.to(`user:${userId}`).emit('notification:read', { success: false, message: 'Failed to mark notification as read' });
      }
    }
  }

  /** Emit a VC pool event to a specific user */
  emitPoolEvent(userId: string, event: string, data: Record<string, any>): void {
    if (!this.server) return;
    try {
      this.server.to(`user:${userId}`).emit(event, data);
    } catch (error) {
      this.logger.warn(`Failed to emit ${event} to user ${userId}: ${error}`);
    }
  }

  emitNotificationCount(userId: string, count: number , payload: any): void {
    if (!this.server) return; // server not initialised yet (e.g. called during bootstrap)
    try {
      this.server.to(`user:${userId}`).emit('notification:count', { count, payload });
    } catch (error) {
      console.log('error in emitNotificationCount', error);
    }
  }
}