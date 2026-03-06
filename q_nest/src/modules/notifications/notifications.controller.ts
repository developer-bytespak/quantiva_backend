import { Controller, Get, Post, Body, Param, Req } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { FirebaseService } from 'src/firebase/firebase.service';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService,
    private readonly firebaseService: FirebaseService,
  ) {}

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
  async send(@Body() body: { token: string; title: string; body: string }) {
    return this.notificationsService.sendNotification(
      body.token,
      body.title,
      body.body
    );
  }
}

