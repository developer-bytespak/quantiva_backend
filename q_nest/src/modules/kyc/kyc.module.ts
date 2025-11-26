import { Module } from '@nestjs/common';
import { KycController } from './kyc.controller';
import { KycService } from './kyc.service';

@Module({
  controllers: [KycController],
  providers: [KycService],
  exports: [KycService],
})
export class KycModule {}

