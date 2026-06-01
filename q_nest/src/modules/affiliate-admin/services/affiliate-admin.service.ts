import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../../../prisma/prisma.service';
import { AffiliateEmailService } from '../../affiliate/services/affiliate-email.service';
import { ApproveApplicationDto } from '../dto/approve-application.dto';
import { RejectApplicationDto } from '../dto/reject-application.dto';
import { RequestInfoDto } from '../dto/request-info.dto';
import { ChangeTierDto } from '../dto/change-tier.dto';
import { AdjustBalanceDto } from '../dto/adjust-balance.dto';
import { AddNoteDto } from '../dto/add-note.dto';
import { UpdateProgramSettingsDto } from '../dto/update-program-settings.dto';
import { MarkPayoutPaidDto } from '../dto/mark-payout-paid.dto';

export interface ListAffiliatesFilters {
  status?: string;
  country?: string;
  tier?: string;
  channel?: string;
  search?: string;
  date_from?: string;
  date_to?: string;
  sort?: string;
  page?: number;
  page_size?: number;
}

@Injectable()
export class AffiliateAdminService {
  private readonly logger = new Logger(AffiliateAdminService.name);

  constructor(
    private prisma: PrismaService,
    private affiliateEmailService: AffiliateEmailService,
  ) {}

  // ──────────────────────────────────────────────────────────────────────
  // List + detail
  // ──────────────────────────────────────────────────────────────────────

  async listAffiliates(filters: ListAffiliatesFilters) {
    const page = Math.max(1, Number(filters.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(filters.page_size ?? 20)));

    const where: any = {};
    if (filters.status) where.status = filters.status;
    if (filters.country) where.country = filters.country;
    if (filters.tier) where.commission_tier = filters.tier;
    if (filters.channel) {
      where.application = { primary_channel: filters.channel };
    }
    if (filters.search) {
      where.OR = [
        { email: { contains: filters.search, mode: 'insensitive' } },
        { display_name: { contains: filters.search, mode: 'insensitive' } },
        { referral_code: { contains: filters.search, mode: 'insensitive' } },
      ];
    }
    if (filters.date_from || filters.date_to) {
      where.created_at = {};
      if (filters.date_from) where.created_at.gte = new Date(filters.date_from);
      if (filters.date_to) where.created_at.lte = new Date(filters.date_to);
    }

    const orderBy = this.parseSort(filters.sort);

    const [total, items] = await Promise.all([
      this.prisma.affiliates.count({ where }),
      this.prisma.affiliates.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          affiliate_id: true,
          email: true,
          display_name: true,
          full_name: true,
          country: true,
          referral_code: true,
          status: true,
          commission_tier: true,
          signup_count: true,
          conversion_count: true,
          revenue_generated: true,
          pending_balance: true,
          paid_total: true,
          last_activity_at: true,
          created_at: true,
          application: {
            select: { primary_channel: true },
          },
        },
      }),
    ]);

    return { page, page_size: pageSize, total, items };
  }

  async listApplications(filters: {
    status?: string;
    page?: number;
    page_size?: number;
  }) {
    const page = Math.max(1, Number(filters.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(filters.page_size ?? 20)));
    const status = filters.status ?? 'PENDING';

    const where: any = { status };

    const [total, items] = await Promise.all([
      this.prisma.affiliate_applications.count({ where }),
      this.prisma.affiliate_applications.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          affiliate: {
            select: {
              affiliate_id: true,
              email: true,
              display_name: true,
              full_name: true,
              country: true,
              status: true,
              created_at: true,
            },
          },
        },
      }),
    ]);

    return { page, page_size: pageSize, total, items };
  }

  async getApplication(applicationId: string) {
    const app = await this.prisma.affiliate_applications.findUnique({
      where: { application_id: applicationId },
      include: {
        affiliate: {
          select: {
            affiliate_id: true,
            email: true,
            display_name: true,
            full_name: true,
            country: true,
            tax_residency: true,
            status: true,
            created_at: true,
          },
        },
      },
    });
    if (!app) throw new NotFoundException('Application not found');

    // Lightweight enrichment: prior applications/IPs from the same email or IP.
    const [priorByEmail, priorByIp] = await Promise.all([
      this.prisma.affiliates.findMany({
        where: {
          email: app.affiliate.email,
          NOT: { affiliate_id: app.affiliate_id },
        },
        select: { affiliate_id: true, status: true, created_at: true },
      }),
      app.ip_address
        ? this.prisma.affiliate_applications.findMany({
            where: {
              ip_address: app.ip_address,
              NOT: { application_id: applicationId },
            },
            select: {
              application_id: true,
              affiliate_id: true,
              status: true,
              created_at: true,
            },
          })
        : Promise.resolve([]),
    ]);

    return {
      ...app,
      enrichment: {
        prior_accounts_with_same_email: priorByEmail,
        prior_applications_from_same_ip: priorByIp,
      },
    };
  }

  // ──────────────────────────────────────────────────────────────────────
  // Application review flow
  // ──────────────────────────────────────────────────────────────────────

  async approveApplication(
    applicationId: string,
    dto: ApproveApplicationDto,
    adminId: string,
  ) {
    const app = await this.prisma.affiliate_applications.findUnique({
      where: { application_id: applicationId },
    });
    if (!app) throw new NotFoundException('Application not found');
    if (app.status === 'APPROVED') {
      throw new BadRequestException('Application is already approved');
    }

    const codeTaken = await this.prisma.affiliates.findFirst({
      where: {
        referral_code: dto.referral_code,
        NOT: { affiliate_id: app.affiliate_id },
      },
      select: { affiliate_id: true },
    });
    if (codeTaken) {
      throw new ConflictException('Referral code is already in use');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.affiliates.update({
        where: { affiliate_id: app.affiliate_id },
        data: {
          status: 'APPROVED',
          referral_code: dto.referral_code,
          commission_tier: (dto.commission_tier ?? 'DEFAULT') as any,
        },
      });
      await tx.affiliate_applications.update({
        where: { application_id: applicationId },
        data: {
          status: 'APPROVED',
          reviewed_by_admin_id: adminId,
          reviewed_at: new Date(),
        },
      });
      await tx.affiliate_audit_log.create({
        data: {
          affiliate_id: app.affiliate_id,
          application_id: applicationId,
          actor_admin_id: adminId,
          action: 'AFFILIATE_APPLICATION_APPROVED',
          metadata: {
            referral_code: dto.referral_code,
            commission_tier: dto.commission_tier ?? 'DEFAULT',
            notes: dto.notes ?? null,
          },
        },
      });
    });

    this.logger.log(
      `Application ${applicationId} approved by admin ${adminId}; code=${dto.referral_code}`,
    );

    const affiliate = await this.prisma.affiliates.findUnique({
      where: { affiliate_id: app.affiliate_id },
      select: { email: true, display_name: true },
    });
    if (affiliate) {
      await this.affiliateEmailService.sendApplicationApproved({
        email: affiliate.email,
        displayName: affiliate.display_name,
        referralCode: dto.referral_code,
      });
    }

    return { ok: true };
  }

  async rejectApplication(
    applicationId: string,
    dto: RejectApplicationDto,
    adminId: string,
  ) {
    const app = await this.prisma.affiliate_applications.findUnique({
      where: { application_id: applicationId },
    });
    if (!app) throw new NotFoundException('Application not found');

    await this.prisma.$transaction(async (tx) => {
      await tx.affiliates.update({
        where: { affiliate_id: app.affiliate_id },
        data: { status: 'REJECTED' },
      });
      await tx.affiliate_applications.update({
        where: { application_id: applicationId },
        data: {
          status: 'REJECTED',
          rejection_reason: dto.reason,
          reviewed_by_admin_id: adminId,
          reviewed_at: new Date(),
        },
      });
      await tx.affiliate_audit_log.create({
        data: {
          affiliate_id: app.affiliate_id,
          application_id: applicationId,
          actor_admin_id: adminId,
          action: 'AFFILIATE_APPLICATION_REJECTED',
          metadata: { reason: dto.reason, message: dto.message ?? null },
        },
      });
    });

    this.logger.log(
      `Application ${applicationId} rejected by admin ${adminId}; reason=${dto.reason}`,
    );

    const affiliate = await this.prisma.affiliates.findUnique({
      where: { affiliate_id: app.affiliate_id },
      select: { email: true, display_name: true },
    });
    if (affiliate) {
      await this.affiliateEmailService.sendApplicationRejected({
        email: affiliate.email,
        displayName: affiliate.display_name,
        reason: dto.reason,
        message: dto.message,
      });
    }

    return { ok: true };
  }

  async requestInfoOnApplication(
    applicationId: string,
    dto: RequestInfoDto,
    adminId: string,
  ) {
    const app = await this.prisma.affiliate_applications.findUnique({
      where: { application_id: applicationId },
    });
    if (!app) throw new NotFoundException('Application not found');

    await this.prisma.affiliate_applications.update({
      where: { application_id: applicationId },
      data: {
        status: 'INFO_REQUESTED',
        reviewed_by_admin_id: adminId,
        reviewed_at: new Date(),
      },
    });
    await this.prisma.affiliate_audit_log.create({
      data: {
        affiliate_id: app.affiliate_id,
        application_id: applicationId,
        actor_admin_id: adminId,
        action: 'AFFILIATE_INFO_REQUESTED',
        metadata: { message: dto.message },
      },
    });

    this.logger.log(
      `Info requested on application ${applicationId} by admin ${adminId}`,
    );

    const affiliate = await this.prisma.affiliates.findUnique({
      where: { affiliate_id: app.affiliate_id },
      select: { email: true, display_name: true },
    });
    if (affiliate) {
      await this.affiliateEmailService.sendInfoRequested({
        email: affiliate.email,
        displayName: affiliate.display_name,
        message: dto.message,
      });
    }

    return { ok: true };
  }

  // ──────────────────────────────────────────────────────────────────────
  // Affiliate detail tabs
  // ──────────────────────────────────────────────────────────────────────

  async getAffiliateDetail(affiliateId: string) {
    const affiliate = await this.prisma.affiliates.findUnique({
      where: { affiliate_id: affiliateId },
      include: { application: true },
    });
    if (!affiliate) throw new NotFoundException('Affiliate not found');
    return affiliate;
  }

  async getAffiliateReferrals(
    affiliateId: string,
    page: number,
    pageSize: number,
  ) {
    const skip = (page - 1) * pageSize;
    const [total, referrals] = await Promise.all([
      this.prisma.affiliate_referrals.count({
        where: { affiliate_id: affiliateId },
      }),
      this.prisma.affiliate_referrals.findMany({
        where: { affiliate_id: affiliateId },
        orderBy: { attributed_at: 'desc' },
        skip,
        take: pageSize,
        include: {
          user: {
            select: {
              user_id: true,
              email: true,
              kyc_status: true,
              current_tier: true,
              created_at: true,
            },
          },
        },
      }),
    ]);

    const userIds = referrals.map((r) => r.user_id);
    const commissions = await this.prisma.affiliate_commission_events.groupBy({
      by: ['user_id'],
      where: {
        affiliate_id: affiliateId,
        user_id: { in: userIds },
        status: { in: ['ACCRUED', 'PAID'] },
      },
      _sum: { commission_usd: true, gross_amount_usd: true },
    });
    const byUser = new Map<
      string,
      { commissions_usd: number; revenue_usd: number }
    >();
    for (const c of commissions) {
      byUser.set(c.user_id, {
        commissions_usd: Number(c._sum.commission_usd ?? 0),
        revenue_usd: Number(c._sum.gross_amount_usd ?? 0),
      });
    }

    const activeSubs = await this.prisma.user_subscriptions.findMany({
      where: {
        user_id: { in: userIds },
        status: 'active',
        tier: { not: 'FREE' },
      },
      select: { user_id: true },
      distinct: ['user_id'],
    });
    const activeIds = new Set(activeSubs.map((s) => s.user_id));

    return {
      page,
      page_size: pageSize,
      total,
      items: referrals.map((r) => ({
        user_id: r.user_id,
        email: r.user.email,
        signup_date: r.user.created_at,
        kyc_status: r.user.kyc_status,
        current_tier: r.user.current_tier,
        lifetime_revenue_usd: byUser.get(r.user_id)?.revenue_usd ?? 0,
        attributed_commissions_usd:
          byUser.get(r.user_id)?.commissions_usd ?? 0,
        status: activeIds.has(r.user_id) ? 'Active' : 'Churned',
        referral_code_used: r.referral_code,
        attributed_at: r.attributed_at,
      })),
    };
  }

  async getAffiliateTransactions(
    affiliateId: string,
    page: number,
    pageSize: number,
  ) {
    const skip = (page - 1) * pageSize;
    const [total, items] = await Promise.all([
      this.prisma.affiliate_commission_events.count({
        where: { affiliate_id: affiliateId },
      }),
      this.prisma.affiliate_commission_events.findMany({
        where: { affiliate_id: affiliateId },
        orderBy: { created_at: 'desc' },
        skip,
        take: pageSize,
      }),
    ]);
    return { page, page_size: pageSize, total, items };
  }

  async getAffiliatePayouts(
    affiliateId: string,
    page: number,
    pageSize: number,
  ) {
    const skip = (page - 1) * pageSize;
    const [total, items] = await Promise.all([
      this.prisma.affiliate_payouts.count({
        where: { affiliate_id: affiliateId },
      }),
      this.prisma.affiliate_payouts.findMany({
        where: { affiliate_id: affiliateId },
        orderBy: { created_at: 'desc' },
        skip,
        take: pageSize,
      }),
    ]);
    return { page, page_size: pageSize, total, items };
  }

  async getAffiliateAuditLog(
    affiliateId: string,
    page: number,
    pageSize: number,
  ) {
    const skip = (page - 1) * pageSize;
    const [total, items] = await Promise.all([
      this.prisma.affiliate_audit_log.count({
        where: { affiliate_id: affiliateId },
      }),
      this.prisma.affiliate_audit_log.findMany({
        where: { affiliate_id: affiliateId },
        orderBy: { created_at: 'desc' },
        skip,
        take: pageSize,
      }),
    ]);
    return { page, page_size: pageSize, total, items };
  }

  // ──────────────────────────────────────────────────────────────────────
  // Per-affiliate actions
  // ──────────────────────────────────────────────────────────────────────

  async setStatus(
    affiliateId: string,
    status: 'PAUSED' | 'SUSPENDED' | 'APPROVED',
    adminId: string,
    reason?: string,
  ) {
    const affiliate = await this.prisma.affiliates.findUnique({
      where: { affiliate_id: affiliateId },
      select: { affiliate_id: true, status: true },
    });
    if (!affiliate) throw new NotFoundException('Affiliate not found');

    await this.prisma.$transaction(async (tx) => {
      await tx.affiliates.update({
        where: { affiliate_id: affiliateId },
        data: { status },
      });
      await tx.affiliate_audit_log.create({
        data: {
          affiliate_id: affiliateId,
          actor_admin_id: adminId,
          action: `AFFILIATE_STATUS_${status}`,
          metadata: {
            previous_status: affiliate.status,
            reason: reason ?? null,
          },
        },
      });
    });

    return { ok: true };
  }

  async resetReferralCode(
    affiliateId: string,
    newCode: string,
    adminId: string,
  ) {
    if (!/^[A-Za-z0-9_\-]{3,60}$/.test(newCode)) {
      throw new BadRequestException(
        'Referral code must be 3-60 chars of letters/numbers/dashes/underscores',
      );
    }

    const codeTaken = await this.prisma.affiliates.findFirst({
      where: {
        referral_code: newCode,
        NOT: { affiliate_id: affiliateId },
      },
      select: { affiliate_id: true },
    });
    if (codeTaken) {
      throw new ConflictException('Referral code is already in use');
    }

    const affiliate = await this.prisma.affiliates.findUnique({
      where: { affiliate_id: affiliateId },
      select: { referral_code: true },
    });
    if (!affiliate) throw new NotFoundException('Affiliate not found');

    await this.prisma.$transaction(async (tx) => {
      await tx.affiliates.update({
        where: { affiliate_id: affiliateId },
        data: { referral_code: newCode },
      });
      await tx.affiliate_audit_log.create({
        data: {
          affiliate_id: affiliateId,
          actor_admin_id: adminId,
          action: 'AFFILIATE_CODE_RESET',
          metadata: {
            previous_code: affiliate.referral_code,
            new_code: newCode,
          },
        },
      });
    });

    return { ok: true, referral_code: newCode };
  }

  async changeTier(
    affiliateId: string,
    dto: ChangeTierDto,
    adminId: string,
  ) {
    const affiliate = await this.prisma.affiliates.findUnique({
      where: { affiliate_id: affiliateId },
      select: { commission_tier: true },
    });
    if (!affiliate) throw new NotFoundException('Affiliate not found');

    await this.prisma.$transaction(async (tx) => {
      await tx.affiliates.update({
        where: { affiliate_id: affiliateId },
        data: { commission_tier: dto.commission_tier as any },
      });
      await tx.affiliate_audit_log.create({
        data: {
          affiliate_id: affiliateId,
          actor_admin_id: adminId,
          action: 'AFFILIATE_TIER_CHANGED',
          metadata: {
            previous_tier: affiliate.commission_tier,
            new_tier: dto.commission_tier,
            reason: dto.reason ?? null,
          },
        },
      });
    });

    return { ok: true };
  }

  async adjustBalance(
    affiliateId: string,
    dto: AdjustBalanceDto,
    adminId: string,
  ) {
    const affiliate = await this.prisma.affiliates.findUnique({
      where: { affiliate_id: affiliateId },
      select: { pending_balance: true },
    });
    if (!affiliate) throw new NotFoundException('Affiliate not found');

    const delta = new Decimal(dto.delta_usd);
    const next = new Decimal(affiliate.pending_balance).plus(delta);
    if (next.lt(0)) {
      throw new BadRequestException(
        'Adjustment would push pending balance below zero',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.affiliates.update({
        where: { affiliate_id: affiliateId },
        data: { pending_balance: { increment: dto.delta_usd } },
      });
      await tx.affiliate_audit_log.create({
        data: {
          affiliate_id: affiliateId,
          actor_admin_id: adminId,
          action: 'AFFILIATE_BALANCE_ADJUSTED',
          metadata: {
            previous_balance: affiliate.pending_balance,
            delta_usd: dto.delta_usd,
            reason: dto.reason,
          },
        },
      });
    });

    return { ok: true };
  }

  async addNote(affiliateId: string, dto: AddNoteDto, adminId: string) {
    const affiliate = await this.prisma.affiliates.findUnique({
      where: { affiliate_id: affiliateId },
      select: { affiliate_id: true },
    });
    if (!affiliate) throw new NotFoundException('Affiliate not found');

    await this.prisma.affiliate_audit_log.create({
      data: {
        affiliate_id: affiliateId,
        actor_admin_id: adminId,
        action: 'AFFILIATE_NOTE',
        metadata: { note: dto.note },
      },
    });
    return { ok: true };
  }

  // ──────────────────────────────────────────────────────────────────────
  // Payouts
  // ──────────────────────────────────────────────────────────────────────

  async listAllPayouts(filters: {
    status?: string;
    page?: number;
    page_size?: number;
  }) {
    const page = Math.max(1, Number(filters.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(filters.page_size ?? 50)));
    const where: any = {};
    if (filters.status) where.status = filters.status;

    const [total, items] = await Promise.all([
      this.prisma.affiliate_payouts.count({ where }),
      this.prisma.affiliate_payouts.findMany({
        where,
        orderBy: [{ status: 'asc' }, { created_at: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          affiliate: {
            select: {
              affiliate_id: true,
              email: true,
              display_name: true,
              payout_instructions: true,
            },
          },
        },
      }),
    ]);
    return { page, page_size: pageSize, total, items };
  }

  /**
   * Mark a PENDING payout as paid. Flips every linked commission event to
   * PAID, shifts the affiliate's pending_balance into paid_total, stamps the
   * payment_reference, and audits the action.
   */
  async markPayoutPaid(
    payoutId: string,
    dto: MarkPayoutPaidDto,
    adminId: string,
  ) {
    const payout = await this.prisma.affiliate_payouts.findUnique({
      where: { payout_id: payoutId },
      include: { commission_events: true },
    });
    if (!payout) throw new NotFoundException('Payout not found');
    if (payout.status === 'COMPLETED') {
      throw new BadRequestException('Payout is already marked paid');
    }

    const totalCommission = payout.commission_events.reduce(
      (sum, e) => sum.plus(e.commission_usd),
      new Decimal(0),
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.affiliate_commission_events.updateMany({
        where: { payout_id: payoutId, status: 'ACCRUED' },
        data: { status: 'PAID' },
      });
      await tx.affiliates.update({
        where: { affiliate_id: payout.affiliate_id },
        data: {
          pending_balance: { decrement: totalCommission.toNumber() },
          paid_total: { increment: totalCommission.toNumber() },
        },
      });
      await tx.affiliate_payouts.update({
        where: { payout_id: payoutId },
        data: {
          status: 'COMPLETED',
          paid_at: new Date(),
          processed_by_admin_id: adminId,
          payment_reference: dto.payment_reference,
        },
      });
      await tx.affiliate_audit_log.create({
        data: {
          affiliate_id: payout.affiliate_id,
          actor_admin_id: adminId,
          action: 'AFFILIATE_PAYOUT_MARKED_PAID',
          metadata: {
            payout_id: payoutId,
            period: payout.period,
            net_usd: payout.net_usd,
            payment_reference: dto.payment_reference ?? null,
          },
        },
      });
    });

    this.logger.log(
      `Payout ${payoutId} marked paid by admin ${adminId}; net=${payout.net_usd}`,
    );

    const affiliate = await this.prisma.affiliates.findUnique({
      where: { affiliate_id: payout.affiliate_id },
      select: { email: true, display_name: true },
    });
    if (affiliate) {
      await this.affiliateEmailService.sendPayoutSent({
        email: affiliate.email,
        displayName: affiliate.display_name,
        period: payout.period,
        netUsd: Number(payout.net_usd),
        paymentReference: dto.payment_reference ?? null,
      });
    }

    return { ok: true };
  }

  /**
   * Generate one payout batch for the current period. For each APPROVED
   * affiliate with un-attached ACCRUED commission events totaling >=
   * payout_threshold_usd, create one PENDING affiliate_payouts row and link
   * the events to it via payout_id.
   *
   * Safe to call multiple times in the same period — only un-linked events are
   * considered, so a re-run picks up newly accrued commissions.
   */
  async generatePayoutBatch(adminId: string | null = null) {
    const settings = await this.prisma.affiliate_program_settings.findFirst({
      where: { is_active: true },
      orderBy: { version: 'desc' },
    });
    if (!settings) {
      throw new BadRequestException('No active program settings');
    }

    const now = new Date();
    const period = `${now.getUTCFullYear()}-${String(
      now.getUTCMonth() + 1,
    ).padStart(2, '0')}`;

    const candidates = await this.prisma.affiliates.findMany({
      where: { status: 'APPROVED' },
      select: { affiliate_id: true },
    });

    const created: string[] = [];
    for (const { affiliate_id } of candidates) {
      const events = await this.prisma.affiliate_commission_events.findMany({
        where: {
          affiliate_id,
          status: 'ACCRUED',
          payout_id: null,
        },
        select: { event_id: true, commission_usd: true },
      });
      const gross = events.reduce(
        (sum, e) => sum.plus(e.commission_usd),
        new Decimal(0),
      );
      if (gross.lt(settings.payout_threshold_usd)) continue;

      const payout = await this.prisma.$transaction(async (tx) => {
        const p = await tx.affiliate_payouts.create({
          data: {
            affiliate_id,
            period,
            gross_usd: gross.toNumber(),
            net_usd: gross.toNumber(),
            status: 'PENDING',
          },
        });
        await tx.affiliate_commission_events.updateMany({
          where: { event_id: { in: events.map((e) => e.event_id) } },
          data: { payout_id: p.payout_id },
        });
        await tx.affiliate_audit_log.create({
          data: {
            affiliate_id,
            actor_admin_id: adminId,
            action: 'AFFILIATE_PAYOUT_BATCH_CREATED',
            metadata: {
              payout_id: p.payout_id,
              period,
              gross_usd: p.gross_usd,
              event_count: events.length,
            },
          },
        });
        return p;
      });
      created.push(payout.payout_id);
    }

    this.logger.log(
      `Generated ${created.length} payouts for ${period} (threshold $${settings.payout_threshold_usd})`,
    );

    return { period, created_payouts: created };
  }

  // ──────────────────────────────────────────────────────────────────────
  // Program settings (versioned)
  // ──────────────────────────────────────────────────────────────────────

  async getProgramSettings() {
    const settings = await this.prisma.affiliate_program_settings.findFirst({
      where: { is_active: true },
      orderBy: { version: 'desc' },
    });
    return settings;
  }

  async updateProgramSettings(
    dto: UpdateProgramSettingsDto,
    adminId: string,
  ) {
    const current = await this.prisma.affiliate_program_settings.findFirst({
      where: { is_active: true },
      orderBy: { version: 'desc' },
    });
    if (!current) {
      throw new BadRequestException(
        'No current program settings to derive from; seed an initial row first',
      );
    }

    const next = await this.prisma.$transaction(async (tx) => {
      await tx.affiliate_program_settings.updateMany({
        where: { is_active: true },
        data: { is_active: false },
      });
      const created = await tx.affiliate_program_settings.create({
        data: {
          is_active: true,
          subscription_commission_pct:
            dto.subscription_commission_pct ??
            current.subscription_commission_pct,
          recurring_months_cap:
            dto.recurring_months_cap ?? current.recurring_months_cap,
          attribution_window_days:
            dto.attribution_window_days ?? current.attribution_window_days,
          refund_clawback_days:
            dto.refund_clawback_days ?? current.refund_clawback_days,
          payout_threshold_usd:
            dto.payout_threshold_usd ?? current.payout_threshold_usd,
          payout_cycle: dto.payout_cycle ?? current.payout_cycle,
          premium_tier_multiplier:
            dto.premium_tier_multiplier ?? current.premium_tier_multiplier,
          affiliate_signup_velocity_24h:
            dto.affiliate_signup_velocity_24h ??
            current.affiliate_signup_velocity_24h,
          updated_by_admin_id: adminId,
        },
      });
      await tx.affiliate_audit_log.create({
        data: {
          actor_admin_id: adminId,
          action: 'AFFILIATE_PROGRAM_SETTINGS_UPDATED',
          metadata: {
            previous_version: current.version,
            new_version: created.version,
            changed: dto,
          },
        },
      });
      return created;
    });

    return next;
  }

  // ──────────────────────────────────────────────────────────────────────
  // CSV export
  // ──────────────────────────────────────────────────────────────────────

  async exportAffiliatesCSV(filters: ListAffiliatesFilters): Promise<string> {
    const { items } = await this.listAffiliates({
      ...filters,
      page: 1,
      page_size: 1000,
    });
    const rows = [
      [
        'affiliate_id',
        'email',
        'display_name',
        'full_name',
        'country',
        'referral_code',
        'status',
        'commission_tier',
        'signup_count',
        'conversion_count',
        'revenue_generated_usd',
        'pending_balance_usd',
        'paid_total_usd',
        'last_activity_at',
        'created_at',
      ].join(','),
    ];
    for (const a of items) {
      rows.push(
        [
          a.affiliate_id,
          this.csvEscape(a.email),
          this.csvEscape(a.display_name),
          this.csvEscape(a.full_name ?? ''),
          this.csvEscape(a.country ?? ''),
          this.csvEscape(a.referral_code ?? ''),
          a.status,
          a.commission_tier,
          a.signup_count,
          a.conversion_count,
          Number(a.revenue_generated).toFixed(2),
          Number(a.pending_balance).toFixed(2),
          Number(a.paid_total).toFixed(2),
          a.last_activity_at?.toISOString() ?? '',
          a.created_at.toISOString(),
        ].join(','),
      );
    }
    return rows.join('\n');
  }

  // ──────────────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────────────

  private parseSort(sort?: string): any {
    if (!sort) return { created_at: 'desc' };
    const [fieldRaw, dirRaw] = sort.split(':');
    const dir = (dirRaw ?? 'desc') === 'asc' ? 'asc' : 'desc';
    const ALLOWED: Record<string, true> = {
      created_at: true,
      last_activity_at: true,
      signup_count: true,
      conversion_count: true,
      revenue_generated: true,
      pending_balance: true,
      paid_total: true,
    };
    if (!ALLOWED[fieldRaw]) return { created_at: 'desc' };
    return { [fieldRaw]: dir };
  }

  private csvEscape(value: string): string {
    if (value == null) return '';
    const needsQuote = /[",\n]/.test(value);
    const escaped = value.replace(/"/g, '""');
    return needsQuote ? `"${escaped}"` : escaped;
  }
}
