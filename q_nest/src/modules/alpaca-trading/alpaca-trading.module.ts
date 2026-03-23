import { Module } from '@nestjs/common';
import { ExchangesModule } from '../exchanges/exchanges.module';
import { AlpacaTradingService } from './alpaca-trading.service';
import { AlpacaTradingController } from './alpaca-trading.controller';

@Module({
  imports: [ExchangesModule],
  providers: [AlpacaTradingService],
  controllers: [AlpacaTradingController],
})
export class AlpacaTradingModule {}
