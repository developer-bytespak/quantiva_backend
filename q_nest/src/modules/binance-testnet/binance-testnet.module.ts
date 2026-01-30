import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BinanceTestnetController } from './binance-testnet.controller';
import { BinanceTestnetService } from './services/binance-testnet.service';
import { TestnetCacheService } from './services/testnet-cache.service';
import { BinanceTestnetService as BinanceTestnetApiService } from './integrations/binance-testnet.service';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../../prisma/prisma.module';

// Crypto Auto Trading Services
import {
  CryptoAutoTradingSessionService,
  CryptoAutoTradingExecutionService,
  CryptoAutoTradingCronService,
  CryptoAutoTradingStatsService,
  CryptoAutoTradingController,
} from './services/auto-trading';

@Module({
  imports: [
    ConfigModule,
    AuthModule,
    PrismaModule,
  ],
  controllers: [
    BinanceTestnetController,
    CryptoAutoTradingController,
  ],
  providers: [
    BinanceTestnetService,
    TestnetCacheService,
    BinanceTestnetApiService,
    // Crypto Auto Trading
    CryptoAutoTradingSessionService,
    CryptoAutoTradingExecutionService,
    CryptoAutoTradingCronService,
    CryptoAutoTradingStatsService,
  ],
  exports: [
    BinanceTestnetService,
    TestnetCacheService,
    CryptoAutoTradingSessionService,
    CryptoAutoTradingStatsService,
  ],
})
export class BinanceTestnetModule {}
