import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get(':userId')
  getUserNotifications(@Param('userId') userId: string) {
    return this.notificationsService.getUserNotifications(userId);
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

