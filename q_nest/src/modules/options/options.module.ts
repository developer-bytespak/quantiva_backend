import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { OptionsController } from './options.controller';
import { OptionsService } from './services/options.service';
import { OptionsBinanceService } from './services/options-binance.service';
import { OptionsIvService } from './services/options-iv.service';
import { OptionsSignalService } from './services/options-signal.service';
import { OptionsGateway } from './options.gateway';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { ExchangesModule } from '../exchanges/exchanges.module';

@Module({
  imports: [ConfigModule, PrismaModule, AuthModule, ExchangesModule],
  controllers: [OptionsController],
  providers: [OptionsService, OptionsBinanceService, OptionsGateway, OptionsIvService, OptionsSignalService],
  exports: [OptionsService, OptionsBinanceService, OptionsIvService, OptionsSignalService],
})
export class OptionsModule {}
