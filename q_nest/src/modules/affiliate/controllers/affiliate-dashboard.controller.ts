import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AffiliateJwtAuthGuard } from '../guards/affiliate-jwt-auth.guard';
import { AffiliateApprovedGuard } from '../guards/affiliate-approved.guard';
import {
  CurrentAffiliate,
  CurrentAffiliatePayload,
} from '../decorators/current-affiliate.decorator';
import { AffiliateStatsService } from '../services/affiliate-stats.service';
import { AffiliateSettingsService } from '../services/affiliate-settings.service';
import { UpdateAffiliateSettingsDto } from '../dto/update-affiliate-settings.dto';
import { PrismaService } from '../../../prisma/prisma.service';

const ALLOWED_RANGES = [30, 90, 365] as const;
type Range = (typeof ALLOWED_RANGES)[number];

@UseGuards(AffiliateJwtAuthGuard, AffiliateApprovedGuard)
@Controller('affiliate')
export class AffiliateDashboardController {
  constructor(
    private statsService: AffiliateStatsService,
    private settingsService: AffiliateSettingsService,
    private prisma: PrismaService,
  ) {}

  @Get('dashboard/summary')
  getSummary(@CurrentAffiliate() me: CurrentAffiliatePayload) {
    return this.statsService.getSummary(me.sub);
  }

  @Get('dashboard/performance')
  getPerformance(
    @CurrentAffiliate() me: CurrentAffiliatePayload,
    @Query('range') rangeRaw?: string,
  ) {
    const parsed = Number(rangeRaw ?? 30);
    if (!ALLOWED_RANGES.includes(parsed as Range)) {
      throw new BadRequestException('range must be one of 30, 90, 365');
    }
    return this.statsService.getPerformance(me.sub, parsed as Range);
  }

  @Get('dashboard/referrals')
  getReferrals(
    @CurrentAffiliate() me: CurrentAffiliatePayload,
    @Query('page') pageRaw?: string,
    @Query('pageSize') pageSizeRaw?: string,
  ) {
    const page = Math.max(1, Number(pageRaw ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(pageSizeRaw ?? 20)));
    return this.statsService.getReferrals(me.sub, page, pageSize);
  }

  @Get('analytics/funnel')
  getFunnel(@CurrentAffiliate() me: CurrentAffiliatePayload) {
    return this.statsService.getFunnel(me.sub);
  }

  @Get('analytics/earnings')
  getEarnings(@CurrentAffiliate() me: CurrentAffiliatePayload) {
    return this.statsService.getEarnings(me.sub);
  }

  @Get('analytics/cohorts')
  getCohorts(@CurrentAffiliate() me: CurrentAffiliatePayload) {
    return this.statsService.getCohorts(me.sub);
  }

  @Get('referral-assets')
  async getReferralAssets(@CurrentAffiliate() me: CurrentAffiliatePayload) {
    const affiliate = await this.prisma.affiliates.findUnique({
      where: { affiliate_id: me.sub },
      select: { referral_code: true },
    });
    return this.statsService.getReferralAssets(
      affiliate?.referral_code ?? null,
    );
  }

  @Get('payouts')
  getPayouts(@CurrentAffiliate() me: CurrentAffiliatePayload) {
    return this.statsService.getPayoutsOverview(me.sub);
  }

  @Get('settings')
  getSettings(@CurrentAffiliate() me: CurrentAffiliatePayload) {
    return this.settingsService.getSettings(me.sub);
  }

  @Put('settings')
  updateSettings(
    @CurrentAffiliate() me: CurrentAffiliatePayload,
    @Body() dto: UpdateAffiliateSettingsDto,
  ) {
    return this.settingsService.updateSettings(me.sub, dto);
  }
}
