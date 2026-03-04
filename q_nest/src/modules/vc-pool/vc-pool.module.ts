import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '../../prisma/prisma.module';
import { StorageModule } from '../../storage/storage.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { BinanceModule } from '../binance/binance.module';
import { ExchangesModule } from '../exchanges/exchanges.module';
import { AdminPoolController } from './controllers/admin-pool.controller';
import { AdminPoolPaymentsController } from './controllers/admin-pool-payments.controller';
import { AdminPoolTradesController } from './controllers/admin-pool-trades.controller';
import { UserPoolController } from './controllers/user-pool.controller';
import { PoolManagementService } from './services/pool-management.service';
import { SeatReservationService } from './services/seat-reservation.service';
import { ScreenshotUploadService } from './services/screenshot-upload.service';
import { PaymentReviewService } from './services/payment-review.service';
import { PoolTradingService } from './services/pool-trading.service';
import { PoolValueService } from './services/pool-value.service';
import { PoolCancellationService } from './services/pool-cancellation.service';
import { PoolPayoutService } from './services/pool-payout.service';
import { SeatExpiryScheduler } from './schedulers/seat-expiry.scheduler';
import { PoolValueUpdateScheduler } from './schedulers/pool-value-update.scheduler';
import { FeatureAccessService } from '../../common/feature-access.service';
import { TierAccessGuard } from '../../common/guards/tier-access.guard';

@Module({
  imports: [PrismaModule, StorageModule, AdminAuthModule, BinanceModule, ExchangesModule, ScheduleModule],
  controllers: [
    AdminPoolController,
    AdminPoolPaymentsController,
    AdminPoolTradesController,
    UserPoolController,
  ],
  providers: [
    PoolManagementService,
    SeatReservationService,
    ScreenshotUploadService,
    PaymentReviewService,
    PoolTradingService,
    PoolValueService,
    PoolCancellationService,
    PoolPayoutService,
    SeatExpiryScheduler,
    PoolValueUpdateScheduler,
    FeatureAccessService,
    TierAccessGuard,
  ],
  exports: [PoolManagementService, SeatReservationService, PoolTradingService],
})
export class VcPoolModule {}
