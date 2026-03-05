import { Controller, Get, Post, Body, Param, Req } from '@nestjs/common';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  getUserNotifications(@Req() req: any) {
    const userId = req.subscriptionUser?.user_id;
    return this.notificationsService.getUserNotifications(userId);
  }
  @Get("unread")  
  async getUnreadNotifications(@Req() req: any) {
    const userId = req.subscriptionUser?.user_id;
    return this.notificationsService.getUnreadNotificationsCount(userId);
  }

  @Post('send')
  sendNotification(@Body() notificationDto: { userId: string; message: string; type?: string }) {
    return this.notificationsService.sendNotification(
      notificationDto.userId,
      notificationDto.message,
      notificationDto.type,
    );
  }
}

