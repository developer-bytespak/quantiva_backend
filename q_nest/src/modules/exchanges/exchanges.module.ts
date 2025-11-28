import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ExchangesController } from './exchanges.controller';
import { ExchangesService } from './exchanges.service';
import { EncryptionService } from './services/encryption.service';
import { BinanceService } from './integrations/binance.service';
import { BybitService } from './integrations/bybit.service';
import { CacheService } from './services/cache.service';
import { ConnectionOwnerGuard } from './guards/connection-owner.guard';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [ConfigModule, PrismaModule, AuthModule],
  controllers: [ExchangesController],
  providers: [
    ExchangesService,
    EncryptionService,
    BinanceService,
    BybitService,
    CacheService,
    ConnectionOwnerGuard,
  ],
  exports: [ExchangesService, EncryptionService, BinanceService, BybitService, CacheService],
})
export class ExchangesModule {}

