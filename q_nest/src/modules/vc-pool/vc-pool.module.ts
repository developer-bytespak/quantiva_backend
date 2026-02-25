import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { AdminPoolController } from './controllers/admin-pool.controller';
import { UserPoolController } from './controllers/user-pool.controller';
import { PoolManagementService } from './services/pool-management.service';
import { FeatureAccessService } from '../../common/feature-access.service';
import { TierAccessGuard } from '../../common/guards/tier-access.guard';

@Module({
  imports: [PrismaModule, AdminAuthModule],
  controllers: [AdminPoolController, UserPoolController],
  providers: [PoolManagementService, FeatureAccessService, TierAccessGuard],
  exports: [PoolManagementService],
})
export class VcPoolModule {}
