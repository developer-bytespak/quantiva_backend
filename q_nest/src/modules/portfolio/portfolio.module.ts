import { Module, forwardRef } from '@nestjs/common';
import { PortfolioController } from './portfolio.controller';
import { PortfolioService } from './portfolio.service';
import { PositionSyncService } from './position-sync.service';
import { BinanceTestnetModule } from '../binance-testnet/binance-testnet.module';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule, forwardRef(() => BinanceTestnetModule)],
  controllers: [PortfolioController],
  providers: [PortfolioService, PositionSyncService],
  exports: [PortfolioService, PositionSyncService],
})
export class PortfolioModule {}

