import { Module, forwardRef } from '@nestjs/common';
import { SignalsController } from './signals.controller';
import { SignalsService } from './signals.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { KycModule } from '../../kyc/kyc.module';
import { StrategiesModule } from '../strategies/strategies.module';

@Module({
  imports: [PrismaModule, KycModule, forwardRef(() => StrategiesModule)],
  controllers: [SignalsController],
  providers: [SignalsService],
  exports: [SignalsService],
})
export class SignalsModule {}

