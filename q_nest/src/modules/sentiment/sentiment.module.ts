import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SentimentEmaService } from './sentiment-ema.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { KycModule } from '../../kyc/kyc.module';

@Module({
  imports: [PrismaModule, KycModule, ScheduleModule],
  providers: [SentimentEmaService],
  exports: [SentimentEmaService],
})
export class SentimentModule {}

