import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { FirebaseService } from 'src/firebase/firebase.service';

@Injectable()
export class NotificationsService {
  constructor(private prisma: PrismaService, private firebaseService: FirebaseService,
    private PrismaService: PrismaService,
  ) {}

  // Note: This is a placeholder service as there's no notifications table in the schema
  // You may need to add a notifications model to your Prisma schema
  async sendNotification(fcm_token: string="eQuLh1jv1PEdrgbSdQMWHQ:APA91bGGyVPKfUGWl4YHW7e6xAea-vfUtTl-60iOHHUjjir_o_SpBmjQ0aHEPMJQPQXQLnDKV5MFFp-kOMsQ8VIMtK3jZZenKdHz3dysib1RN7cUf8e_2r0",title: string, body: string) {
    try {
      const messaging = this.firebaseService.getMessaging();
      if(!fcm_token) {
        return { success: false, message: 'FCM token is required' };
      }
      const message = {
        token: fcm_token,
        notification: { title, body },
      };
      return await messaging.send(message);
    } catch (err) {
      console.warn('[NotificationsService] FCM send failed:', err?.message || err);
      throw err;
    }
  }

  async getUserNotifications(userId: string) {
    const notifications = await this.prisma.notifications.findMany({
      where: {
        user_id: userId,
      },
    });

    await this.prisma.notifications.updateMany({
      where: {
        user_id: userId,
        read: false,
      },
      data: { read: true, read_at: new Date() },
    });
    return notifications;
  }

  async createNotification(data: any) {
    const notification = await this.prisma.notifications.create({
      data: data,
    });
    return notification;
  }

  async markNotificationRead(notificationId: string) {
    try {
      await this.prisma.notifications.update({
        where: { id: notificationId },
        data: { read: true, read_at: new Date() },
      });
      return { success: true, message: 'Notification marked as read' };
    } catch (error) {
      return { success: false, message: 'Failed to mark notification as read' };
    }
  }

  async getUnreadNotificationsCount(userId: string) {
    const count = await this.prisma.notifications.count({
      where: {
        user_id: userId,
        read: false,
      },
    });
    return count;
  }

  async fcmNotification(token: string, userId: string) {
    try {
      const user = await this.PrismaService.users.update({
        where: { user_id: userId },
        data: { fcm_token: token },
      }) ;
      return { success: true, message: 'FCM token updated', user: user };
    } catch (err) {
      console.warn('[NotificationsService] FCM send failed:', err?.message || err);
      return { success: false, message: 'Failed to send notification' };
    }
  }
}

