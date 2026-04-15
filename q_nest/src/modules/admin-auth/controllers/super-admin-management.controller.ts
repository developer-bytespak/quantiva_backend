import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CurrentAdmin } from '../decorators/current-admin.decorator';
import { DeleteVcPoolAdminDto } from '../dto/delete-vc-pool-admin.dto';
import { CreateVcPoolAdminDto } from '../dto/create-vc-pool-admin.dto';
import { SuperAdminListUsersDto } from '../dto/super-admin-list-users.dto';
import { SuperAdminUnifiedFinanceDto } from '../dto/super-admin-unified-finance.dto';
import { SuperAdminUsersGrowthDto } from '../dto/super-admin-users-growth.dto';
import { UpdateFeeSettingsDto } from '../dto/update-admin-settings.dto';
import { PlanTier, BillingPeriod } from '../../subscriptions/subscriptions.service';
import { AdminJwtAuthGuard } from '../guards/admin-jwt-auth.guard';
import { SuperAdminGuard } from '../guards/super-admin.guard';
import { AdminTokenPayload } from '../services/admin-token.service';
import { SuperAdminManagementService } from '../services/super-admin-management.service';

@Controller('admin/super-admin')
@UseGuards(AdminJwtAuthGuard, SuperAdminGuard)
export class SuperAdminManagementController {
  constructor(
    private readonly superAdminManagementService: SuperAdminManagementService,
    private readonly prisma: PrismaService,
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

  @Get('users/lookup')
  async lookupUser(@Query('email') email: string) {
    if (!email?.trim()) {
      return { found: false, is_us_user: false };
    }
    return this.superAdminManagementService.lookupUserByEmail(email.trim());
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
    @Body() body: { email: string; tier: string; billing_period: string },
  ) {
    const validTiers = Object.values(PlanTier);
    const validPeriods = Object.values(BillingPeriod);

    if (!body.email?.trim()) {
      throw new Error('email is required');
    }
    if (!validTiers.includes(body.tier as PlanTier)) {
      throw new Error(`tier must be one of: ${validTiers.join(', ')}`);
    }
    if (!validPeriods.includes(body.billing_period as BillingPeriod)) {
      throw new Error(`billing_period must be one of: ${validPeriods.join(', ')}`);
    }

    return this.superAdminManagementService.adminUpgradeUserSubscription({
      email: body.email.trim(),
      tier: body.tier as PlanTier,
      billing_period: body.billing_period as BillingPeriod,
    });
  }
}
