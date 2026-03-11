import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { NotificationsService } from 'src/modules/notifications/notifications.service';

export class AppGateway {
  private readonly logger = new Logger(AppGateway.name);
  private readonly onlineUsers = new Set<string>();
  private server: Server;

  constructor(private readonly notificationsService: NotificationsService) {}

  init(server: Server): void {
    this.server = server;

    this.server.on('connection', (client: Socket) => {
      this.handleConnection(client);

      client.on('mark_notification_read', async (payload: { notificationId: string }) => {
        const userId = client.data?.userId as string;
        const result = await this.notificationsService.markNotificationRead(payload.notificationId);
        if (userId) {
          if (result.success) {
            this.server.to(`user:${userId}`).emit('notification:read', { success: true, message: 'Notification marked as read' });
          } else {
            this.server.to(`user:${userId}`).emit('notification:read', { success: false, message: 'Failed to mark notification as read' });
          }
        }
      });

      client.on('disconnect', () => {
        this.handleDisconnect(client);
      });
    });

    this.logger.log('Socket.IO server initialized');
  }

  private async handleConnection(client: Socket): Promise<void> {
    const userId = (client.handshake?.query?.userId as string)?.trim();
    client.data.userId = userId;
    console.log('AppGateway handleConnection', userId);

    client.join(`user:${userId}`);

    const rooms = client.rooms;
    console.log("Rooms joined:", rooms);

    client.emit('connection:status', {
      connected: true,
      userId: userId ?? null,
      socketId: client.id,
      onlineUsers: [...this.onlineUsers],
    });

  }

  private handleDisconnect(client: Socket): void {
    const userId = client.data?.userId as string;

    if (userId && this.onlineUsers.delete(userId)) {
      this.logger.log(`Disconnected: ${client.id} | User: ${userId}`);
      this.server.emit('getOnlineUser', [...this.onlineUsers]);
    }
  }
  emitNotificationCount(userId: string, count: number , payload: any): void {
    if (!this.server) return; // server not initialised yet (e.g. called during bootstrap)
    try {
     this.server.to(`user:${userId}`).emit('notification:count', { count, payload });
    } catch (error) {
      console.log("error in emitNotificationCount",error)
    }
  }
}