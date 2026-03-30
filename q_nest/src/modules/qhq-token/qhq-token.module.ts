import { Module, forwardRef } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigModule } from '@nestjs/config';
import { QhqTokenService } from './qhq-token.service';
import { QhqTokenChainService } from './qhq-token-chain.service';
import { QhqTokenController } from './qhq-token.controller';
import { QhqTokenAdminController } from './qhq-token-admin.controller';
import { QhqTokenScheduler } from './qhq-token.scheduler';
import { PrismaModule } from '../../prisma/prisma.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';

@Module({
  imports: [
    PrismaModule,
    forwardRef(() => AdminAuthModule),
    ScheduleModule.forRoot(),
    ConfigModule,
  ],
  controllers: [QhqTokenController, QhqTokenAdminController],
  providers: [QhqTokenService, QhqTokenChainService, QhqTokenScheduler],
  exports: [QhqTokenService],
})
export class QhqTokenModule {}
