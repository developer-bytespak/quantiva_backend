import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  forwardRef,
  Get,
  Inject,
  InternalServerErrorException,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { PrismaService } from '../../../prisma/prisma.service';
import { CurrentAdmin } from '../decorators/current-admin.decorator';
import { DeleteVcPoolAdminDto } from '../dto/delete-vc-pool-admin.dto';
import { CreateVcPoolAdminDto } from '../dto/create-vc-pool-admin.dto';
import { SuperAdminListUsersDto } from '../dto/super-admin-list-users.dto';
import { SuperAdminUnifiedFinanceDto } from '../dto/super-admin-unified-finance.dto';
import { SuperAdminUsersGrowthDto } from '../dto/super-admin-users-growth.dto';
import { UpdateFeeSettingsDto } from '../dto/update-admin-settings.dto';
import { PlanTier, BillingPeriod } from '../../subscriptions/subscriptions.service';
import {
  PremiumMigrationService,
  StripePriceSwitcher,
} from '../../subscriptions/premium-migration.service';
import { StripeService } from '../../stripe/stripe.service';
import { ADMIN_GRANTABLE_TIERS, isPremiumBillingPeriod } from '../../../common/tiers';
import { AdminJwtAuthGuard } from '../guards/admin-jwt-auth.guard';
import { SuperAdminGuard } from '../guards/super-admin.guard';
import { AdminTokenPayload } from '../services/admin-token.service';
import { SuperAdminManagementService } from '../services/super-admin-management.service';
import {
  ALL_SUMMARY_SECTIONS,
  SummarySectionKey,
  UserSummaryPdfService,
} from '../services/user-summary-pdf.service';

@Controller('admin/super-admin')
@UseGuards(AdminJwtAuthGuard, SuperAdminGuard)
export class SuperAdminManagementController {
  private readonly logger = new Logger(SuperAdminManagementController.name);

  constructor(
    private readonly superAdminManagementService: SuperAdminManagementService,
    private readonly userSummaryPdfService: UserSummaryPdfService,
    private readonly prisma: PrismaService,
    private readonly premiumMigrationService: PremiumMigrationService,
    @Inject(forwardRef(() => StripeService))
    private readonly stripeService: StripeService,
  ) {}

  @Get('users')
  async listUsers(@Query() query: SuperAdminListUsersDto) {
    return this.superAdminManagementService.listUsers(query);
  }

  @Get('users/analytics')
  async usersAnalytics() {
    return this.superAdminManagementService.usersAnalytics();
  }

  @Get('users/growth')
  async usersGrowth(@Query() query: SuperAdminUsersGrowthDto) {
    return this.superAdminManagementService.usersGrowthByMonth(query);
  }

  @Get('users/summary-pdf')
  async usersSummaryPdf(
    @Res() res: Response,
    @Query('days') daysParam?: string,
    @Query('sections') sectionsParam?: string,
  ) {
    const ALLOWED_DAYS = new Set([15, 30, 90]);
    const parsedDays = daysParam ? parseInt(daysParam, 10) : NaN;
    const days = ALLOWED_DAYS.has(parsedDays) ? parsedDays : undefined;

    const validSet = new Set<string>(ALL_SUMMARY_SECTIONS);
    const requested = (sectionsParam ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => validSet.has(s)) as SummarySectionKey[];
    const sections = requested.length > 0 ? requested : ALL_SUMMARY_SECTIONS;

    try {
      const pdf = await this.userSummaryPdfService.generatePdf({
        days,
        sections,
      });
      const today = new Date().toISOString().slice(0, 10);
      const windowSuffix = days ? `-last-${days}d` : '';
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="quantiva-users-summary${windowSuffix}-${today}.pdf"`,
      );
      res.setHeader('Content-Length', pdf.length.toString());
      res.end(pdf);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      this.logger.error(
        `users/summary-pdf failed (days=${days ?? 'all'}, sections=${sections.join(',')}): ${message}`,
        stack,
      );
      throw new InternalServerErrorException(
        `Failed to generate user summary PDF: ${message}`,
      );
    }
  }

  @Get('users/emails')
  async usersEmails() {
    return this.superAdminManagementService.listAllUserEmails();
  }

  @Get('users/lookup')
  async lookupUser(@Query('email') email: string) {
    if (!email?.trim()) {
      return { found: false, is_us_user: false };
    }
    return this.superAdminManagementService.lookupUserByEmail(email.trim());
  }

  @Get('users/search')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async searchUsers(@Query('q') q: string) {
    if (!q?.trim() || q.trim().length < 4) {
      return { results: [] };
    }
    return this.superAdminManagementService.searchUsers(q.trim());
  }

  @Get('vc-pool-admins')
  async listVcPoolAdmins() {
    return this.superAdminManagementService.listVcPoolAdmins();
  }

  @Get('pools-oversight')
  async listPoolsOversight(
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.superAdminManagementService.listPoolsOversight({
      status,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get('finance/unified')
  async getUnifiedFinance(@Query() query: SuperAdminUnifiedFinanceDto) {
    return this.superAdminManagementService.getUnifiedFinance(query);
  }

  @Post('vc-pool-admins')
  async createVcPoolAdmin(
    @CurrentAdmin() admin: AdminTokenPayload,
    @Body() dto: CreateVcPoolAdminDto,
  ) {
    return this.superAdminManagementService.createVcPoolAdmin(admin.sub, dto);
  }

  @Delete('vc-pool-admins/:adminId')
  async deleteVcPoolAdmin(
    @CurrentAdmin() admin: AdminTokenPayload,
    @Param('adminId', ParseUUIDPipe) adminId: string,
    @Body() dto: DeleteVcPoolAdminDto,
  ) {
    return this.superAdminManagementService.deleteVcPoolAdmin(
      admin.sub,
      adminId,
      dto.currentPassword,
    );
  }

  @Put('default-fees')
  async updateGlobalDefaultFees(
    @CurrentAdmin() admin: AdminTokenPayload,
    @Body() dto: UpdateFeeSettingsDto,
  ) {
    return this.superAdminManagementService.updateGlobalDefaultFees(
      admin.sub,
      dto,
    );
  }

  @Get('contact-submissions')
  async listContactSubmissions(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('source') source?: string,
    @Query('subject') subject?: string,
    @Query('search') search?: string,
  ) {
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 20;
    const skip = (pageNum - 1) * limitNum;

    const where: any = {};
    if (source && source !== 'all') where.source = source;
    if (subject && subject !== 'all') where.subject = subject;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { company: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [submissions, total] = await Promise.all([
      this.prisma.contact_submissions.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: limitNum,
        include: {
          user: {
            select: { user_id: true, username: true, email: true },
          },
        },
      }),
      this.prisma.contact_submissions.count({ where }),
    ]);

    return {
      submissions,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    };
  }

  @Post('users/upgrade-subscription')
  async upgradeUserSubscription(
    @Body() body: { email: string; tier: string; billing_period?: string },
  ) {
    // Only FREE and PREMIUM can be granted; legacy tiers are deactivated.
    const validTiers = ADMIN_GRANTABLE_TIERS;
    const validPeriods = Object.values(BillingPeriod);
    const billingPeriod = (body.billing_period || BillingPeriod.MONTHLY) as BillingPeriod;

    if (!body.email?.trim()) {
      throw new BadRequestException('email is required');
    }
    if (!validTiers.includes(body.tier as any)) {
      throw new BadRequestException(`tier must be one of: ${validTiers.join(', ')}`);
    }
    if (!validPeriods.includes(billingPeriod)) {
      throw new BadRequestException(`billing_period must be one of: ${validPeriods.join(', ')}`);
    }

    return this.superAdminManagementService.adminUpgradeUserSubscription({
      email: body.email.trim(),
      tier: body.tier as PlanTier,
      billing_period: billingPeriod,
    });
  }

  /**
   * One-off: move every active legacy-tier subscription (PRO / ELITE / ELITE_PLUS)
   * to PREMIUM and notify the user once. Stripe-billed rows also have their
   * Stripe price switched to Premium with no proration (next invoice at the
   * existing period end is $29.99; nothing is charged now). Apple rows are
   * local only. Safe to re-run: rows already migrated are skipped.
   *
   * Defaults to a dry run that includes a Stripe next-invoice preview per row.
   * Run only after the new backend is deployed.
   */
  @Post('subscriptions/migrate-to-premium')
  async migrateToPremium(
    @Body() body: { dry_run?: boolean; user_ids?: string[]; switch_stripe_prices?: boolean },
    @CurrentAdmin() admin: AdminTokenPayload,
  ) {
    const dryRun = body?.dry_run !== false; // default true: explicit { dry_run: false } to execute
    const switchStripe = body?.switch_stripe_prices !== false; // default true
    this.logger.log(
      `Premium migration requested by admin ${admin?.sub ?? 'unknown'} (dry_run=${dryRun}, stripe=${switchStripe})`,
    );

    let stripe: StripePriceSwitcher | undefined;
    if (switchStripe) {
      // Legacy monthly -> Premium monthly, quarterly -> quarterly, yearly -> yearly.
      // Throws if the matching STRIPE_PREMIUM_PRICE_ID* env var is missing.
      const priceFor = (period: string) =>
        this.stripeService.premiumPriceIdFor(isPremiumBillingPeriod(period) ? period : 'MONTHLY');
      stripe = {
        preview: (id, period) => this.stripeService.previewPriceSwitch(id, priceFor(period)),
        switchPrice: (id, period) => this.stripeService.switchSubscriptionPrice(id, priceFor(period)),
      };
    }

    return this.premiumMigrationService.run({
      dryRun,
      userIds: Array.isArray(body?.user_ids) ? body.user_ids : undefined,
      stripe,
    });
  }
}
