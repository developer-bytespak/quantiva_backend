import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AlpacaPaperTradingService } from './alpaca-paper-trading.service';
import { AlpacaPaperTradingController } from './alpaca-paper-trading.controller';

@Module({
  imports: [ConfigModule],
  controllers: [AlpacaPaperTradingController],
  providers: [AlpacaPaperTradingService],
  exports: [AlpacaPaperTradingService],
})
export class AlpacaPaperTradingModule {}

