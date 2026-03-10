import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
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
  async send(@Body() body: { token: string; title: string; body: string }) {
    return this.notificationsService.sendNotification(
      body.token,
      body.title,
      body.body
    );
  }
}

