import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { MacroService } from './macro.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { KycModule } from '../../kyc/kyc.module';

@Module({
  imports: [PrismaModule, KycModule, ScheduleModule],
  providers: [MacroService],
  exports: [MacroService],
})
export class MacroModule {}

