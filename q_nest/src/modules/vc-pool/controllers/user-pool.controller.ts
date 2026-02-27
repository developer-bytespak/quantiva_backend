import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  ParseUUIDPipe,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { PoolManagementService } from '../services/pool-management.service';
import { SeatReservationService } from '../services/seat-reservation.service';
import { ScreenshotUploadService } from '../services/screenshot-upload.service';
import { PoolCancellationService } from '../services/pool-cancellation.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { TierAccessGuard } from '../../../common/guards/tier-access.guard';
import { AllowTier } from '../../../common/decorators/allow-tier.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { TokenPayload } from '../../auth/services/token.service';
import { JoinPoolDto } from '../dto/join-pool.dto';

const screenshotUploadOptions = {
  storage: memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req: any, file: any, cb: any) => {
    if (!file.mimetype.match(/^image\/(jpeg|png|gif|webp)$/)) {
      cb(new BadRequestException('Only image files (jpeg, png, gif, webp) are allowed'), false);
    } else {
      cb(null, true);
    }
  },
};

@Controller('api/vc-pools')
@UseGuards(JwtAuthGuard, TierAccessGuard)
export class UserPoolController {
  constructor(
    private readonly poolService: PoolManagementService,
    private readonly seatService: SeatReservationService,
    private readonly screenshotService: ScreenshotUploadService,
    private readonly cancellationService: PoolCancellationService,
  ) {}

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

  @Get('my-pools')
  @AllowTier('ELITE')
  async getMyPools(@CurrentUser() user: TokenPayload) {
    return this.cancellationService.getMyPools(user.sub);
  }

  @Get(':id')
  @AllowTier('ELITE')
  async getPoolDetails(@Param('id', ParseUUIDPipe) id: string) {
    return this.poolService.getPoolForUser(id);
  }

  @Post(':id/join')
  @AllowTier('ELITE')
  async joinPool(
    @CurrentUser() user: TokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: JoinPoolDto,
  ) {
    return this.seatService.joinPool(user.sub, id, dto);
  }

  @Get(':id/payment-status')
  @AllowTier('ELITE')
  async getPaymentStatus(
    @CurrentUser() user: TokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.seatService.getPaymentStatus(user.sub, id);
  }

  @Post(':id/upload-screenshot')
  @AllowTier('ELITE')
  @UseInterceptors(FileInterceptor('screenshot', screenshotUploadOptions))
  async uploadScreenshot(
    @CurrentUser() user: TokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('Screenshot file is required');
    }
    return this.screenshotService.uploadScreenshot(user.sub, id, file);
  }

  @Post(':id/cancel-membership')
  @AllowTier('ELITE')
  async cancelMembership(
    @CurrentUser() user: TokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.cancellationService.requestCancellation(user.sub, id);
  }

  @Get(':id/my-cancellation')
  @AllowTier('ELITE')
  async getMyCancellation(
    @CurrentUser() user: TokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.cancellationService.getMyCancellation(user.sub, id);
  }
}
