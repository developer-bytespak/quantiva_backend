import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { PoolManagementService } from '../services/pool-management.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { TierAccessGuard } from '../../../common/guards/tier-access.guard';
import { AllowTier } from '../../../common/decorators/allow-tier.decorator';

@Controller('api/vc-pools')
@UseGuards(JwtAuthGuard, TierAccessGuard)
export class UserPoolController {
  constructor(private readonly poolService: PoolManagementService) {}

  @Get('available')
  @AllowTier('ELITE')
  async getAvailablePools(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.poolService.getAvailablePools({
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get(':id')
  @AllowTier('ELITE')
  async getPoolDetails(@Param('id', ParseUUIDPipe) id: string) {
    return this.poolService.getPoolForUser(id);
  }
}
