import { Module, Global } from '@nestjs/common';
import { AppGateway } from './app.gateway';
import { WsAuthService } from './ws-auth.service';
import { NotificationsModule } from '../modules/notifications/notifications.module';

@Global()
@Module({
  imports: [NotificationsModule],
  providers: [AppGateway, WsAuthService],
  exports: [AppGateway, WsAuthService],
})
export class GatewaysModule {}
