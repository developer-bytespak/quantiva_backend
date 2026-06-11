import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ExchangesModule } from '../exchanges/exchanges.module';
import { UserHoldingsService } from './user-holdings.service';

@Module({
  imports: [PrismaModule, ExchangesModule],
  providers: [UserHoldingsService],
  exports: [UserHoldingsService],
})
export class UserHoldingsModule {}
