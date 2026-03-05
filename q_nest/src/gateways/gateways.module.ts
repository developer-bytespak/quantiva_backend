import { Module, Global } from '@nestjs/common';
import { AppGateway } from './app.gateway';
import { NotificationsModule } from '../modules/notifications/notifications.module';

@Global()
@Module({
  imports: [NotificationsModule],
  providers: [AppGateway],
  exports: [AppGateway],
})
export class GatewaysModule {}
