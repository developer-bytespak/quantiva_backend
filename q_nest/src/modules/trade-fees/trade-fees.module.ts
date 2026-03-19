import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { StripeModule } from '../stripe/stripe.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { TradeFeesService } from './trade-fees.service';
import { TradeFeesController } from './trade-fees.controller';

@Module({
  imports: [PrismaModule, forwardRef(() => StripeModule), forwardRef(() => AdminAuthModule)],
  controllers: [TradeFeesController],
  providers: [TradeFeesService],
  exports: [TradeFeesService],
})
export class TradeFeesModule {}
