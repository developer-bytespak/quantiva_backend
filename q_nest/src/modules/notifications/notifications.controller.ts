import { Controller, Get, Post, Body, UseGuards, Param, Req, Delete } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { FirebaseService } from 'src/firebase/firebase.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { TokenPayload } from '../auth/services/token.service';

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService,
    private readonly firebaseService: FirebaseService,
  ) {}

  @Get()
  getUserNotifications(@CurrentUser() user: TokenPayload) {
    return this.notificationsService.getUserNotifications(user.sub);
  }
  @Get("unread")  
  async getUnreadNotifications(@CurrentUser() user: TokenPayload) {
    return this.notificationsService.getUnreadNotificationsCount(user.sub);
  }

  @Post('send')
  async send(@Body() body: { token: string; title: string; body: string }, @Req() req: any) {
    const userId = "f96b2562-ff2b-4f22-a5c7-fc3fe56491f1"
    if (!userId) {
      return { success: false, message: 'User not authenticated' };
    }
    return this.notificationsService.sendNotification(
      userId,
      body.title,
      body.body
    );
  }

  @Delete('delete/:id')
  async deleteNotification(@Param('id') id: string) {
    return this.notificationsService.deleteNotification(id);
  }

  @Delete('delete')
  async deleteAllNotifications(@Req() req: any) {
    console.log("req-->",req)
    const userId = req.subscriptionUser?.user_id;
    return this.notificationsService.deleteAllNotifications(userId);
  }

  @Post('FCM')
  async fcmNotification(@Body() body: { token:string}, @Req() req: any) {
    const userId = req.subscriptionUser?.user_id;
    return this.notificationsService.fcmNotification(body.token, userId);
  }
}

