import { Module, forwardRef } from '@nestjs/common';
import { PortfolioController } from './portfolio.controller';
import { PortfolioService } from './portfolio.service';
import { PositionSyncService } from './position-sync.service';
import { ExchangesModule } from '../exchanges/exchanges.module';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule, forwardRef(() => ExchangesModule)],
  controllers: [PortfolioController],
  providers: [PortfolioService, PositionSyncService],
  exports: [PortfolioService, PositionSyncService],
})
export class PortfolioModule {}

