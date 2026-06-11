import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { OptionsController } from './options.controller';
import { OptionsService } from './services/options.service';
import { OptionsBinanceService } from './services/options-binance.service';
import { OptionsBinanceStreamService } from './services/options-binance-stream.service';
import { OptionsAlpacaService } from './services/options-alpaca.service';
import { OptionsIvService } from './services/options-iv.service';
import { OptionsSignalService } from './services/options-signal.service';
import { OptionsRiskService } from './services/options-risk.service';
import { OptionsGateway } from './options.gateway';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { ExchangesModule } from '../exchanges/exchanges.module';
import { TradeFeesModule } from '../trade-fees/trade-fees.module';
import { StocksMarketModule } from '../stocks-market/stocks-market.module';

@Module({
  imports: [ConfigModule, PrismaModule, AuthModule, forwardRef(() => ExchangesModule), TradeFeesModule, StocksMarketModule],
  controllers: [OptionsController],
  providers: [OptionsService, OptionsBinanceService, OptionsBinanceStreamService, OptionsAlpacaService, OptionsGateway, OptionsIvService, OptionsSignalService, OptionsRiskService],
  exports: [OptionsService, OptionsBinanceService, OptionsBinanceStreamService, OptionsAlpacaService, OptionsIvService, OptionsSignalService, OptionsRiskService],
})
export class OptionsModule {}
