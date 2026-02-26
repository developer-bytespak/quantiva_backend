import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '../../prisma/prisma.module';
import { StorageModule } from '../../storage/storage.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { AdminPoolController } from './controllers/admin-pool.controller';
import { AdminPoolPaymentsController } from './controllers/admin-pool-payments.controller';
import { UserPoolController } from './controllers/user-pool.controller';
import { PoolManagementService } from './services/pool-management.service';
import { SeatReservationService } from './services/seat-reservation.service';
import { ScreenshotUploadService } from './services/screenshot-upload.service';
import { PaymentReviewService } from './services/payment-review.service';
import { SeatExpiryScheduler } from './schedulers/seat-expiry.scheduler';
import { FeatureAccessService } from '../../common/feature-access.service';
import { TierAccessGuard } from '../../common/guards/tier-access.guard';

@Module({
  imports: [PrismaModule, StorageModule, AdminAuthModule, ScheduleModule],
  controllers: [
    AdminPoolController,
    AdminPoolPaymentsController,
    UserPoolController,
  ],
  providers: [
    PoolManagementService,
    SeatReservationService,
    ScreenshotUploadService,
    PaymentReviewService,
    SeatExpiryScheduler,
    FeatureAccessService,
    TierAccessGuard,
  ],
  exports: [PoolManagementService, SeatReservationService],
})
export class VcPoolModule {}
