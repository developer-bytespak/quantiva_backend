import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';

type Range = 30 | 90 | 365;

@Injectable()
export class AffiliateStatsService {
  constructor(private prisma: PrismaService) {}

  /**
   * Stable short hash of a user_id for the affiliate-facing referrals table.
   * Affiliates should never see raw user_ids/emails of referred users.
   */
  private hashUserId(userId: string): string {
    return createHash('sha256').update(userId).digest('hex').slice(0, 10);
  }

  private monthKey(date: Date): string {
    return date.toISOString().slice(0, 7); // YYYY-MM
  }

  private dayKey(date: Date): string {
    return date.toISOString().slice(0, 10); // YYYY-MM-DD
  }

  /**
   * KPI tiles — totals + this-month vs last-month deltas.
   */
  async getSummary(affiliateId: string) {
    const now = new Date();
    const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth = startOfThisMonth;

    const affiliate = await this.prisma.affiliates.findUnique({
      where: { affiliate_id: affiliateId },
      select: {
        signup_count: true,
        conversion_count: true,
        revenue_generated: true,
        pending_balance: true,
        paid_total: true,
        clawed_back_total: true,
      },
    });
    if (!affiliate) {
      throw new Error('Affiliate not found');
    }

    const [
      currentMonthSignups,
      previousMonthSignups,
      currentMonthEarnings,
      previousMonthEarnings,
      activeSubscribers,
    ] = await Promise.all([
      this.prisma.affiliate_referrals.count({
        where: {
          affiliate_id: affiliateId,
          attributed_at: { gte: startOfThisMonth },
        },
      }),
      this.prisma.affiliate_referrals.count({
        where: {
          affiliate_id: affiliateId,
          attributed_at: { gte: startOfLastMonth, lt: endOfLastMonth },
        },
      }),
      this.prisma.affiliate_commission_events.aggregate({
        where: {
          affiliate_id: affiliateId,
          status: { in: ['ACCRUED', 'PAID'] },
          created_at: { gte: startOfThisMonth },
        },
        _sum: { commission_usd: true },
      }),
      this.prisma.affiliate_commission_events.aggregate({
        where: {
          affiliate_id: affiliateId,
          status: { in: ['ACCRUED', 'PAID'] },
          created_at: { gte: startOfLastMonth, lt: endOfLastMonth },
        },
        _sum: { commission_usd: true },
      }),
      this.countActiveSubscribers(affiliateId),
    ]);

    return {
      current_month: {
        signups: currentMonthSignups,
        earnings_usd: Number(currentMonthEarnings._sum.commission_usd ?? 0),
      },
      previous_month: {
        signups: previousMonthSignups,
        earnings_usd: Number(previousMonthEarnings._sum.commission_usd ?? 0),
      },
      totals: {
        signups: affiliate.signup_count,
        conversions: affiliate.conversion_count,
        active_subscribers: activeSubscribers,
        revenue_generated_usd: Number(affiliate.revenue_generated),
        pending_balance_usd: Number(affiliate.pending_balance),
        paid_total_usd: Number(affiliate.paid_total),
        clawed_back_total_usd: Number(affiliate.clawed_back_total),
      },
    };
  }

  /**
   * Daily series of signups + earnings across the requested window.
   * Returns one row per day (filled with zeros where there's no activity).
   */
  async getPerformance(affiliateId: string, range: Range) {
    const to = new Date();
    const from = new Date(to);
    from.setDate(from.getDate() - range);

    const [referrals, events] = await Promise.all([
      this.prisma.affiliate_referrals.findMany({
        where: {
          affiliate_id: affiliateId,
          attributed_at: { gte: from, lte: to },
        },
        select: { attributed_at: true },
      }),
      this.prisma.affiliate_commission_events.findMany({
        where: {
          affiliate_id: affiliateId,
          status: { in: ['ACCRUED', 'PAID'] },
          created_at: { gte: from, lte: to },
        },
        select: { created_at: true, commission_usd: true },
      }),
    ]);

    const buckets = new Map<
      string,
      { signups: number; earnings_usd: number }
    >();

    for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
      buckets.set(this.dayKey(d), { signups: 0, earnings_usd: 0 });
    }
    for (const r of referrals) {
      const key = this.dayKey(r.attributed_at);
      const bucket = buckets.get(key);
      if (bucket) bucket.signups += 1;
    }
    for (const e of events) {
      const key = this.dayKey(e.created_at);
      const bucket = buckets.get(key);
      if (bucket) bucket.earnings_usd += Number(e.commission_usd);
    }

    return {
      range,
      from: this.dayKey(from),
      to: this.dayKey(to),
      series: Array.from(buckets.entries()).map(([date, v]) => ({
        date,
        ...v,
      })),
    };
  }

  /**
   * Anonymized paginated list of referred users for the affiliate dashboard.
   */
  async getReferrals(affiliateId: string, page: number, pageSize: number) {
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
        select: {
          user_id: true,
          attributed_at: true,
          user: {
            select: { current_tier: true },
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
      _sum: { commission_usd: true },
    });
    const commissionByUser = new Map(
      commissions.map((c) => [c.user_id, Number(c._sum.commission_usd ?? 0)]),
    );

    const activeSubs = await this.prisma.user_subscriptions.findMany({
      where: {
        user_id: { in: userIds },
        status: 'active',
        tier: { not: 'FREE' },
      },
      select: { user_id: true },
    });
    const activeUserIds = new Set(activeSubs.map((s) => s.user_id));

    return {
      page,
      page_size: pageSize,
      total,
      items: referrals.map((r) => ({
        user_id_hash: this.hashUserId(r.user_id),
        signup_date: this.dayKey(r.attributed_at),
        current_tier: r.user.current_tier,
        lifetime_commissions_usd: commissionByUser.get(r.user_id) ?? 0,
        status: activeUserIds.has(r.user_id) ? 'Active' : 'Churned',
      })),
    };
  }

  /**
   * 3-step funnel: Signup → First payment → Active subscriber.
   */
  async getFunnel(affiliateId: string) {
    const referrals = await this.prisma.affiliate_referrals.findMany({
      where: { affiliate_id: affiliateId },
      select: { user_id: true },
    });
    const userIds = referrals.map((r) => r.user_id);
    if (userIds.length === 0) {
      return {
        steps: [
          { name: 'Signup', count: 0, rate: null },
          { name: 'First payment', count: 0, rate: 0 },
          { name: 'Active subscriber', count: 0, rate: 0 },
        ],
      };
    }

    const [paidUsers, activeUsers] = await Promise.all([
      this.prisma.payment_history.groupBy({
        by: ['user_id'],
        where: { user_id: { in: userIds }, status: 'succeeded' },
      }),
      this.prisma.user_subscriptions.findMany({
        where: {
          user_id: { in: userIds },
          status: 'active',
          tier: { not: 'FREE' },
        },
        select: { user_id: true },
        distinct: ['user_id'],
      }),
    ]);

    const signupCount = referrals.length;
    const firstPaymentCount = paidUsers.length;
    const activeCount = activeUsers.length;

    return {
      steps: [
        { name: 'Signup', count: signupCount, rate: null },
        {
          name: 'First payment',
          count: firstPaymentCount,
          rate: signupCount ? firstPaymentCount / signupCount : 0,
        },
        {
          name: 'Active subscriber',
          count: activeCount,
          rate: signupCount ? activeCount / signupCount : 0,
        },
      ],
    };
  }

  /**
   * Earnings breakdown — last 12 months + top earning referred users.
   */
  async getEarnings(affiliateId: string) {
    const now = new Date();
    const oneYearAgo = new Date(now);
    oneYearAgo.setMonth(now.getMonth() - 12);

    const events = await this.prisma.affiliate_commission_events.findMany({
      where: {
        affiliate_id: affiliateId,
        status: { in: ['ACCRUED', 'PAID'] },
        created_at: { gte: oneYearAgo },
      },
      select: {
        created_at: true,
        commission_usd: true,
        user_id: true,
      },
    });

    const byMonth = new Map<string, { earnings_usd: number; events: number }>();
    const byUser = new Map<string, { earnings_usd: number; events: number }>();

    for (const e of events) {
      const m = this.monthKey(e.created_at);
      const mb = byMonth.get(m) ?? { earnings_usd: 0, events: 0 };
      mb.earnings_usd += Number(e.commission_usd);
      mb.events += 1;
      byMonth.set(m, mb);

      const ub = byUser.get(e.user_id) ?? { earnings_usd: 0, events: 0 };
      ub.earnings_usd += Number(e.commission_usd);
      ub.events += 1;
      byUser.set(e.user_id, ub);
    }

    return {
      by_month: Array.from(byMonth.entries())
        .map(([month, v]) => ({ month, ...v }))
        .sort((a, b) => a.month.localeCompare(b.month)),
      by_referred_user: Array.from(byUser.entries())
        .map(([userId, v]) => ({
          user_id_hash: this.hashUserId(userId),
          ...v,
        }))
        .sort((a, b) => b.earnings_usd - a.earnings_usd)
        .slice(0, 20),
    };
  }

  /**
   * Cohort retention — for each signup month, total signups vs how many are
   * still active subscribers today. Heavier matrix (month-by-month retention)
   * deferred until volume justifies it.
   */
  async getCohorts(affiliateId: string) {
    const referrals = await this.prisma.affiliate_referrals.findMany({
      where: { affiliate_id: affiliateId },
      select: { user_id: true, attributed_at: true },
    });
    if (referrals.length === 0) {
      return { cohorts: [] };
    }

    const activeSubs = await this.prisma.user_subscriptions.findMany({
      where: {
        user_id: { in: referrals.map((r) => r.user_id) },
        status: 'active',
        tier: { not: 'FREE' },
      },
      select: { user_id: true },
      distinct: ['user_id'],
    });
    const activeUserIds = new Set(activeSubs.map((s) => s.user_id));

    const cohortMap = new Map<
      string,
      { total_signups: number; still_active: number }
    >();
    for (const r of referrals) {
      const month = this.monthKey(r.attributed_at);
      const c = cohortMap.get(month) ?? {
        total_signups: 0,
        still_active: 0,
      };
      c.total_signups += 1;
      if (activeUserIds.has(r.user_id)) c.still_active += 1;
      cohortMap.set(month, c);
    }

    return {
      cohorts: Array.from(cohortMap.entries())
        .map(([signup_month, v]) => ({
          signup_month,
          ...v,
          retention_rate: v.total_signups
            ? v.still_active / v.total_signups
            : 0,
        }))
        .sort((a, b) => a.signup_month.localeCompare(b.signup_month)),
    };
  }

  /**
   * Payouts page — balance + scheduled next payout + history.
   */
  async getPayoutsOverview(affiliateId: string) {
    const affiliate = await this.prisma.affiliates.findUnique({
      where: { affiliate_id: affiliateId },
      select: {
        pending_balance: true,
        paid_total: true,
        clawed_back_total: true,
      },
    });
    if (!affiliate) throw new Error('Affiliate not found');

    const settings = await this.prisma.affiliate_program_settings.findFirst({
      where: { is_active: true },
      orderBy: { version: 'desc' },
      select: { payout_threshold_usd: true, payout_cycle: true },
    });

    const payouts = await this.prisma.affiliate_payouts.findMany({
      where: { affiliate_id: affiliateId },
      orderBy: { created_at: 'desc' },
      take: 24,
      select: {
        payout_id: true,
        period: true,
        gross_usd: true,
        net_usd: true,
        status: true,
        payment_reference: true,
        created_at: true,
        paid_at: true,
      },
    });

    const now = new Date();
    const nextPayoutDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    return {
      balance: {
        pending_usd: Number(affiliate.pending_balance),
        paid_total_usd: Number(affiliate.paid_total),
        clawed_back_total_usd: Number(affiliate.clawed_back_total),
      },
      next_payout: {
        scheduled_for: this.dayKey(nextPayoutDate),
        threshold_usd: Number(settings?.payout_threshold_usd ?? 0),
        cycle: settings?.payout_cycle ?? 'MONTHLY',
        eligible:
          Number(affiliate.pending_balance) >=
          Number(settings?.payout_threshold_usd ?? 0),
      },
      history: payouts.map((p) => ({
        payout_id: p.payout_id,
        period: p.period,
        gross_usd: Number(p.gross_usd),
        net_usd: Number(p.net_usd),
        status: p.status,
        payment_reference: p.payment_reference,
        created_at: p.created_at,
        paid_at: p.paid_at,
      })),
    };
  }

  /**
   * Referral assets — code, link, QR payload. Marketing URL from FRONTEND_URL.
   */
  getReferralAssets(referralCode: string | null) {
    const base =
      (process.env.FRONTEND_URL || '').trim().replace(/\/+$/, '') ||
      'https://quantivahq.com';
    if (!referralCode) {
      return {
        referral_code: null,
        referral_link: null,
        qr_payload: null,
      };
    }
    const link = `${base}/?ref=${encodeURIComponent(referralCode)}`;
    return {
      referral_code: referralCode,
      referral_link: link,
      qr_payload: link,
    };
  }

  private async countActiveSubscribers(affiliateId: string): Promise<number> {
    const result = await this.prisma.user_subscriptions.findMany({
      where: {
        status: 'active',
        tier: { not: 'FREE' },
        user: { referred_by_affiliate_id: affiliateId },
      },
      select: { user_id: true },
      distinct: ['user_id'],
    });
    return result.length;
  }
}
