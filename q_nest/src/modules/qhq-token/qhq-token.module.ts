import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '../../prisma/prisma.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { QhqTokenService } from './qhq-token.service';
import { QhqTokenChainService } from './qhq-token-chain.service';
import { QhqTokenController } from './qhq-token.controller';
import { QhqTokenAdminController } from './qhq-token-admin.controller';
import { QhqTokenProcessor, QHQ_QUEUE } from './qhq-token.processor';

@Module({
  imports: [
    PrismaModule,
    AdminAuthModule,
    ScheduleModule,
    ConfigModule,
    BullModule.registerQueue({ name: QHQ_QUEUE }),
  ],
  controllers: [QhqTokenController, QhqTokenAdminController],
  providers: [QhqTokenService, QhqTokenChainService, QhqTokenProcessor],
  exports: [QhqTokenService],
})
export class QhqTokenModule {}
