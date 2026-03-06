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
  async sendNotification(userId: string,title: string, body: string) {
    try {
      const messaging = this.firebaseService.getMessaging();
      if(!userId) {
        return { success: false, message: 'FCM token is required' };
      }

      const fcm_token = await this.PrismaService.users.findUnique({
        where: { user_id: userId },
        select: { fcm_token: true },
      });
      console.log("fcm_token",fcm_token)
      if (!fcm_token?.fcm_token) {
        return { success: false, message: 'FCM token not found for user' };
      }
      const message = {
        token: fcm_token.fcm_token,
        notification: { title, body },
      };
      console.log('message-->', message);
      const messageId = await messaging.send(message);
      console.log('[NotificationsService] FCM sent successfully, messageId:', messageId);
      return messageId;
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      const errCode = err?.code;
      console.warn('[NotificationsService] FCM send failed:', errCode, errMsg);
      // Unregistered/invalid token = client needs to re-register FCM token
      if (errCode === 'messaging/invalid-registration-token' || errCode === 'messaging/registration-token-not-registered') {
        return { success: false, message: 'FCM token invalid or expired – re-register from device' };
      }
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

