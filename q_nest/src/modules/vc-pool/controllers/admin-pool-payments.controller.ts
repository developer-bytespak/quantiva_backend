import {
  Controller,
  Get,
  Put,
  Param,
  Query,
  Body,
  UseGuards,
  ParseUUIDPipe,
  BadRequestException,
} from '@nestjs/common';
import { PaymentReviewService } from '../services/payment-review.service';
import { AdminJwtAuthGuard } from '../../admin-auth/guards/admin-jwt-auth.guard';
import { CurrentAdmin } from '../../admin-auth/decorators/current-admin.decorator';
import { AdminTokenPayload } from '../../admin-auth/services/admin-token.service';

@Controller('admin/pools')
@UseGuards(AdminJwtAuthGuard)
export class AdminPoolPaymentsController {
  constructor(private readonly reviewService: PaymentReviewService) {}

  @Get(':poolId/payments')
  async listPayments(
    @CurrentAdmin() admin: AdminTokenPayload,
    @Param('poolId', ParseUUIDPipe) poolId: string,
    @Query('status') status?: string,
    @Query('payment_method') paymentMethod?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.reviewService.listPayments(admin.sub, poolId, {
      status,
      payment_method: paymentMethod,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get(':poolId/reservations')
  async listReservations(
    @CurrentAdmin() admin: AdminTokenPayload,
    @Param('poolId', ParseUUIDPipe) poolId: string,
  ) {
    return this.reviewService.listReservations(admin.sub, poolId);
  }

  @Get(':poolId/members')
  async listMembers(
    @CurrentAdmin() admin: AdminTokenPayload,
    @Param('poolId', ParseUUIDPipe) poolId: string,
  ) {
    return this.reviewService.listMembers(admin.sub, poolId);
  }

  @Put(':poolId/payments/:submissionId/approve')
  async approvePayment(
    @CurrentAdmin() admin: AdminTokenPayload,
    @Param('poolId', ParseUUIDPipe) poolId: string,
    @Param('submissionId', ParseUUIDPipe) submissionId: string,
    @Body() body: { admin_notes?: string },
  ) {
    return this.reviewService.approvePayment(
      admin.sub,
      poolId,
      submissionId,
      body?.admin_notes,
    );
  }

  @Put(':poolId/payments/:submissionId/reject')
  async rejectPayment(
    @CurrentAdmin() admin: AdminTokenPayload,
    @Param('poolId', ParseUUIDPipe) poolId: string,
    @Param('submissionId', ParseUUIDPipe) submissionId: string,
    @Body() body: { rejection_reason: string },
  ) {
    if (!body?.rejection_reason) {
      throw new BadRequestException('rejection_reason is required');
    }
    return this.reviewService.rejectPayment(
      admin.sub,
      poolId,
      submissionId,
      body.rejection_reason,
    );
  }
}
