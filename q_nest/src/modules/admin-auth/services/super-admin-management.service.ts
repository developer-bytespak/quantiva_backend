import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { UpdateFeeSettingsDto } from '../dto/update-admin-settings.dto';
import * as bcrypt from 'bcrypt';
import sgMail from '@sendgrid/mail';
import { SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { SuperAdminListUsersDto } from '../dto/super-admin-list-users.dto';
import { CreateVcPoolAdminDto } from '../dto/create-vc-pool-admin.dto';
import { SuperAdminUnifiedFinanceDto } from '../dto/super-admin-unified-finance.dto';
import { SuperAdminUsersGrowthDto } from '../dto/super-admin-users-growth.dto';
import { SubscriptionsService, PlanTier, BillingPeriod } from '../../subscriptions/subscriptions.service';

@Injectable()
export class SuperAdminManagementService {
  private readonly logger = new Logger(SuperAdminManagementService.name);
  private readonly allowedPoolStatuses = [
    'draft',
    'open',
    'full',
    'active',
    'completed',
    'cancelled',
  ] as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptionsService: SubscriptionsService,
  ) {
    const apiKey = process.env.SENDGRID_API_KEY;

    if (apiKey) {
      sgMail.setApiKey(apiKey);
    }
  }

  private readonly monthLabels = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];

  private async verifySuperAdminPassword(
    superAdminId: string,
    currentPassword: string,
  ): Promise<void> {
    const admin = await this.prisma.admins.findUnique({
      where: { admin_id: superAdminId },
      select: { password_hash: true, is_super_admin: true },
    });

    if (!admin || !admin.is_super_admin) {
      throw new UnauthorizedException('Super admin not found');
    }

    const isValid = await bcrypt.compare(currentPassword, admin.password_hash);
    if (!isValid) {
      throw new UnauthorizedException('Invalid current password');
    }
  }

  async listUsers(query: SuperAdminListUsersDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where = {
      ...(query.plan ? { current_tier: query.plan } : {}),
      ...(query.kyc_status ? { kyc_status: query.kyc_status } : {}),
      ...(query.search
        ? {
            OR: [
              { email: { contains: query.search, mode: 'insensitive' } },
              { username: { contains: query.search, mode: 'insensitive' } },
              { full_name: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(query.subscription_status
        ? {
            subscriptions: {
              some: {
                status: query.subscription_status as SubscriptionStatus,
              },
            },
          }
        : {}),
    };

    const [total, users] = await Promise.all([
      this.prisma.users.count({ where }),
      this.prisma.users.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
        select: {
          user_id: true,
          email: true,
          username: true,
          full_name: true,
          current_tier: true,
          kyc_status: true,
          created_at: true,
          sessions: {
            where: { revoked: false },
            orderBy: { issued_at: 'desc' },
            take: 1,
            select: { issued_at: true },
          },
          subscriptions: {
            orderBy: { created_at: 'desc' },
            take: 1,
            select: {
              status: true,
              tier: true,
              billing_period: true,
              current_period_end: true,
            },
          },
          pool_memberships: {
            where: { is_active: true },
            select: {
              invested_amount_usdt: true,
            },
          },
        },
      }),
    ]);

    return {
      users: users.map((user) => {
        const latestSubscription = user.subscriptions[0] ?? null;
        const lastSession = user.sessions[0] ?? null;
        const totalInvested = user.pool_memberships.reduce((sum, m) => {
          const value = Number(m.invested_amount_usdt ?? 0);
          if (!Number.isFinite(value)) return sum;
          return sum + value;
        }, 0);

        return {
          user_id: user.user_id,
          email: user.email,
          username: user.username,
          full_name: user.full_name,
          current_tier: user.current_tier,
          kyc_status: user.kyc_status,
          created_at: user.created_at,
          last_active_at: lastSession?.issued_at ?? null,
          subscription_status: latestSubscription?.status ?? null,
          subscription_plan: latestSubscription?.tier ?? null,
          billing_period: latestSubscription?.billing_period ?? null,
          subscription_period_end: latestSubscription?.current_period_end ?? null,
          total_invested_usdt: Number(totalInvested.toFixed(2)),
        };
      }),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  async usersAnalytics() {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [
      totalUsers,
      activeLast30Days,
      paidUsers,
      freeUsers,
      planDistribution,
      recentSignups,
      cryptoConnections,
      stockConnections,
      activeConnections,
      pendingConnections,
      recentSyncedUsers,
    ] = await Promise.all([
      this.prisma.users.count(),
      this.prisma.users.count({
        where: {
          sessions: {
            some: {
              issued_at: { gte: thirtyDaysAgo },
              revoked: false,
            },
          },
        },
      }),
      this.prisma.users.count({ where: { current_tier: { in: ['PRO', 'ELITE', 'ELITE_PLUS'] } } }),
      this.prisma.users.count({ where: { current_tier: 'FREE' } }),
      this.prisma.users.groupBy({
        by: ['current_tier'],
        _count: { current_tier: true },
      }),
      this.prisma.users.findMany({
        orderBy: { created_at: 'desc' },
        take: 10,
        select: {
          user_id: true,
          email: true,
          full_name: true,
          current_tier: true,
          created_at: true,
        },
      }),
      this.prisma.user_exchange_connections.count({
        where: {
          exchange: {
            type: 'crypto',
          },
        },
      }),
      this.prisma.user_exchange_connections.count({
        where: {
          exchange: {
            type: 'stocks',
          },
        },
      }),
      this.prisma.user_exchange_connections.count({
        where: {
          status: 'active',
        },
      }),
      this.prisma.user_exchange_connections.count({
        where: {
          status: 'pending',
        },
      }),
      this.prisma.user_exchange_connections.findMany({
        where: {
          last_synced_at: {
            not: null,
          },
        },
        orderBy: { last_synced_at: 'desc' },
        take: 5,
        select: {
          connection_id: true,
          status: true,
          last_synced_at: true,
          exchange: {
            select: {
              name: true,
              type: true,
            },
          },
          user: {
            select: {
              user_id: true,
              email: true,
              full_name: true,
            },
          },
        },
      }),
    ]);

    const distributionMap: Record<string, number> = {
      FREE: 0,
      PRO: 0,
      ELITE: 0,
      ELITE_PLUS: 0,
    };

    for (const item of planDistribution) {
      distributionMap[item.current_tier] = item._count.current_tier;
    }

    return {
      summary: {
        total_users: totalUsers,
        active_last_30_days: activeLast30Days,
        paid_users: paidUsers,
        free_users: freeUsers,
      },
      plan_distribution: distributionMap,
      recent_signups: recentSignups,
      exchange_connections: {
        crypto_connections: cryptoConnections,
        stock_connections: stockConnections,
        active_connections: activeConnections,
        pending_connections: pendingConnections,
        recent_synced_users: recentSyncedUsers.map((item) => ({
          connection_id: item.connection_id,
          status: item.status,
          last_synced_at: item.last_synced_at,
          exchange_name: item.exchange.name,
          exchange_type: item.exchange.type,
          user_id: item.user.user_id,
          email: item.user.email,
          full_name: item.user.full_name,
        })),
      },
    };
  }

  async usersGrowthByMonth(query: SuperAdminUsersGrowthDto) {
    const now = new Date();
    const year = query.year ?? now.getFullYear();

    const yearStart = new Date(Date.UTC(year, 0, 1, 0, 0, 0));
    const yearEnd = new Date(Date.UTC(year + 1, 0, 1, 0, 0, 0));

    const activeCutoff = new Date();
    activeCutoff.setDate(activeCutoff.getDate() - 30);

    const where = {
      created_at: {
        gte: yearStart,
        lt: yearEnd,
      },
      ...(query.subscription_plan
        ? {
            current_tier: query.subscription_plan,
          }
        : {}),
      ...(query.active_only
        ? {
            sessions: {
              some: {
                revoked: false,
                issued_at: { gte: activeCutoff },
              },
            },
          }
        : {}),
    };

    const [users, firstUser] = await Promise.all([
      this.prisma.users.findMany({
        where,
        select: { created_at: true },
      }),
      this.prisma.users.findFirst({
        select: { created_at: true },
        orderBy: { created_at: 'asc' },
      }),
    ]);

    const monthCounts = new Array(12).fill(0) as number[];
    for (const user of users) {
      const monthIndex = new Date(user.created_at).getUTCMonth();
      if (monthIndex >= 0 && monthIndex < 12) {
        monthCounts[monthIndex] += 1;
      }
    }

    let cumulative = 0;
    const monthly = monthCounts.map((count, index) => {
      cumulative += count;
      return {
        month: index + 1,
        label: this.monthLabels[index],
        users: count,
        cumulative_users: cumulative,
      };
    });

    const startYear = firstUser
      ? new Date(firstUser.created_at).getUTCFullYear()
      : now.getFullYear();
    const available_years: number[] = [];
    for (let y = now.getFullYear(); y >= startYear; y -= 1) {
      available_years.push(y);
    }

    return {
      year,
      filters: {
        subscription_plan: query.subscription_plan ?? 'ALL',
        active_only: !!query.active_only,
      },
      total_users: users.length,
      monthly,
      available_years,
    };
  }

  async listVcPoolAdmins() {
    const admins = await this.prisma.admins.findMany({
      orderBy: { created_at: 'desc' },
      select: {
        admin_id: true,
        email: true,
        full_name: true,
        is_super_admin: true,
        created_at: true,
        _count: {
          select: {
            pools: {
              where: {
                is_archived: false,
              },
            },
          },
        },
      },
    });

    return {
      admins: admins.map((admin) => ({
        admin_id: admin.admin_id,
        email: admin.email,
        full_name: admin.full_name,
        is_super_admin: admin.is_super_admin,
        created_at: admin.created_at,
        active_pools_count: admin._count.pools,
      })),
    };
  }

  async listPoolsOversight(query?: {
    status?: string;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, query?.page ?? 1);
    const limit = Math.min(100, Math.max(1, query?.limit ?? 20));
    const skip = (page - 1) * limit;

    const where: { is_archived: boolean; status?: (typeof this.allowedPoolStatuses)[number] } = {
      is_archived: false,
    };

    if (query?.status) {
      const normalizedStatus = query.status.toLowerCase();
      if (!this.allowedPoolStatuses.includes(normalizedStatus as (typeof this.allowedPoolStatuses)[number])) {
        throw new BadRequestException('Invalid pool status filter');
      }

      where.status = normalizedStatus as (typeof this.allowedPoolStatuses)[number];
    }

    const [total, pools, groupedByStatus] = await Promise.all([
      this.prisma.vc_pools.count({ where }),
      this.prisma.vc_pools.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
        select: {
          pool_id: true,
          admin_id: true,
          name: true,
          status: true,
          coin_type: true,
          contribution_amount: true,
          max_members: true,
          verified_members_count: true,
          reserved_seats_count: true,
          duration_days: true,
          pool_fee_percent: true,
          is_replica: true,
          started_at: true,
          end_date: true,
          total_invested_usdt: true,
          current_pool_value_usdt: true,
          total_profit_usdt: true,
          created_at: true,
          admin: {
            select: {
              full_name: true,
              email: true,
              is_super_admin: true,
            },
          },
          _count: {
            select: {
              members: true,
              seat_reservations: true,
              trades: true,
            },
          },
        },
      }),
      this.prisma.vc_pools.groupBy({
        by: ['status'],
        where: { is_archived: false },
        _count: { _all: true },
      }),
    ]);

    const statusSummary = {
      draft: 0,
      open: 0,
      full: 0,
      active: 0,
      completed: 0,
      cancelled: 0,
    };

    for (const row of groupedByStatus) {
      statusSummary[row.status] = row._count._all;
    }

    const totalInvestedUsdt = pools.reduce((sum, pool) => {
      const value = Number(pool.total_invested_usdt ?? 0);
      return Number.isFinite(value) ? sum + value : sum;
    }, 0);

    const currentValueUsdt = pools.reduce((sum, pool) => {
      const value = Number(pool.current_pool_value_usdt ?? 0);
      return Number.isFinite(value) ? sum + value : sum;
    }, 0);

    const totalProfitUsdt = pools.reduce((sum, pool) => {
      const value = Number(pool.total_profit_usdt ?? 0);
      return Number.isFinite(value) ? sum + value : sum;
    }, 0);

    return {
      summary: {
        total_pools: total,
        ...statusSummary,
        total_invested_usdt: Number(totalInvestedUsdt.toFixed(2)),
        current_value_usdt: Number(currentValueUsdt.toFixed(2)),
        total_profit_usdt: Number(totalProfitUsdt.toFixed(2)),
      },
      pools: pools.map((pool) => ({
        pool_id: pool.pool_id,
        admin_id: pool.admin_id,
        owner_name: pool.admin.full_name,
        owner_email: pool.admin.email,
        owner_is_super_admin: pool.admin.is_super_admin,
        name: pool.name,
        status: pool.status,
        coin_type: pool.coin_type,
        contribution_amount: pool.contribution_amount,
        max_members: pool.max_members,
        verified_members_count: pool.verified_members_count,
        reserved_seats_count: pool.reserved_seats_count,
        duration_days: pool.duration_days,
        pool_fee_percent: pool.pool_fee_percent,
        is_replica: pool.is_replica,
        started_at: pool.started_at,
        end_date: pool.end_date,
        total_invested_usdt: pool.total_invested_usdt,
        current_pool_value_usdt: pool.current_pool_value_usdt,
        total_profit_usdt: pool.total_profit_usdt,
        created_at: pool.created_at,
        counts: {
          members: pool._count.members,
          reservations: pool._count.seat_reservations,
          trades: pool._count.trades,
        },
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  async getUnifiedFinance(query: SuperAdminUnifiedFinanceDto) {
    const now = new Date();
    const selectedYear = query.year ?? now.getUTCFullYear();
    const selectedVcCollectionSource = query.vc_collection_source ?? 'ALL';
    const monthFormatter = new Intl.DateTimeFormat('en-US', { month: 'short' });
    const yearStart = new Date(Date.UTC(selectedYear, 0, 1, 0, 0, 0));
    const yearEnd = new Date(Date.UTC(selectedYear + 1, 0, 1, 0, 0, 0));

    const firstPayment = await this.prisma.payment_history.findFirst({
      orderBy: { created_at: 'asc' },
      select: { created_at: true },
    });

    const earliestYear = firstPayment
      ? new Date(firstPayment.created_at).getUTCFullYear()
      : now.getUTCFullYear();
    const availableYears: number[] = [];
    for (let y = now.getUTCFullYear(); y >= earliestYear; y -= 1) {
      availableYears.push(y);
    }

    const monthStarts: Date[] = [];
    for (let i = 0; i < 12; i += 1) {
      monthStarts.push(new Date(Date.UTC(selectedYear, i, 1, 0, 0, 0)));
    }

    const monthlySubscriptionRevenue = monthStarts.map((d) => ({
      key: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`,
      label: monthFormatter.format(d),
      value: 0,
    }));

    const amountKey = (value: number) => value.toFixed(2);

    const subscriptionPlans = await this.prisma.subscription_plans.findMany({
      select: {
        tier: true,
        billing_period: true,
        price: true,
      },
    });

    const amountToPlanMeta = new Map<
      string,
      Array<{ tier: string; billing_period: string }>
    >();

    for (const plan of subscriptionPlans) {
      const candidates = [Number(plan.price ?? 0)].filter((price) => Number.isFinite(price) && price > 0);

      for (const price of candidates) {
        const key = amountKey(price);
        const existing = amountToPlanMeta.get(key) ?? [];
        existing.push({ tier: plan.tier, billing_period: plan.billing_period });
        amountToPlanMeta.set(key, existing);
      }
    }

    const matchesSelectedPlan = (amount: number): boolean => {
      if (!query.plan_tier && !query.billing_period) return true;

      const candidates = amountToPlanMeta.get(amountKey(amount)) ?? [];
      if (!candidates.length) return false;

      return candidates.some(
        (item) =>
          (!query.plan_tier || item.tier === query.plan_tier) &&
          (!query.billing_period || item.billing_period === query.billing_period),
      );
    };

    const subscriptionPayments = await this.prisma.payment_history.findMany({
      where: {
        created_at: {
          gte: yearStart,
          lt: yearEnd,
        },
      },
      select: {
        amount: true,
        status: true,
        created_at: true,
        paid_at: true,
        subscription: {
          select: {
            tier: true,
            billing_period: true,
          },
        },
      },
      orderBy: {
        created_at: 'asc',
      },
    });

    const tradeFees = await this.prisma.trade_fees.findMany({
      where: {
        created_at: {
          gte: yearStart,
          lt: yearEnd,
        },
      },
      select: {
        fee_amount_usd: true,
        status: true,
        created_at: true,
      },
      orderBy: {
        created_at: 'asc',
      },
    });

    const [vcJoinFees, vcCancellationFees, vcCompletionFees] = await Promise.all([
      this.prisma.vc_pool_payment_submissions.findMany({
        where: {
          status: 'verified' as any,
          OR: [
            {
              verified_at: {
                gte: yearStart,
                lt: yearEnd,
              },
            },
            {
              submitted_at: {
                gte: yearStart,
                lt: yearEnd,
              },
            },
          ],
        },
        select: {
          pool_fee_amount: true,
          verified_at: true,
          submitted_at: true,
        },
        orderBy: {
          submitted_at: 'asc',
        },
      }),
      this.prisma.vc_pool_cancellations.findMany({
        where: {
          status: {
            in: ['approved', 'processed'] as any,
          },
          OR: [
            {
              reviewed_at: {
                gte: yearStart,
                lt: yearEnd,
              },
            },
            {
              requested_at: {
                gte: yearStart,
                lt: yearEnd,
              },
            },
          ],
        },
        select: {
          fee_amount: true,
          reviewed_at: true,
          requested_at: true,
        },
        orderBy: {
          requested_at: 'asc',
        },
      }),
      this.prisma.vc_pool_payouts.findMany({
        where: {
          payout_type: 'completion' as any,
          created_at: {
            gte: yearStart,
            lt: yearEnd,
          },
        },
        select: {
          admin_fee_deducted: true,
          created_at: true,
        },
        orderBy: {
          created_at: 'asc',
        },
      }),
    ]);

    let subscriptionTotal = 0;
    const subscriptionStatusCount = {
      succeeded: 0,
      pending: 0,
      failed: 0,
      refunded: 0,
      cancelled: 0,
    };
    const subscriptionPlanCount = {
      FREE: 0,
      PRO: 0,
      ELITE: 0,
    };

    const monthlyTradeFeesRevenue = monthStarts.map((d) => ({
      key: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`,
      label: monthFormatter.format(d),
      value: 0,
    }));

    const monthlyVcCollectionsRevenue = monthStarts.map((d) => ({
      key: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`,
      label: monthFormatter.format(d),
      value: 0,
    }));

    const tradeFeesSummary = {
      total_amount: 0,
      pending_count: 0,
      paid_count: 0,
      failed_count: 0,
    };

    const vcCollectionSummary = {
      total_amount: 0,
      join_fee_amount: 0,
      cancel_fee_amount: 0,
      completion_fee_amount: 0,
      join_count: 0,
      cancel_count: 0,
      completion_count: 0,
    };

    const shouldIncludeVcSource = (source: 'JOIN' | 'CANCEL' | 'COMPLETION') =>
      selectedVcCollectionSource === 'ALL' || selectedVcCollectionSource === source;

    const addVcCollectionAmount = (date: Date, amount: number) => {
      const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
      const target = monthlyVcCollectionsRevenue.find((row) => row.key === key);
      if (target) {
        target.value += amount;
      }
    };

    for (const payment of subscriptionPayments) {
      const amountNumber = Number(payment.amount ?? 0);
      if (!Number.isFinite(amountNumber) || !matchesSelectedPlan(amountNumber)) {
        continue;
      }

      if (payment.status in subscriptionStatusCount) {
        subscriptionStatusCount[payment.status] += 1;
      }

      if (payment.status === 'succeeded') {
        const value = amountNumber;
        if (Number.isFinite(value)) {
          subscriptionTotal += value;
        }

        const dt = payment.paid_at ?? payment.created_at;
        const key = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
        const target = monthlySubscriptionRevenue.find((row) => row.key === key);
        if (target) {
          target.value += value;
        }

        const tier = payment.subscription?.tier;
        if (tier && tier in subscriptionPlanCount) {
          subscriptionPlanCount[tier] += 1;
        }
      }
    }

    for (const fee of tradeFees) {
      const amount = Number(fee.fee_amount_usd ?? 0);
      if (Number.isFinite(amount)) {
        tradeFeesSummary.total_amount += amount;
      }

      if (fee.status === 'pending') tradeFeesSummary.pending_count += 1;
      if (fee.status === 'paid') tradeFeesSummary.paid_count += 1;
      if (fee.status === 'failed') tradeFeesSummary.failed_count += 1;

      const key = `${fee.created_at.getUTCFullYear()}-${String(
        fee.created_at.getUTCMonth() + 1,
      ).padStart(2, '0')}`;
      const target = monthlyTradeFeesRevenue.find((row) => row.key === key);
      if (target && Number.isFinite(amount)) {
        target.value += amount;
      }
    }

    for (const submission of vcJoinFees) {
      const amount = Number(submission.pool_fee_amount ?? 0);
      const effectiveDate = submission.verified_at ?? submission.submitted_at;

      if (!Number.isFinite(amount) || effectiveDate.getUTCFullYear() !== selectedYear) {
        continue;
      }

      if (!shouldIncludeVcSource('JOIN')) {
        continue;
      }

      vcCollectionSummary.join_fee_amount += amount;
      vcCollectionSummary.join_count += 1;
      vcCollectionSummary.total_amount += amount;
      addVcCollectionAmount(effectiveDate, amount);
    }

    for (const cancellation of vcCancellationFees) {
      const amount = Number(cancellation.fee_amount ?? 0);
      const effectiveDate = cancellation.reviewed_at ?? cancellation.requested_at;

      if (!Number.isFinite(amount) || effectiveDate.getUTCFullYear() !== selectedYear) {
        continue;
      }

      if (!shouldIncludeVcSource('CANCEL')) {
        continue;
      }

      vcCollectionSummary.cancel_fee_amount += amount;
      vcCollectionSummary.cancel_count += 1;
      vcCollectionSummary.total_amount += amount;
      addVcCollectionAmount(effectiveDate, amount);
    }

    for (const payout of vcCompletionFees) {
      const amount = Number(payout.admin_fee_deducted ?? 0);
      if (!Number.isFinite(amount) || amount <= 0 || payout.created_at.getUTCFullYear() !== selectedYear) {
        continue;
      }

      if (!shouldIncludeVcSource('COMPLETION')) {
        continue;
      }

      vcCollectionSummary.completion_fee_amount += amount;
      vcCollectionSummary.completion_count += 1;
      vcCollectionSummary.total_amount += amount;
      addVcCollectionAmount(payout.created_at, amount);
    }

    tradeFeesSummary.total_amount = Number(tradeFeesSummary.total_amount.toFixed(2));

    vcCollectionSummary.total_amount = Number(vcCollectionSummary.total_amount.toFixed(2));
    vcCollectionSummary.join_fee_amount = Number(vcCollectionSummary.join_fee_amount.toFixed(2));
    vcCollectionSummary.cancel_fee_amount = Number(vcCollectionSummary.cancel_fee_amount.toFixed(2));
    vcCollectionSummary.completion_fee_amount = Number(
      vcCollectionSummary.completion_fee_amount.toFixed(2),
    );

    // const payoutsSeries = [1600, 1800, 2100, 2400, 2850, 4100, 4300, 4500, 4700, 4900, 5100, 5300];
    // const treasurySeries = [9200, 10300, 11100, 12300, 12800, 14800, 15200, 15800, 16500, 17100, 17800, 18600];

    const groups = [
      {
        key: 'SUBSCRIPTION',
        title: 'Subscription',
        is_dummy: false,
        summary: {
          total_amount: Number(subscriptionTotal.toFixed(2)),
          succeeded_count: subscriptionStatusCount.succeeded,
          pending_count: subscriptionStatusCount.pending,
          failed_count: subscriptionStatusCount.failed,
          refunded_count: subscriptionStatusCount.refunded,
          cancelled_count: subscriptionStatusCount.cancelled,
        },
        chart: monthlySubscriptionRevenue.map((row) => ({
          label: row.label,
          value: Number(row.value.toFixed(2)),
        })),
        meta: {
          plan_distribution: subscriptionPlanCount,
        },
      },
      {
        key: 'TRADE_FEES',
        title: 'Trade Fees',
        is_dummy: false,
        summary: tradeFeesSummary,
        chart: monthlyTradeFeesRevenue.map((row) => ({
          label: row.label,
          value: Number(row.value.toFixed(2)),
        })),
      },
      {
        key: 'VC_POOL_COLLECTIONS',
        title: 'VC Pool Collections',
        is_dummy: false,
        summary: vcCollectionSummary,
        chart: monthlyVcCollectionsRevenue.map((row) => ({
          label: row.label,
          value: Number(row.value.toFixed(2)),
        })),
        meta: {
          applied_source: selectedVcCollectionSource,
        },
      },
      // {
      //   key: 'VC_POOL_PAYOUTS_REFUNDS',
      //   title: 'VC Pool Payouts & Refunds',
      //   is_dummy: true,
      //   summary: {
      //     total_payouts: 12900,
      //     total_refunds: 2350,
      //     pending_payouts_count: 9,
      //     completed_payouts_count: 73,
      //   },
      //   chart: [
      //     ...monthlySubscriptionRevenue.map((row, index) => ({
      //       label: row.label,
      //       value: payoutsSeries[index] ?? 0,
      //     })),
      //   ],
      //   meta: {
      //     note: 'Dummy data',
      //   },
      // },
      // {
      //   key: 'TREASURY_BINANCE',
      //   title: 'Treasury Binance',
      //   is_dummy: true,
      //   summary: {
      //     total_deposits: 84500,
      //     total_withdrawals: 22700,
      //     net_movement: 61800,
      //   },
      //   chart: [
      //     ...monthlySubscriptionRevenue.map((row, index) => ({
      //       label: row.label,
      //       value: treasurySeries[index] ?? 0,
      //     })),
      //   ],
      //   meta: {
      //     note: 'Dummy data',
      //   },
      // },
    ];

    const subscriptionSummary = groups[0].summary as Record<string, number>;
    const tradeFeesSummaryRecord = groups[1].summary as Record<string, number>;
    const vcCollectionSummaryRecord = groups[2].summary as Record<string, number>;

    const totalInflow =
      Number(subscriptionSummary.total_amount || 0) +
      Number(tradeFeesSummaryRecord.total_amount || 0) +
      Number(vcCollectionSummaryRecord.total_amount || 0);
    const totalOutflow = 0;

    return {
      overview: {
        total_inflow: Number(totalInflow.toFixed(2)),
        total_outflow: Number(totalOutflow.toFixed(2)),
        net_revenue: Number((totalInflow - totalOutflow).toFixed(2)),
      },
      filters: {
        year: selectedYear,
        plan_tier: query.plan_tier ?? 'ALL',
        billing_period: query.billing_period ?? 'ALL',
        vc_collection_source: selectedVcCollectionSource,
      },
      available_years: availableYears,
      groups,
    };
  }

  async createVcPoolAdmin(superAdminId: string, dto: CreateVcPoolAdminDto) {
    await this.verifySuperAdminPassword(superAdminId, dto.currentPassword);

    const normalizedEmail = dto.email.toLowerCase().trim();

    const exists = await this.prisma.admins.findUnique({
      where: { email: normalizedEmail },
      select: { admin_id: true },
    });

    if (exists) {
      throw new BadRequestException('Admin with this email already exists');
    }

    const superAdmin = await this.prisma.admins.findUnique({
      where: { admin_id: superAdminId },
      select: { full_name: true, email: true },
    });

    const password_hash = await bcrypt.hash(dto.password, 10);

    const created = await this.prisma.admins.create({
      data: {
        email: normalizedEmail,
        password_hash,
        full_name: dto.full_name?.trim() || null,
        is_super_admin: dto.is_super_admin ?? false,
      },
      select: {
        admin_id: true,
        email: true,
        full_name: true,
        is_super_admin: true,
        created_at: true,
      },
    });

    const frontendBaseUrl = (process.env.FRONTEND_URL || '').trim();
    const loginUrl = frontendBaseUrl
      ? `${frontendBaseUrl.replace(/\/$/, '')}/admin`
      : '/admin';
    const fromEmail = process.env.SENDGRID_FROM_EMAIL || process.env.SMTP_FROM_EMAIL;
    const senderName = superAdmin?.full_name?.trim() || 'Quantiva Super Admin';

    if (!fromEmail) {
      await this.prisma.admins.delete({ where: { admin_id: created.admin_id } });
      throw new BadRequestException('Email service is not configured');
    }

    try {
      await sgMail.send({
        to: created.email,
        from: {
          email: fromEmail,
          name: senderName,
        },
        subject: 'Your Quantiva VC Pool Admin Account',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="background: linear-gradient(135deg, #fc4f02 0%, #fda300 100%); padding: 30px; border-radius: 10px 10px 0 0;">
              <h1 style="color: white; margin: 0; text-align: center;">Quantiva</h1>
            </div>
            <div style="background: #ffffff; padding: 30px; border-radius: 0 0 10px 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
              <h2 style="color: #333; margin-top: 0;">Your VC Pool Admin Account Is Ready</h2>
              <p style="color: #666; font-size: 16px;">Hello${created.full_name ? ` ${created.full_name}` : ''},</p>
              <p style="color: #666; font-size: 16px;">
                ${senderName} has created your Quantiva VC Pool Admin account.
              </p>
              <div style="background: #f8f8f8; border: 1px solid #ececec; border-radius: 8px; padding: 18px; margin: 20px 0;">
                <p style="margin: 0 0 10px; color: #333;"><strong>Email:</strong> ${created.email}</p>
                <p style="margin: 0; color: #333;"><strong>Password:</strong> ${dto.password}</p>
              </div>
              <p style="color: #666; font-size: 16px;">Admin login link:</p>
              <p style="margin: 16px 0;">
                <a href="${loginUrl}" style="display: inline-block; background: #fc4f02; color: #ffffff; text-decoration: none; padding: 12px 20px; border-radius: 8px; font-weight: 700;">Open Admin Login</a>
              </p>
              <p style="color: #999; font-size: 12px; margin-top: 30px;">For security, please sign in and change your password as soon as possible.</p>
            </div>
          </div>
        `,
      });
    } catch (error) {
      await this.prisma.admins.delete({ where: { admin_id: created.admin_id } });

      this.logger.error('Failed to send VC pool admin credentials email', {
        email: created.email,
        superAdminId,
        superAdminEmail: superAdmin?.email,
        error: error instanceof Error ? error.message : String(error),
      });

      throw new BadRequestException(
        'Failed to send admin credentials email. Admin was not created.',
      );
    }

    return {
      message: 'VC pool admin created successfully',
      admin: created,
    };
  }

  async deleteVcPoolAdmin(
    superAdminId: string,
    targetAdminId: string,
    currentPassword: string,
  ) {
    await this.verifySuperAdminPassword(superAdminId, currentPassword);

    const superAdmin = await this.prisma.admins.findUnique({
      where: { admin_id: superAdminId },
      select: { full_name: true, email: true },
    });

    if (superAdminId === targetAdminId) {
      throw new BadRequestException('You cannot delete your own admin account');
    }

    const target = await this.prisma.admins.findUnique({
      where: { admin_id: targetAdminId },
      select: {
        admin_id: true,
        email: true,
        full_name: true,
        is_super_admin: true,
        _count: {
          select: {
            pools: {
              where: {
                is_archived: false,
              },
            },
          },
        },
      },
    });

    if (!target) {
      throw new NotFoundException('Target admin not found');
    }

    if (target.is_super_admin) {
      throw new BadRequestException('Super admin cannot be deleted from this action');
    }

    if (target._count.pools > 0) {
      throw new BadRequestException(
        'Cannot delete admin with active pools. Reassign/archive pools first.',
      );
    }

    await this.prisma.admins.delete({ where: { admin_id: targetAdminId } });

    const fromEmail = process.env.SENDGRID_FROM_EMAIL || process.env.SMTP_FROM_EMAIL;
    const senderName = superAdmin?.full_name?.trim() || 'Quantiva Super Admin';

    if (fromEmail) {
      try {
        await sgMail.send({
          to: target.email,
          from: {
            email: fromEmail,
            name: senderName,
          },
          subject: 'Your Quantiva VC Pool Admin Account Has Been Removed',
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
              <div style="background: linear-gradient(135deg, #fc4f02 0%, #fda300 100%); padding: 30px; border-radius: 10px 10px 0 0;">
                <h1 style="color: white; margin: 0; text-align: center;">Quantiva</h1>
              </div>
              <div style="background: #ffffff; padding: 30px; border-radius: 0 0 10px 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
                <h2 style="color: #333; margin-top: 0;">VC Pool Admin Account Removed</h2>
                <p style="color: #666; font-size: 16px;">Hello${target.full_name ? ` ${target.full_name}` : ''},</p>
                <p style="color: #666; font-size: 16px;">
                  ${senderName} has removed your Quantiva VC Pool Admin account.
                </p>
                <p style="color: #666; font-size: 16px; margin-top: 18px;">
                  If you believe this was done in error, please contact the Quantiva super admin team.
                </p>
                <p style="color: #999; font-size: 12px; margin-top: 30px;">This is an automated notification from Quantiva.</p>
              </div>
            </div>
          `,
        });
      } catch (error) {
        this.logger.error('Failed to send VC pool admin deletion email', {
          email: target.email,
          superAdminId,
          superAdminEmail: superAdmin?.email,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      message: 'VC pool admin deleted successfully',
      admin_id: targetAdminId,
      email: target.email,
    };
  }

  // ── Super Admin: Update global default fees for all VC pool admins ──

  async updateGlobalDefaultFees(
    superAdminId: string,
    dto: UpdateFeeSettingsDto,
  ) {
    await this.verifySuperAdminPassword(superAdminId, dto.currentPassword);

    // Update all non-super admins' default fees
    const result = await this.prisma.admins.updateMany({
      // where: { is_super_admin: false },
      data: {
        default_pool_fee_percent: dto.default_pool_fee_percent,
        default_admin_profit_fee_percent: dto.default_admin_profit_fee_percent,
        default_cancellation_fee_percent: dto.default_cancellation_fee_percent,
        default_payment_window_minutes: dto.default_payment_window_minutes,
      },
    });

    this.logger.log(
      `Super admin ${superAdminId} updated global default fees for ${result.count} admins`,
    );

    return {
      message: `Default fees updated for ${result.count} VC pool admin(s)`,
      updated_count: result.count,
      default_pool_fee_percent: dto.default_pool_fee_percent,
      default_admin_profit_fee_percent: dto.default_admin_profit_fee_percent,
      default_cancellation_fee_percent: dto.default_cancellation_fee_percent,
      default_payment_window_minutes: dto.default_payment_window_minutes,
    };
  }

  // ── Super Admin: Upgrade any user's subscription by email ──

  async lookupUserByEmail(email: string) {
    const normalizedEmail = email.toLowerCase().trim();

    const user = await this.prisma.users.findFirst({
      where: { email: normalizedEmail },
      select: {
        user_id: true,
        email: true,
        username: true,
        current_tier: true,
        nationality: true,
      },
    });

    if (!user) {
      return { found: false, is_us_user: false };
    }

    const normalized = (user.nationality ?? '').toLowerCase().trim();
    const isUsUser = ['us', 'usa', 'united states', 'united states of america'].includes(normalized);

    return {
      found: true,
      is_us_user: isUsUser,
      email: user.email,
      username: user.username,
      current_tier: user.current_tier,
    };
  }

  async searchUsers(query: string) {
    const trimmed = query.trim();
    if (trimmed.length < 4) {
      return { results: [] };
    }

    const users = await this.prisma.users.findMany({
      where: {
        OR: [
          { email: { contains: trimmed, mode: 'insensitive' } },
          { username: { contains: trimmed, mode: 'insensitive' } },
        ],
      },
      select: {
        email: true,
        username: true,
        current_tier: true,
        nationality: true,
      },
      take: 10,
      orderBy: { email: 'asc' },
    });

    return {
      results: users.map((u) => {
        const normalized = (u.nationality ?? '').toLowerCase().trim();
        const isUsUser = ['us', 'usa', 'united states', 'united states of america'].includes(normalized);
        return {
          email: u.email,
          username: u.username,
          current_tier: u.current_tier,
          is_us_user: isUsUser,
        };
      }),
    };
  }

  async adminUpgradeUserSubscription(data: {
    email: string;
    tier: PlanTier;
    billing_period: BillingPeriod;
  }) {
    const normalizedEmail = data.email.toLowerCase().trim();

    // 1. Find user by email
    const user = await this.prisma.users.findFirst({
      where: { email: normalizedEmail },
      select: {
        user_id: true,
        email: true,
        username: true,
        full_name: true,
        current_tier: true,
      },
    });

    if (!user) {
      throw new NotFoundException(`User with email "${normalizedEmail}" not found`);
    }

    // 2. Find the plan
    const plan = await this.prisma.subscription_plans.findFirst({
      where: { tier: data.tier, billing_period: data.billing_period },
    });

    if (!plan) {
      throw new NotFoundException(
        `Plan ${data.tier} (${data.billing_period}) not found in the database`,
      );
    }

    // 3. Cancel any existing active subscriptions
    const existingActive = await this.prisma.user_subscriptions.findMany({
      where: { user_id: user.user_id, status: 'active' },
    });

    if (existingActive.length > 0) {
      await this.prisma.user_subscriptions.updateMany({
        where: { user_id: user.user_id, status: 'active' },
        data: {
          status: 'cancelled',
          cancelled_at: new Date(),
          auto_renew: false,
        },
      });
    }

    // 4. Create new subscription via SubscriptionsService (handles all logic)
    const newSubscription = await this.subscriptionsService.createSubscription({
      user_id: user.user_id,
      plan_id: plan.plan_id,
      status: 'active',
      billing_provider: 'admin_override',
      auto_renew: false,
    });

    this.logger.log(
      `Super admin upgraded user ${user.email} to ${data.tier} (${data.billing_period}). Subscription ID: ${newSubscription.subscription_id}`,
    );

    return {
      message: `User ${user.email} successfully upgraded to ${data.tier} (${data.billing_period})`,
      user: {
        user_id: user.user_id,
        email: user.email,
        username: user.username,
        full_name: user.full_name,
        previous_tier: user.current_tier,
        new_tier: data.tier,
      },
      subscription: {
        subscription_id: newSubscription.subscription_id,
        tier: newSubscription.tier,
        billing_period: newSubscription.billing_period,
        status: newSubscription.status,
        current_period_start: newSubscription.current_period_start,
        current_period_end: newSubscription.current_period_end,
        billing_provider: newSubscription.billing_provider,
      },
    };
  }
}
