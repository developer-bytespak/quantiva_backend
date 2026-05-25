import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import Handlebars from 'handlebars';
import puppeteer, { Browser } from 'puppeteer';
import { PrismaService } from '../../../prisma/prisma.service';

const DETAIL_LIMIT = 15;

export type SummarySectionKey =
  | 'fully_completed'
  | 'kyc_approved'
  | 'kyc_rejected'
  | 'kyc_pending_active'
  | 'signed_up_only';

export const ALL_SUMMARY_SECTIONS: SummarySectionKey[] = [
  'fully_completed',
  'kyc_approved',
  'kyc_rejected',
  'kyc_pending_active',
  'signed_up_only',
];

export interface GenerateSummaryOptions {
  days?: number;
  sections?: SummarySectionKey[];
}

interface SummaryUserDetail {
  created_at: string;
  email: string;
  username: string;
  full_name: string | null;
  kyc_status?: string;
  kyc_attempts?: number;
  email_verified?: boolean;
  profile_pic_set?: boolean;
  exchanges_connected?: number;
}

interface SummaryRow {
  label: string;
  users: number;
  share: string;
}

interface SummaryData {
  generated_at: string;
  window_label: string;
  total_users: number;
  plans: { free: number; pro: number; elite: number; elite_plus: number };
  onboarding_funnel: SummaryRow[];
  kyc_status: { status: string; users: number }[];
  sections: {
    fully_completed: SummaryUserDetail[];
    kyc_approved: SummaryUserDetail[];
    kyc_rejected: SummaryUserDetail[];
    kyc_pending_active: SummaryUserDetail[];
    signed_up_only: SummaryUserDetail[];
  };
  show: Record<SummarySectionKey, boolean>;
  has_any_section: boolean;
  detail_limit: number;
}

@Injectable()
export class UserSummaryPdfService implements OnModuleDestroy {
  private readonly logger = new Logger(UserSummaryPdfService.name);
  private browser: Browser | null = null;
  private templateFn: HandlebarsTemplateDelegate | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleDestroy() {
    if (this.browser) {
      try {
        await this.browser.close();
      } catch (err) {
        this.logger.warn(`Failed to close puppeteer browser: ${err}`);
      }
      this.browser = null;
    }
  }

  async generatePdf(options: GenerateSummaryOptions = {}): Promise<Buffer> {
    const summary = await this.buildUserSummary(options);
    const html = await this.renderHtml(summary);
    return this.renderPdf(html);
  }

  private async buildUserSummary(
    options: GenerateSummaryOptions,
  ): Promise<SummaryData> {
    const days = options.days && options.days > 0 ? options.days : undefined;
    const enabled = new Set<SummarySectionKey>(
      options.sections && options.sections.length > 0
        ? options.sections
        : ALL_SUMMARY_SECTIONS,
    );

    const cutoff = days ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : null;
    const dateFilter = cutoff ? { created_at: { gte: cutoff } } : {};
    const windowLabel = days ? `Last ${days} days` : 'All time';

    const [
      totalUsers,
      planGroups,
      onboardingGroups,
      kycGroups,
      pendingNoAttemptCount,
      fullyCompletedUsers,
      kycApprovedUsers,
      kycRejectedUsers,
      kycPendingActiveUsers,
      signedUpOnlyUsers,
    ] = await Promise.all([
      this.prisma.users.count({ where: dateFilter }),
      this.prisma.users.groupBy({
        by: ['current_tier'],
        where: dateFilter,
        _count: { current_tier: true },
      }),
      this.prisma.users.groupBy({
        by: ['onboarding_state'],
        where: dateFilter,
        _count: { onboarding_state: true },
      }),
      this.prisma.users.groupBy({
        by: ['kyc_status'],
        where: dateFilter,
        _count: { kyc_status: true },
      }),
      this.prisma.users.count({
        where: {
          ...dateFilter,
          kyc_status: 'pending',
          kyc_verifications: { none: {} },
        },
      }),
      enabled.has('fully_completed')
        ? this.prisma.users.findMany({
            where: { ...dateFilter, onboarding_state: 'COMPLETED' },
            orderBy: { created_at: 'desc' },
            take: DETAIL_LIMIT,
            select: {
              created_at: true,
              email: true,
              username: true,
              full_name: true,
              kyc_status: true,
              email_verified: true,
              profile_pic_url: true,
              _count: { select: { exchange_connections: true } },
            },
          })
        : Promise.resolve(null),
      enabled.has('kyc_approved')
        ? this.prisma.users.findMany({
            where: {
              ...dateFilter,
              kyc_status: 'approved',
              onboarding_state: { not: 'COMPLETED' },
            },
            orderBy: { created_at: 'desc' },
            take: DETAIL_LIMIT,
            select: {
              created_at: true,
              email: true,
              username: true,
              full_name: true,
              _count: { select: { kyc_verifications: true } },
            },
          })
        : Promise.resolve(null),
      enabled.has('kyc_rejected')
        ? this.prisma.users.findMany({
            where: { ...dateFilter, kyc_status: 'rejected' },
            orderBy: { created_at: 'desc' },
            take: DETAIL_LIMIT,
            select: {
              created_at: true,
              email: true,
              username: true,
              full_name: true,
              _count: { select: { kyc_verifications: true } },
            },
          })
        : Promise.resolve(null),
      enabled.has('kyc_pending_active')
        ? this.prisma.users.findMany({
            where: {
              ...dateFilter,
              kyc_status: 'pending',
              kyc_verifications: { some: {} },
            },
            orderBy: { created_at: 'desc' },
            take: DETAIL_LIMIT,
            select: {
              created_at: true,
              email: true,
              username: true,
              full_name: true,
              _count: { select: { kyc_verifications: true } },
            },
          })
        : Promise.resolve(null),
      enabled.has('signed_up_only')
        ? this.prisma.users.findMany({
            where: { ...dateFilter, onboarding_state: 'SIGNED_UP' },
            orderBy: { created_at: 'desc' },
            take: DETAIL_LIMIT,
            select: {
              created_at: true,
              email: true,
              username: true,
            },
          })
        : Promise.resolve(null),
    ]);

    const plans = { free: 0, pro: 0, elite: 0, elite_plus: 0 };
    for (const row of planGroups) {
      if (row.current_tier === 'FREE') plans.free = row._count.current_tier;
      if (row.current_tier === 'PRO') plans.pro = row._count.current_tier;
      if (row.current_tier === 'ELITE') plans.elite = row._count.current_tier;
      if (row.current_tier === 'ELITE_PLUS') plans.elite_plus = row._count.current_tier;
    }

    const onboardingCounts: Record<string, number> = {
      SIGNED_UP: 0,
      PERSONAL_INFO: 0,
      KYC: 0,
      PAID: 0,
      CONNECT_EXCHANGE: 0,
      COMPLETED: 0,
    };
    for (const row of onboardingGroups) {
      onboardingCounts[row.onboarding_state] = row._count.onboarding_state;
    }
    const personalInfoStage = onboardingCounts.PERSONAL_INFO;
    const kycAndBeyond =
      onboardingCounts.KYC +
      onboardingCounts.PAID +
      onboardingCounts.CONNECT_EXCHANGE;
    const completedStage = onboardingCounts.COMPLETED;
    const signedUpStage = onboardingCounts.SIGNED_UP;

    const share = (n: number) =>
      totalUsers === 0 ? '0%' : `${Math.round((n / totalUsers) * 100)}%`;

    const onboarding_funnel: SummaryRow[] = [
      { label: 'Signed up only (no profile, no KYC)', users: signedUpStage, share: share(signedUpStage) },
      { label: 'Personal info completed', users: personalInfoStage, share: share(personalInfoStage) },
      { label: 'KYC stage (submitted, not yet finished)', users: kycAndBeyond, share: share(kycAndBeyond) },
      { label: 'Fully completed onboarding', users: completedStage, share: share(completedStage) },
    ];

    const kycCounts: Record<string, number> = {
      approved: 0,
      rejected: 0,
      pending: 0,
      review: 0,
    };
    for (const row of kycGroups) {
      kycCounts[row.kyc_status] = row._count.kyc_status;
    }
    const pendingWithAttempt = Math.max(0, kycCounts.pending - pendingNoAttemptCount);

    const kyc_status = [
      { status: 'Approved', users: kycCounts.approved },
      { status: 'Rejected', users: kycCounts.rejected },
      { status: 'Pending (in review)', users: pendingWithAttempt },
      { status: 'Pending (no attempt made)', users: pendingNoAttemptCount },
      { status: 'Under review', users: kycCounts.review },
    ];

    const fmt = (d: Date) =>
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
        d.getUTCDate(),
      ).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(
        d.getUTCMinutes(),
      ).padStart(2, '0')}`;

    const mapFullyCompleted = (rows: NonNullable<typeof fullyCompletedUsers>) =>
      rows.map((u) => ({
        created_at: fmt(u.created_at),
        email: u.email,
        username: u.username,
        full_name: u.full_name,
        kyc_status: u.kyc_status,
        email_verified: u.email_verified,
        profile_pic_set: !!u.profile_pic_url,
        exchanges_connected: u._count.exchange_connections,
      }));

    const mapWithAttempts = (
      rows: NonNullable<
        | typeof kycApprovedUsers
        | typeof kycRejectedUsers
        | typeof kycPendingActiveUsers
      >,
    ) =>
      rows.map((u) => ({
        created_at: fmt(u.created_at),
        email: u.email,
        username: u.username,
        full_name: u.full_name,
        kyc_attempts: u._count.kyc_verifications,
      }));

    const mapSignedUp = (rows: NonNullable<typeof signedUpOnlyUsers>) =>
      rows.map((u) => ({
        created_at: fmt(u.created_at),
        email: u.email,
        username: u.username,
        full_name: null as string | null,
      }));

    const sections = {
      fully_completed: fullyCompletedUsers
        ? mapFullyCompleted(fullyCompletedUsers)
        : [],
      kyc_approved: kycApprovedUsers ? mapWithAttempts(kycApprovedUsers) : [],
      kyc_rejected: kycRejectedUsers ? mapWithAttempts(kycRejectedUsers) : [],
      kyc_pending_active: kycPendingActiveUsers
        ? mapWithAttempts(kycPendingActiveUsers)
        : [],
      signed_up_only: signedUpOnlyUsers ? mapSignedUp(signedUpOnlyUsers) : [],
    };

    const show: Record<SummarySectionKey, boolean> = {
      fully_completed: enabled.has('fully_completed'),
      kyc_approved: enabled.has('kyc_approved'),
      kyc_rejected: enabled.has('kyc_rejected'),
      kyc_pending_active: enabled.has('kyc_pending_active'),
      signed_up_only: enabled.has('signed_up_only'),
    };

    const has_any_section = Object.values(show).some(Boolean);

    return {
      generated_at: fmt(new Date()) + ' UTC',
      window_label: windowLabel,
      total_users: totalUsers,
      plans,
      onboarding_funnel,
      kyc_status,
      sections,
      show,
      has_any_section,
      detail_limit: DETAIL_LIMIT,
    };
  }

  private async renderHtml(data: SummaryData): Promise<string> {
    if (!this.templateFn) {
      const templatePath = path.join(
        __dirname,
        '..',
        'templates',
        'user-summary.hbs',
      );
      const source = await fs.readFile(templatePath, 'utf-8');
      this.templateFn = Handlebars.compile(source);
    }
    return this.templateFn(data);
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser && this.browser.connected) {
      return this.browser;
    }
    this.browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    return this.browser;
  }

  private async renderPdf(html: string): Promise<Buffer> {
    const browser = await this.getBrowser();
    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: 'load' });
      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '18mm', bottom: '18mm', left: '14mm', right: '14mm' },
        displayHeaderFooter: true,
        headerTemplate: '<div></div>',
        footerTemplate: `
          <div style="font-size:9px;width:100%;padding:0 14mm;color:#64748b;display:flex;justify-content:space-between;">
            <span>Quantiva — User Summary</span>
            <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
          </div>
        `,
      });
      return Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);
    } finally {
      await page.close();
    }
  }
}
