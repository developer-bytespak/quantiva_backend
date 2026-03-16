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

@WebSocketGateway({
  cors: {
    origin: '*',
    credentials: true,
  },
})
export class AppGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(AppGateway.name);
  private readonly onlineUsers = new Set<string>();

  constructor(private readonly notificationsService: NotificationsService) {}

  async handleConnection(client: Socket): Promise<void> {
    const userId = (client.handshake?.query?.userId as string)?.trim();
    client.data.userId = userId;
    this.logger.log(`AppGateway handleConnection ${userId}`);

    client.join(`user:${userId}`);

    client.emit('connection:status', {
      connected: true,
      userId: userId ?? null,
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

  emitNotificationCount(userId: string, count: number , payload: any): void {
    if (!this.server) return; // server not initialised yet (e.g. called during bootstrap)
    try {
      this.server.to(`user:${userId}`).emit('notification:count', { count, payload });
    } catch (error) {
      console.log('error in emitNotificationCount', error);
    }
  }
}