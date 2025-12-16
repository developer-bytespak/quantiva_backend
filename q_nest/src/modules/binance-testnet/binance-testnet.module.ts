import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BinanceTestnetController } from './binance-testnet.controller';
import { BinanceTestnetService } from './services/binance-testnet.service';
import { TestnetCacheService } from './services/testnet-cache.service';
import { BinanceTestnetService as BinanceTestnetApiService } from './integrations/binance-testnet.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [ConfigModule, AuthModule],
  controllers: [BinanceTestnetController],
  providers: [
    BinanceTestnetService,
    TestnetCacheService,
    BinanceTestnetApiService,
  ],
  exports: [BinanceTestnetService, TestnetCacheService],
})
export class BinanceTestnetModule {}
