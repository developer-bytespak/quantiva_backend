import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminJwtAuthGuard } from '../../admin-auth/guards/admin-jwt-auth.guard';
import { SuperAdminGuard } from '../../admin-auth/guards/super-admin.guard';
import {
  CurrentAdmin,
} from '../../admin-auth/decorators/current-admin.decorator';
import { AdminTokenPayload } from '../../admin-auth/services/admin-token.service';
import {
  AffiliateAdminService,
  ListAffiliatesFilters,
} from '../services/affiliate-admin.service';
import { ApproveApplicationDto } from '../dto/approve-application.dto';
import { RejectApplicationDto } from '../dto/reject-application.dto';
import { RequestInfoDto } from '../dto/request-info.dto';
import { SetCommissionRateDto } from '../dto/set-commission-rate.dto';
import { AdjustBalanceDto } from '../dto/adjust-balance.dto';
import { AddNoteDto } from '../dto/add-note.dto';
import { UpdateProgramSettingsDto } from '../dto/update-program-settings.dto';
import { MarkPayoutPaidDto } from '../dto/mark-payout-paid.dto';
import { DeleteAffiliateDto } from '../dto/delete-affiliate.dto';
import { SimulateSubscriptionPaymentDto } from '../dto/simulate-subscription-payment.dto';

@UseGuards(AdminJwtAuthGuard, SuperAdminGuard)
@Controller('admin/super-admin/affiliates')
export class AffiliateAdminController {
  constructor(private affiliateAdminService: AffiliateAdminService) {}

  // ── List + applications ──

  @Get()
  list(@Query() filters: ListAffiliatesFilters) {
    return this.affiliateAdminService.listAffiliates(filters);
  }

  @Get('export')
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="affiliates.csv"')
  exportCsv(@Query() filters: ListAffiliatesFilters) {
    return this.affiliateAdminService.exportAffiliatesCSV(filters);
  }

  @Get('applications')
  listApplications(
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
  ) {
    return this.affiliateAdminService.listApplications({
      status,
      page: page ? Number(page) : undefined,
      page_size: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get('applications/:id')
  getApplication(@Param('id') id: string) {
    return this.affiliateAdminService.getApplication(id);
  }

  @Post('applications/:id/approve')
  approve(
    @Param('id') id: string,
    @Body() dto: ApproveApplicationDto,
    @CurrentAdmin() admin: AdminTokenPayload,
  ) {
    return this.affiliateAdminService.approveApplication(id, dto, admin.sub);
  }

  @Post('applications/:id/reject')
  reject(
    @Param('id') id: string,
    @Body() dto: RejectApplicationDto,
    @CurrentAdmin() admin: AdminTokenPayload,
  ) {
    return this.affiliateAdminService.rejectApplication(id, dto, admin.sub);
  }

  @Post('applications/:id/request-info')
  requestInfo(
    @Param('id') id: string,
    @Body() dto: RequestInfoDto,
    @CurrentAdmin() admin: AdminTokenPayload,
  ) {
    return this.affiliateAdminService.requestInfoOnApplication(
      id,
      dto,
      admin.sub,
    );
  }

  // ── Payouts (must be declared before `:id/*` to avoid route shadowing) ──

  @Get('payouts')
  listPayouts(
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
  ) {
    return this.affiliateAdminService.listAllPayouts({
      status,
      page: page ? Number(page) : undefined,
      page_size: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Post('payouts/run')
  runPayoutBatch(@CurrentAdmin() admin: AdminTokenPayload) {
    return this.affiliateAdminService.generatePayoutBatch(admin.sub);
  }

  @Post('payouts/:id/mark-paid')
  markPayoutPaid(
    @Param('id') id: string,
    @Body() dto: MarkPayoutPaidDto,
    @CurrentAdmin() admin: AdminTokenPayload,
  ) {
    return this.affiliateAdminService.markPayoutPaid(id, dto, admin.sub);
  }

  // ── Program settings ──

  @Get('settings')
  getSettings() {
    return this.affiliateAdminService.getProgramSettings();
  }

  @Put('settings')
  updateSettings(
    @Body() dto: UpdateProgramSettingsDto,
    @CurrentAdmin() admin: AdminTokenPayload,
  ) {
    return this.affiliateAdminService.updateProgramSettings(dto, admin.sub);
  }

  // ── Testing helpers ── (declared before `:id` routes to avoid shadowing)

  /**
   * Super-admin-only test endpoint that fires a fabricated subscription
   * payment for a real user. Runs the exact same code path the live Stripe
   * `checkout.session.completed` webhook hits, including affiliate commission
   * accrual. Used to verify the affiliate flow end-to-end without Stripe.
   */
  @Post('test/simulate-subscription-payment')
  simulateSubscriptionPayment(
    @Body() dto: SimulateSubscriptionPaymentDto,
    @CurrentAdmin() admin: AdminTokenPayload,
  ) {
    return this.affiliateAdminService.simulateSubscriptionPayment(
      dto,
      admin.sub,
    );
  }

  // ── Per-affiliate detail + actions ──

  @Get(':id')
  getDetail(@Param('id') id: string) {
    return this.affiliateAdminService.getAffiliateDetail(id);
  }

  @Get(':id/referrals')
  getReferrals(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
  ) {
    return this.affiliateAdminService.getAffiliateReferrals(
      id,
      page ? Number(page) : 1,
      pageSize ? Number(pageSize) : 20,
    );
  }

  @Get(':id/transactions')
  getTransactions(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
  ) {
    return this.affiliateAdminService.getAffiliateTransactions(
      id,
      page ? Number(page) : 1,
      pageSize ? Number(pageSize) : 50,
    );
  }

  @Get(':id/payouts')
  getAffiliatePayoutHistory(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
  ) {
    return this.affiliateAdminService.getAffiliatePayouts(
      id,
      page ? Number(page) : 1,
      pageSize ? Number(pageSize) : 20,
    );
  }

  @Get(':id/audit-log')
  getAuditLog(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
  ) {
    return this.affiliateAdminService.getAffiliateAuditLog(
      id,
      page ? Number(page) : 1,
      pageSize ? Number(pageSize) : 50,
    );
  }

  @Post(':id/pause')
  pause(
    @Param('id') id: string,
    @CurrentAdmin() admin: AdminTokenPayload,
    @Body('reason') reason?: string,
  ) {
    return this.affiliateAdminService.setStatus(
      id,
      'PAUSED',
      admin.sub,
      reason,
    );
  }

  @Post(':id/suspend')
  suspend(
    @Param('id') id: string,
    @CurrentAdmin() admin: AdminTokenPayload,
    @Body('reason') reason?: string,
  ) {
    return this.affiliateAdminService.setStatus(
      id,
      'SUSPENDED',
      admin.sub,
      reason,
    );
  }

  @Post(':id/resume')
  resume(
    @Param('id') id: string,
    @CurrentAdmin() admin: AdminTokenPayload,
    @Body('reason') reason?: string,
  ) {
    return this.affiliateAdminService.setStatus(
      id,
      'APPROVED',
      admin.sub,
      reason,
    );
  }

  @Post(':id/reset-code')
  resetCode(
    @Param('id') id: string,
    @Body('referral_code') newCode: string,
    @CurrentAdmin() admin: AdminTokenPayload,
  ) {
    return this.affiliateAdminService.resetReferralCode(
      id,
      newCode,
      admin.sub,
    );
  }

  @Post(':id/commission-rate')
  setCommissionRate(
    @Param('id') id: string,
    @Body() dto: SetCommissionRateDto,
    @CurrentAdmin() admin: AdminTokenPayload,
  ) {
    return this.affiliateAdminService.setCommissionRate(id, dto, admin.sub);
  }

  @Post(':id/adjust-balance')
  adjustBalance(
    @Param('id') id: string,
    @Body() dto: AdjustBalanceDto,
    @CurrentAdmin() admin: AdminTokenPayload,
  ) {
    return this.affiliateAdminService.adjustBalance(id, dto, admin.sub);
  }

  @Post(':id/notes')
  addNote(
    @Param('id') id: string,
    @Body() dto: AddNoteDto,
    @CurrentAdmin() admin: AdminTokenPayload,
  ) {
    return this.affiliateAdminService.addNote(id, dto, admin.sub);
  }

  /**
   * Permanently delete an affiliate + every related row (sessions,
   * application, referrals, commission events, payouts, audit log).
   *
   * Refuses if there's any unpaid money: pending_balance > 0, or any
   * PENDING/PROCESSING/FAILED payouts, or any ACCRUED/HELD commission events.
   *
   * Returns 409 on those failures (clear message naming the blocker) and 200
   * on success with a summary of what was removed.
   */
  @Delete(':id')
  deleteAffiliate(
    @Param('id') id: string,
    @Body() dto: DeleteAffiliateDto,
    @CurrentAdmin() admin: AdminTokenPayload,
  ) {
    return this.affiliateAdminService.deleteAffiliate(
      id,
      admin.sub,
      dto?.confirm_display_name,
    );
  }
}
