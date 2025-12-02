import { Module } from '@nestjs/common';
import { SignalsController } from './signals.controller';
import { SignalsService } from './signals.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { KycModule } from '../../kyc/kyc.module';

@Module({
  imports: [PrismaModule, KycModule],
  controllers: [SignalsController],
  providers: [SignalsService],
  exports: [SignalsService],
})
export class SignalsModule {}

