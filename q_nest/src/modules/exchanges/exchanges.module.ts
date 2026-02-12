import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ExchangesController } from './exchanges.controller';
import { PaperTradingController } from './paper-trading.controller';
import { ExchangesService } from './exchanges.service';
import { EncryptionService } from './services/encryption.service';
import { BinanceService } from './integrations/binance.service';
import { BinanceUSService } from './integrations/binance-us.service';
import { BybitService } from './integrations/bybit.service';
import { AlpacaService } from './integrations/alpaca.service';
import { CacheService } from './services/cache.service';
import { ConnectionOwnerGuard } from './guards/connection-owner.guard';
import { BinanceUserWsService } from './services/binance-user-ws.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { MarketModule } from '../market/market.module';

@Module({
  imports: [ConfigModule, PrismaModule, AuthModule, MarketModule],
  controllers: [ExchangesController, /* Health endpoint for paper trading */ PaperTradingController],
  providers: [
    ExchangesService,
    EncryptionService,
    BinanceService,
    BinanceUSService,
    BybitService,
    AlpacaService,
    CacheService,
    ConnectionOwnerGuard,
    BinanceUserWsService,
  ],
  exports: [
    ExchangesService, 
    EncryptionService, 
    BinanceService,
    BinanceUSService,
    BybitService, 
    AlpacaService,
    CacheService,
    BinanceUserWsService,
  ],
})
export class ExchangesModule {}

