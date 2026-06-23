import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SubscriptionStatus } from '@prisma/client';
import { cursorTo } from 'readline';
import { NotificationsService } from '../notifications/notifications.service';
import { AuthEmailService } from '../auth/services/auth-email.service';
import { AppGateway } from 'src/gateways/app.gateway';
import { tryCatch } from 'bullmq';
import { SubscriptionLoaderMiddleware } from '../../common/middleware/subscription-loader.middleware';
import { OnboardingStateService } from '../onboarding-emails/services/onboarding-state.service';
import { FreeUpgradeCampaignService } from '../onboarding-emails/services/free-upgrade-campaign.service';
import { OnboardingState } from '../onboarding-emails/types';
import { AffiliateCommissionService } from '../affiliate/services/affiliate-commission.service';

export enum PlanTier {
  FREE = 'FREE',
  PRO = 'PRO',
  ELITE = 'ELITE',
  ELITE_PLUS = 'ELITE_PLUS',
}

export enum BillingPeriod {
  MONTHLY = 'MONTHLY',
  QUARTERLY = 'QUARTERLY',
  YEARLY = 'YEARLY',
}

export enum FeatureType {
  CUSTOM_STRATEGIES = "CUSTOM_STRATEGIES",
  VC_POOL_ACCESS = "VC_POOL_ACCESS",
  EARLY_ACCESS = "EARLY_ACCESS",
}


@Injectable()
export class SubscriptionsService implements OnModuleInit {
  private readonly logger = new Logger(SubscriptionsService.name);
  private plansCache: any[] | null = null;
  private plansGroupedCache: any[] | null = null;

  constructor(
    private prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly authEmailService: AuthEmailService,
    private readonly appGateway: AppGateway,
    private readonly onboardingStateService: OnboardingStateService,
    private readonly freeUpgradeCampaignService: FreeUpgradeCampaignService,
    private readonly affiliateCommissionService: AffiliateCommissionService,
    @Optional() private readonly subscriptionLoader?: SubscriptionLoaderMiddleware,
  ) { }

  /**
   * Clear the cached subscription for a user so the next request fetches fresh from DB.
   */
  private clearSubscriptionCache(userId: string): void {
    this.subscriptionLoader?.clearUserCache(userId);
  }

  async onModuleInit() {
    try {
      await this.refreshPlansCache();
      this.logger.log(`Plans cache loaded: ${this.plansCache?.length} plans`);
    } catch (error: any) {
      this.logger.warn(`Failed to preload plans cache: ${error.message}`);
    }
  }

  /** Reload plans from DB into memory. Call after admin updates a plan. */
  async refreshPlansCache(): Promise<void> {
    this.plansCache = await this.prisma.subscription_plans.findMany({
      orderBy: [{ tier: 'asc' }, { billing_period: 'asc' }],
    });
    this.plansGroupedCache = null; // clear grouped cache so it regenerates
  }

  /** True if string is a valid UUID format (so safe to use in plan_id lookup). */
  private isUuid(s: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
  }

  private getMonthlyPeriods(startDate: Date, endDate: Date): { start: Date; end: Date }[] {
    const periods: { start: Date; end: Date }[] = [];
    let currentStart = new Date(startDate);

    while (currentStart < endDate) {
      const currentEnd = new Date(currentStart);
      currentEnd.setMonth(currentEnd.getMonth() + 1);

      // Last period should not exceed subscription end date
      const periodEnd = currentEnd > endDate ? endDate : currentEnd;

      periods.push({
        start: new Date(currentStart),
        end: periodEnd,
      });

      currentStart = currentEnd;
    }

    return periods;
  }

  async findAllPlans() {
    if (this.plansCache) {
      return this.plansCache;
    }
    await this.refreshPlansCache();
    return this.plansCache!;
  }

  /**
   * Find all plans grouped by tier with pricing tiers
   */
  async findAllPlansGrouped() {
    if (this.plansGroupedCache) {
      return this.plansGroupedCache;
    }

    const allPlans = await this.findAllPlans();
    const grouped: any = {};

    allPlans.forEach((plan: any) => {
      if (!grouped[plan.tier]) {
        grouped[plan.tier] = {
          tier: plan.tier,
          name: plan.name,
          description: plan.description,
          base_price: plan.base_price,
          is_active: plan.is_active,
          display_order: plan.display_order,
          created_at: plan.created_at,
          pricing: {},
        };
      }

      grouped[plan.tier].pricing[plan.billing_period] = {
        price: plan.price,
        discount_percent: plan.discount_percent,
      };
    });

    this.plansGroupedCache = Object.values(grouped);
    return this.plansGroupedCache;
  }

  async findPlan(id: string) {
    return this.prisma.subscription_plans.findUnique({
      where: { plan_id: id },
      include: { user_subscriptions: true },
    });
  }

  /**
   * Find plan by tier and return all pricing variants
   */
  async findPlanByTier(tier: PlanTier) {
    const plans = await this.prisma.subscription_plans.findMany({
      where: { tier },
      orderBy: { billing_period: 'asc' },
      include: { user_subscriptions: true, plan_features: true },
    });

    if (plans.length === 0) {
      return null;
    }

    // Group pricing tiers
    const basePlan = plans[0];
    const pricing: any = {};

    plans.forEach((plan) => {
      pricing[plan.billing_period] = {
        price: plan.price,
        discount_percent: plan.discount_percent,
      };
    });

    return {
      tier: basePlan.tier,
      name: basePlan.name,
      description: basePlan.description,
      base_price: basePlan.base_price,
      is_active: basePlan.is_active,
      display_order: basePlan.display_order,
      created_at: basePlan.created_at,
      pricing,
      plan_features: basePlan.plan_features,
    };
  }

  /**
   * Create plan with multiple pricing tiers (MONTHLY, QUARTERLY, YEARLY)
   */
  async createPlan(data: {
    tier: PlanTier;
    name: string;
    description?: string;
    base_price: number;
    is_active?: boolean;
    display_order?: number;
    pricing: {
      MONTHLY?: { price: number; discount_percent?: number };
      QUARTERLY?: { price: number; discount_percent?: number };
      YEARLY?: { price: number; discount_percent?: number };
    };
    features?: {  // ✅ Features bhi add karein
      feature_type: FeatureType;
      enabled: boolean;
      limit_value?: number;
    }[];
  }) {
    const results = [];

    for (const [billingPeriod, priceData] of Object.entries(data.pricing)) {
      if (!priceData) continue;

      // return {
      //   data: data,
      //   billingPeriod: billingPeriod,
      //   priceData: priceData,
      //   message:"Debug info"
      // }

      // ✅ Transaction use karein - atomic operation
      const result = await this.prisma.$transaction(async (tx) => {
        // 1. Plan create karein
        const plan = await tx.subscription_plans.create({
          data: {
            tier: data.tier,
            name: data.name,
            description: data.description,
            base_price: data.base_price,
            is_active: data.is_active ?? true,
            display_order: data.display_order,
            billing_period: billingPeriod as BillingPeriod,
            price: priceData.price,
            discount_percent: priceData.discount_percent ?? 0,
          },
        });

        // 2. Features automatically add karein
        if (data.features && data.features.length > 0) {
          await tx.plan_features.createMany({
            data: data.features.map(feature => ({
              plan_id: plan.plan_id,
              feature_type: feature.feature_type,
              enabled: feature.enabled,
              limit_value: feature.limit_value,
            })),
          });
        }

        return plan;
      }, { timeout: 15000 });

      results.push(result);
    }

    await this.refreshPlansCache();
    return results;
  }

  /**
   * Update plan with multiple pricing tiers
   * Finds plans by tier and updates all billing period variants
   */
  async updatePlan(
    tier: PlanTier,
    data: {
      name?: string;
      description?: string;
      base_price?: number;
      is_active?: boolean;
      display_order?: number;
      pricing?: {
        MONTHLY?: { price: number; discount_percent?: number };
        QUARTERLY?: { price: number; discount_percent?: number };
        YEARLY?: { price: number; discount_percent?: number };
      };
    }
  ) {
    // Delete purane records is tier ke liye
    await this.prisma.subscription_plans.deleteMany({
      where: { tier },
    });

    const results = [];

    // Create naye records with updated pricing
    if (data.pricing) {
      for (const [billingPeriod, priceData] of Object.entries(data.pricing)) {
        if (!priceData) continue;

        const result = await this.prisma.subscription_plans.create({
          data: {
            tier,
            name: data.name || '',
            description: data.description,
            base_price: data.base_price,
            is_active: data.is_active ?? true,
            display_order: data.display_order,
            billing_period: billingPeriod as BillingPeriod,
            price: priceData.price,
            discount_percent: priceData.discount_percent ?? 0,
          },
        });
        results.push(result);
      }
    }

    await this.refreshPlansCache();
    return results;
  }

  /**
   * Delete plan by tier (deletes all billing period variants)
   */
  async deletePlan(tier: PlanTier) {
    const result = this.prisma.subscription_plans.deleteMany({
      where: { tier },
    });
    await this.refreshPlansCache();
    return result;
  }

  /**
   * Delete single plan by ID
   */
  async deletePlanById(planId: string) {
    const result = this.prisma.subscription_plans.delete({
      where: { plan_id: planId },
    });
    await this.refreshPlansCache();
    return result;
  }

  async findAllSubscriptions() {
    return this.prisma.user_subscriptions.findMany({
      include: {
        user: true,
        plan: true,
      },
    });
  }

  async findSubscription(id: string) {
    return this.prisma.user_subscriptions.findUnique({
      where: { subscription_id: id },
      include: {
        user: true,
        plan: true,
      },
    });
  }

  async findByUser(userId: string) {
    return this.prisma.user_subscriptions.findMany({
      where: { user_id: userId },
      include: {
        plan: true,
      },
    });
  }

  /**
   * Create a FREE subscription row at registration time. Mirrors the relevant
   * parts of createSubscription (user_subscriptions row + subscription_usage
   * records + current_tier update) but deliberately skips advancing
   * onboarding_state to PAID — fresh users still need PERSONAL_INFO and KYC
   * funnel emails, and the dashboard "Activate your account" widget needs to
   * keep showing the subscription step as not-yet-acknowledged. Idempotent:
   * if the user already has any subscription, this is a no-op.
   */
  async createInitialFreeSubscription(userId: string): Promise<void> {
    const existing = await this.prisma.user_subscriptions.findFirst({
      where: { user_id: userId },
      select: { subscription_id: true },
    });
    if (existing) return;

    const freePlan = await this.prisma.subscription_plans.findFirst({
      where: { tier: 'FREE', billing_period: 'MONTHLY', is_active: true },
      include: { plan_features: true },
    });
    if (!freePlan) {
      this.logger.warn(
        `createInitialFreeSubscription: no active FREE/MONTHLY plan in subscription_plans — skipping for user ${userId}`,
      );
      return;
    }

    const now = new Date();
    const current_period_end = new Date(now);
    current_period_end.setMonth(current_period_end.getMonth() + 1);

    await this.prisma.$transaction(async (tx) => {
      const subscription = await tx.user_subscriptions.create({
        data: {
          user_id: userId,
          plan_id: freePlan.plan_id,
          tier: freePlan.tier,
          billing_period: freePlan.billing_period,
          status: 'active',
          current_period_start: now,
          current_period_end,
          next_billing_date: current_period_end,
          last_payment_date: now,
          started_at: now,
          auto_renew: false,
        },
      });

      if (freePlan.plan_features && freePlan.plan_features.length > 0) {
        const usageRecords: Array<{
          subscription_id: string;
          user_id: string;
          feature_type: (typeof freePlan.plan_features)[0]['feature_type'];
          usage_count: number;
          period_start: Date;
          period_end: Date;
        }> = [];

        for (const feature of freePlan.plan_features) {
          if (feature.feature_type === FeatureType.CUSTOM_STRATEGIES) {
            usageRecords.push({
              subscription_id: subscription.subscription_id,
              user_id: userId,
              feature_type: feature.feature_type,
              usage_count: 0,
              period_start: now,
              period_end: current_period_end,
            });
          } else {
            const monthlyPeriods = this.getMonthlyPeriods(now, current_period_end);
            for (const period of monthlyPeriods) {
              usageRecords.push({
                subscription_id: subscription.subscription_id,
                user_id: userId,
                feature_type: feature.feature_type,
                usage_count: 0,
                period_start: period.start,
                period_end: period.end,
              });
            }
          }
        }

        if (usageRecords.length > 0) {
          await tx.subscription_usage.createMany({ data: usageRecords });
        }
      }
    }, { timeout: 30000 });

    this.clearSubscriptionCache(userId);
  }

  async createSubscription(data: {
    user_id: string;
    plan_id: string;
    status?: SubscriptionStatus;
    external_id?: string;
    billing_provider?: string;
    auto_renew?: boolean;
  }) {

    const result = await this.prisma.$transaction(async (tx) => {
      // 1️⃣ Plan fetch karo to get tier & billing_period
      const plan = await tx.subscription_plans.findUnique({
        where: { plan_id: data.plan_id },
        include: { plan_features: true },
      });

      if (!plan) {
        throw new Error('Plan not found');
      }

      // 2️⃣ Billing dates calculate karo
      const now = new Date();
      const current_period_start = now;
      let current_period_end: Date;
      let next_billing_date: Date;

      switch (plan.billing_period) {
        case 'MONTHLY':
          current_period_end = new Date(now);
          current_period_end.setMonth(current_period_end.getMonth() + 1);
          break;
        case 'QUARTERLY':
          current_period_end = new Date(now);
          current_period_end.setMonth(current_period_end.getMonth() + 3);
          break;
        case 'YEARLY':
          current_period_end = new Date(now);
          current_period_end.setFullYear(current_period_end.getFullYear() + 1);
          break;
      }

      next_billing_date = new Date(current_period_end);

      // 3️⃣ Subscription create karo (use resolved plan.plan_id for DB)
      const subscription = await tx.user_subscriptions.create({
        data: {
          user_id: data.user_id,
          plan_id: plan.plan_id,
          tier: plan.tier,
          billing_period: plan.billing_period,
          status: data.status || 'active',
          current_period_start,
          current_period_end,
          next_billing_date,
          last_payment_date: now,
          started_at: now,
          auto_renew: data.auto_renew ?? true,
          external_id: data.external_id,
          billing_provider: data.billing_provider,
        },
        include: {
          user: {
            select: {
              user_id: true,
              email: true,
              username: true,
              current_tier: true,
            },
          },
          plan: {
            include: {
              plan_features: true,
            },
          },
        },
      });

      // 4️⃣ User ka current_tier update karo
      await tx.users.update({
        where: { user_id: data.user_id },
        data: { current_tier: plan.tier },
      });

      // Onboarding drip: any plan choice (free or paid) advances the funnel to PAID stage so the
      // "connect your exchange" reminder series queues. Engine 2 (free-upgrade) only kicks in once
      // the user reaches COMPLETED while still on FREE, so we still call stop() on paid upgrades
      // to handle the rare case where a user picks free here, completes, then upgrades later.
      await this.onboardingStateService.advanceTo(data.user_id, OnboardingState.PAID);
      if (plan.tier !== PlanTier.FREE) {
        await this.freeUpgradeCampaignService.stop(data.user_id);
      }

      // 5️⃣ Subscription usage records: CUSTOM_STRATEGIES = 1 row per billing period; others = monthly breakdown
      if (plan.plan_features && plan.plan_features.length > 0) {
        const usageRecords: Array<{
          subscription_id: string;
          user_id: string;
          feature_type: (typeof plan.plan_features)[0]['feature_type'];
          usage_count: number;
          period_start: Date;
          period_end: Date;
        }> = [];

        for (const feature of plan.plan_features) {
          if (feature.feature_type === FeatureType.CUSTOM_STRATEGIES) {
            usageRecords.push({
              subscription_id: subscription.subscription_id,
              user_id: data.user_id,
              feature_type: feature.feature_type,
              usage_count: 0,
              period_start: current_period_start,
              period_end: current_period_end,
            });
          } else {
            const monthlyPeriods = this.getMonthlyPeriods(current_period_start, current_period_end);
            for (const period of monthlyPeriods) {
              usageRecords.push({
                subscription_id: subscription.subscription_id,
                user_id: data.user_id,
                feature_type: feature.feature_type,
                usage_count: 0,
                period_start: period.start,
                period_end: period.end,
              });
            }
          }
        }

        await tx.subscription_usage.createMany({
          data: usageRecords,
        });

        // FREE → PRO: top N strategies active, rest inactive (N = plan CUSTOM_STRATEGIES limit, default 5)
        if (plan.tier === PlanTier.PRO) {
          const proLimit =
            plan.plan_features?.find(
              (f) => f.feature_type === FeatureType.CUSTOM_STRATEGIES,
            )?.limit_value ?? 5;
          const rows = await tx.strategies.findMany({
            where: { user_id: data.user_id, type: 'user' },
            orderBy: { created_at: 'asc' },
            select: { strategy_id: true },
          });
          const idsToKeepActive = rows
            .slice(0, proLimit)
            .map((r) => r.strategy_id);
          const idsToDeactivate = rows.slice(proLimit).map((r) => r.strategy_id);
          if (idsToKeepActive.length > 0) {
            await tx.strategies.updateMany({
              where: { strategy_id: { in: idsToKeepActive } },
              data: { is_active: true },
            });
          }
          if (idsToDeactivate.length > 0) {
            await tx.strategies.updateMany({
              where: { strategy_id: { in: idsToDeactivate } },
              data: { is_active: false },
            });
          }
        }
      }
      return subscription;
    }, { timeout: 30000 });

    // 🔔 Send admin notification about new subscription
    try {
      await this.authEmailService.sendNewSubscriptionNotification({
        username: result.user.username,
        email: result.user.email,
        userId: result.user.user_id,
        tier: result.tier,
        billingPeriod: result.billing_period,
        createdAt: result.started_at,
      });
    } catch (error) {
      this.logger.error(`Failed to send subscription notification: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Clear subscription cache so next request gets fresh data
    this.clearSubscriptionCache(data.user_id);
    return result;
  }

  async updateSubscription(id: string, data: {
    status?: SubscriptionStatus;
    expires_at?: Date;
    billing_provider?: string;
    plan_id?: string;
    auto_renew?: boolean;
    external_id?: string;
  }) {
    const result = await this.prisma.$transaction(async (tx) => {
      // 1️⃣ Get current subscription

      const currentSubscription = await tx.user_subscriptions.findUnique({
        where: { subscription_id: id },
        include: { plan: { include: { plan_features: true } } },
      });

      if (!currentSubscription) {
        throw new Error('Subscription not found');
      }

      // 2️⃣ If plan_id is being changed, fetch new plan
      let newPlan = currentSubscription.plan;
      let updateData: any = {
        status: data.status,
        billing_provider: data.billing_provider,
        auto_renew: data.auto_renew ?? currentSubscription.auto_renew,
        ...(data.external_id !== undefined && { external_id: data.external_id }),
      };

      if (data.plan_id && data.plan_id !== currentSubscription.plan_id) {
        if (this.isUuid(data.plan_id)) {
          newPlan = await tx.subscription_plans.findUnique({
            where: { plan_id: data.plan_id },
            include: { plan_features: true },
          });
        } else {
          const parts = String(data.plan_id).split('_');
          const tier = parts[0] as PlanTier;
          const billingPeriod = parts[1] as BillingPeriod;
          if (tier && billingPeriod && Object.values(PlanTier).includes(tier) && Object.values(BillingPeriod).includes(billingPeriod)) {
            newPlan = await tx.subscription_plans.findFirst({
              where: { tier, billing_period: billingPeriod },
              include: { plan_features: true },
            });
          }
        }
        if (!newPlan) {
          throw new Error('New plan not found');
        }

        // PRO limit from plan_features (CUSTOM_STRATEGIES limit_value; default 5)
        const customStrategiesFeature = newPlan.plan_features?.find(
          (f) => f.feature_type === FeatureType.CUSTOM_STRATEGIES,
        );
        const proCustomStrategyLimit =
          customStrategiesFeature?.limit_value ?? 5;

        // Elite → Pro: allow downgrade; updateSubscription will set top N active, rest inactive

        // 3️⃣ Recalculate billing dates for new plan
        const now = new Date();
        let current_period_end: Date;

        switch (newPlan.billing_period) {
          case 'MONTHLY':
            current_period_end = new Date(now);
            current_period_end.setMonth(current_period_end.getMonth() + 1);
            break;
          case 'QUARTERLY':
            current_period_end = new Date(now);
            current_period_end.setMonth(current_period_end.getMonth() + 3);
            break;
          case 'YEARLY':
            current_period_end = new Date(now);
            current_period_end.setFullYear(current_period_end.getFullYear() + 1);
            break;
        }

        updateData = {
          ...updateData,
          plan_id: newPlan.plan_id,
          tier: newPlan.tier,
          billing_period: newPlan.billing_period,
          current_period_start: now,
          current_period_end,
          next_billing_date: current_period_end,
          last_payment_date: now,
          expires_at: current_period_end,
        };

        // 4️⃣ Update user tier
        await tx.users.update({
          where: { user_id: currentSubscription.user_id },
          data: { current_tier: newPlan.tier },
        });

        // 5️⃣ Delete old subscription usage records
        await tx.subscription_usage.deleteMany({
          where: { subscription_id: id },
        });

        // 6️⃣ Create new subscription usage records: CUSTOM_STRATEGIES = 1 row with current strategy count (no reset); others = monthly breakdown
        if (newPlan.plan_features && newPlan.plan_features.length > 0) {
          const usageRecords: Array<{
            subscription_id: string;
            user_id: string;
            feature_type: (typeof newPlan.plan_features)[0]['feature_type'];
            usage_count: number;
            period_start: Date;
            period_end: Date;
          }> = [];

          let customStrategyCount = 0;
          const hasCustomStrategiesFeature = newPlan.plan_features.some(
            (f) => f.feature_type === FeatureType.CUSTOM_STRATEGIES,
          );
          if (hasCustomStrategiesFeature) {
            customStrategyCount = await tx.strategies.count({
              where: {
                user_id: currentSubscription.user_id,
                type: 'user',
              },
            });
          }

          for (const feature of newPlan.plan_features) {
            if (feature.feature_type === FeatureType.CUSTOM_STRATEGIES) {
              const usageCount =
                newPlan.tier === PlanTier.ELITE
                  ? customStrategyCount
                  : newPlan.tier === PlanTier.PRO
                    ? Math.min(customStrategyCount, proCustomStrategyLimit)
                    : customStrategyCount;
              usageRecords.push({
                subscription_id: id,
                user_id: currentSubscription.user_id,
                feature_type: feature.feature_type,
                usage_count: usageCount,
                period_start: updateData.current_period_start,
                period_end: updateData.current_period_end,
              });
            } else {
              const monthlyPeriods = this.getMonthlyPeriods(updateData.current_period_start, updateData.current_period_end);
              for (const period of monthlyPeriods) {
                usageRecords.push({
                  subscription_id: id,
                  user_id: currentSubscription.user_id,
                  feature_type: feature.feature_type,
                  usage_count: 0,
                  period_start: period.start,
                  period_end: period.end,
                });
              }
            }
          }

          await tx.subscription_usage.createMany({
            data: usageRecords,
          });

          // PRO (FREE→PRO or ELITE→PRO): top N active, rest inactive; usage_count already set to min(count, limit)
          if (newPlan.tier === PlanTier.PRO) {
            const rows = await tx.strategies.findMany({
              where: {
                user_id: currentSubscription.user_id,
                type: 'user',
              },
              orderBy: { created_at: 'asc' },
              select: { strategy_id: true },
            });
            const idsToKeepActive = rows
              .slice(0, proCustomStrategyLimit)
              .map((r) => r.strategy_id);
            const idsToDeactivate = rows
              .slice(proCustomStrategyLimit)
              .map((r) => r.strategy_id);
            if (idsToKeepActive.length > 0) {
              await tx.strategies.updateMany({
                where: { strategy_id: { in: idsToKeepActive } },
                data: { is_active: true },
              });
            }
            if (idsToDeactivate.length > 0) {
              await tx.strategies.updateMany({
                where: { strategy_id: { in: idsToDeactivate } },
                data: { is_active: false },
              });
            }
          }
        }
      }

      // 7️⃣ Update subscription
      const updated = await tx.user_subscriptions.update({
        where: { subscription_id: id },
        data: updateData,
        include: {
          plan: { include: { plan_features: true } },
          subscription_usage: true,
        },
      });

      // Drive the onboarding funnel forward when a plan change lands the
      // user on a paid tier. Mirrors createSubscription's advanceTo(PAID).
      // Needed because dashboard-first signup auto-creates a FREE row, so
      // the first paid checkout hits updateSubscription rather than
      // createSubscription. advanceTo is one-way so this is a no-op once
      // the user has progressed past PAID.
      if (newPlan && newPlan.tier && newPlan.tier !== PlanTier.FREE) {
        await this.onboardingStateService.advanceTo(
          currentSubscription.user_id,
          OnboardingState.PAID,
        );
        await this.freeUpgradeCampaignService.stop(currentSubscription.user_id);
      }

      const notification = await this.notificationsService.createNotification({user_id: currentSubscription.user_id, type: "subscription_updated",title:"Subscription Updated",message:"Your subscription has been updated",read:false,metadata:null});
      this.notificationsService.sendNotification(currentSubscription.user_id, "Subscription Updated", "Your subscription has been updated");
      this.appGateway.emitNotificationCount(currentSubscription.user_id, 1, notification); // notification count increment by 1

      return updated;
    }, { timeout: 30000 });

    // 🔔 Send admin notification about subscription change (only if plan was changed)
    if (data.plan_id && data.plan_id !== result.plan_id) {
      try {
        const userDetails = await this.prisma.users.findUnique({
          where: { user_id: result.user_id },
          select: { username: true, email: true, user_id: true },
        });

        if (userDetails) {
          await this.authEmailService.sendSubscriptionChangedNotification({
            username: userDetails.username,
            email: userDetails.email,
            userId: userDetails.user_id,
            oldTier: result.tier,
            newTier: result.tier,
            oldBillingPeriod: result.billing_period,
            newBillingPeriod: result.billing_period,
            changedAt: new Date(),
          });
        }
      } catch (error) {
        this.logger.error(`Failed to send subscription changed notification: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Clear subscription cache so next request gets fresh data
    if (result?.user_id) this.clearSubscriptionCache(result.user_id);
    return result;
  }

  async deleteSubscription(id: string) {
    return this.prisma.user_subscriptions.delete({
      where: { subscription_id: id },
    });
  }

  /**
   * Validate before checkout: Elite → Pro downgrade allowed only if user has ≤ 5 custom strategies.
   * Call this before creating Stripe checkout session; throws if invalid.
   */
  async validateDowngradeToProBeforeCheckout(
    userId: string,
    newPlanId: string,
  ): Promise<void> {
    // No longer blocking Elite→Pro; updateSubscription will set top N strategies active, rest inactive
    return;
  }

  /**
 * Get active subscription with all features
 */
  async getActiveSubscriptionWithFeatures(userId: string) {
    return this.prisma.user_subscriptions.findFirst({
      where: {
        user_id: userId,
      },
      include: {
        plan: {
          include: {
            plan_features: true,
          },
        },
        subscription_usage: true,
        payment_history: true,
      },
    });
  }

  /**
   * Update user tier
   */
  async updateUserTier(userId: string, tier: any) {
    return this.prisma.users.update({
      where: { user_id: userId },
      data: { current_tier: tier },
      select: { user_id: true, current_tier: true, email: true },
    });
  }

  /**
   * Get all features for a plan
   */
  async getPlanFeatures(planId: string) {
    return this.prisma.plan_features.findMany({
      where: { plan_id: planId },
    });
  }

  /**
   * Record payment
   */
  async recordPayment(data: {
    subscription_id: string;
    user_id: string;
    amount: number;
    currency?: string;
    status: 'pending' | 'succeeded' | 'failed';
    payment_provider?: string;
    external_payment_id?: string;
    payment_method?: string;
    invoice_url?: string | null;
    receipt_url?: string | null;
    failure_reason?: string | null;
  }) {
    const payment = await this.prisma.payment_history.create({
      data: {
        ...data,
        currency: data.currency || 'USD',
        paid_at: data.status === 'succeeded' ? new Date() : null,
      },
    });

    // Affiliate commission accrual — idempotent, no-ops if user has no
    // referrer or affiliate is not APPROVED. Try/catch so a bug here cannot
    // poison the payment write.
    if (data.status === 'succeeded') {
      try {
        // Resolve the subscription's billing_period so the commission engine
        // can credit "months covered" correctly (monthly = 1, quarterly = 3,
        // yearly = 12). Drives the recurring_months_cap semantics.
        const sub = await this.prisma.user_subscriptions.findUnique({
          where: { subscription_id: data.subscription_id },
          select: { billing_period: true },
        });
        const billingPeriodMonths =
          sub?.billing_period === 'YEARLY'
            ? 12
            : sub?.billing_period === 'QUARTERLY'
              ? 3
              : 1;

        await this.affiliateCommissionService.recordSubscriptionPayment({
          userId: data.user_id,
          paymentReference: payment.payment_id,
          grossAmountUsd: data.amount,
          billingPeriodMonths,
        });
      } catch (err: any) {
        this.logger.error(
          `Affiliate commission accrual failed for payment ${payment.payment_id}: ${err?.message}`,
        );
      }
    }

    return payment;
  }

  /**
   * Cancel subscription
   */
  async cancelSubscription(subscriptionId: string) {
    const result = await this.prisma.user_subscriptions.update({
      where: { subscription_id: subscriptionId },
      data: {
        status: 'cancelled',
        cancelled_at: new Date(),
        auto_renew: false,
      },
    });
    if (result?.user_id) this.clearSubscriptionCache(result.user_id);
    return result;
  }

  async cancelUserSubscription(userId: string, options?: {
    subscriptionId?: string;
    stripeCurrentPeriodEnd?: Date | null;
    stripeSubscriptionId?: string;
  }) {
    const where: any = {
      user_id: userId,
      status: 'active',
      billing_provider: 'stripe',
    };

    if (options?.subscriptionId) {
      where.subscription_id = options.subscriptionId;
    }

    if (options?.stripeSubscriptionId) {
      where.external_id = options.stripeSubscriptionId;
    }

    const active = await this.prisma.user_subscriptions.findFirst({
      where,
      orderBy: { created_at: 'desc' },
    });

    if (!active) {
      throw new Error('No active Stripe subscription found for user');
    }

    const periodEnd =
      options?.stripeCurrentPeriodEnd ??
      active.current_period_end ??
      active.expires_at ??
      null;

    const updated = await this.prisma.user_subscriptions.update({
      where: { subscription_id: active.subscription_id },
      data: {
        auto_renew: false,
        current_period_end: periodEnd,
        expires_at: periodEnd,
        status: active.status,
      },
    });

    return updated;
  }

  async handleStripeSubscriptionCancelled(stripeSubscriptionId: string, stripeCurrentPeriodEnd?: Date | null) {
    const existing = await this.prisma.user_subscriptions.findFirst({
      where: {
        billing_provider: 'stripe',
        external_id:stripeSubscriptionId
      },
    });

    if (!existing) {
      return null;
    }

    if (existing.status === SubscriptionStatus.cancelled) {
      return existing;
    }

    const finalPeriodEnd =
      stripeCurrentPeriodEnd ??
      existing.current_period_end ??
      existing.expires_at ??
      new Date();

    const result = await this.finalizeCancellationLocal(
      existing.subscription_id,
      finalPeriodEnd,
    );

    // Affiliate clawback — only fires if the latest succeeded payment is
    // within the configured refund_clawback_days window. Cancellations
    // outside that window are treated as normal end-of-life and do not
    // claw back the commission.
    try {
      await this.affiliateCommissionService.clawbackForSubscriptionIfRecent({
        subscriptionId: existing.subscription_id,
      });
    } catch (err: any) {
      this.logger.error(
        `Affiliate clawback failed for subscription ${existing.subscription_id}: ${err?.message}`,
      );
    }

    return result;
  }

  async handleAdminOverrideSubscriptionCancelled(subscriptionId: string) {
    const existing = await this.prisma.user_subscriptions.findUnique({
      where: { subscription_id: subscriptionId },
    });

    if (!existing || existing.billing_provider !== 'admin_override') {
      return null;
    }

    if (existing.status === SubscriptionStatus.cancelled) {
      return existing;
    }

    const finalPeriodEnd =
      existing.current_period_end ?? existing.expires_at ?? new Date();

    return this.finalizeCancellationLocal(existing.subscription_id, finalPeriodEnd);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Apple In-App Purchase lifecycle
  //
  // Apple subscriptions are stored in user_subscriptions exactly like Stripe:
  //   billing_provider = 'apple'
  //   external_id      = Apple originalTransactionId (stable per subscription)
  // so feature-gating (users.current_tier) and all downstream side-effects are
  // shared. These helpers are the Apple analogs of the Stripe handlers above.
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Find the local subscription row backing an Apple originalTransactionId.
   */
  async findAppleSubscription(originalTransactionId: string) {
    return this.prisma.user_subscriptions.findFirst({
      where: { billing_provider: 'apple', external_id: originalTransactionId },
    });
  }

  /**
   * Revoke an Apple subscription → downgrade to FREE.
   * Used for EXPIRED / GRACE_PERIOD_EXPIRED / REFUND / REVOKE notifications.
   * Mirrors handleStripeSubscriptionCancelled, including affiliate clawback.
   */
  async handleAppleSubscriptionCancelled(
    originalTransactionId: string,
    finalPeriodEnd?: Date | null,
  ) {
    const existing = await this.findAppleSubscription(originalTransactionId);

    if (!existing) {
      return null;
    }

    if (existing.status === SubscriptionStatus.cancelled) {
      return existing;
    }

    const periodEnd =
      finalPeriodEnd ??
      existing.current_period_end ??
      existing.expires_at ??
      new Date();

    const result = await this.finalizeCancellationLocal(
      existing.subscription_id,
      periodEnd,
    );

    // Affiliate clawback parity with Stripe — only fires if the latest succeeded
    // payment is within the configured refund_clawback_days window.
    try {
      await this.affiliateCommissionService.clawbackForSubscriptionIfRecent({
        subscriptionId: existing.subscription_id,
      });
    } catch (err: any) {
      this.logger.error(
        `Affiliate clawback failed for Apple subscription ${existing.subscription_id}: ${err?.message}`,
      );
    }

    return result;
  }

  /**
   * Extend an Apple subscription on DID_RENEW / SUBSCRIBED. Keeps the tier
   * active and pushes out the period/expiry to Apple's new expiresDate. Does NOT
   * change tier (renewals stay on the same product).
   */
  async applyAppleRenewal(originalTransactionId: string, expiresDate: Date) {
    const existing = await this.findAppleSubscription(originalTransactionId);
    if (!existing) {
      return null;
    }

    const now = new Date();
    const updated = await this.prisma.user_subscriptions.update({
      where: { subscription_id: existing.subscription_id },
      data: {
        status: SubscriptionStatus.active,
        current_period_start: existing.current_period_end ?? now,
        current_period_end: expiresDate,
        expires_at: expiresDate,
        next_billing_date: expiresDate,
        last_payment_date: now,
        cancelled_at: null,
      },
    });

    // Re-assert the cached tier in case a prior EXPIRED had dropped it to FREE
    // (e.g. resubscribe after lapse).
    await this.prisma.users.update({
      where: { user_id: updated.user_id },
      data: { current_tier: updated.tier },
    });

    this.clearSubscriptionCache(updated.user_id);
    return updated;
  }

  /**
   * Update auto-renew flag on DID_CHANGE_RENEWAL_STATUS. Access is unchanged —
   * the user keeps the tier until expiry; only the renewal intent changes.
   */
  async setAppleAutoRenew(originalTransactionId: string, autoRenew: boolean) {
    const existing = await this.findAppleSubscription(originalTransactionId);
    if (!existing) {
      return null;
    }
    const updated = await this.prisma.user_subscriptions.update({
      where: { subscription_id: existing.subscription_id },
      data: { auto_renew: autoRenew },
    });
    this.clearSubscriptionCache(updated.user_id);
    return updated;
  }

  private async finalizeCancellationLocal(subscriptionId: string, finalPeriodEnd: Date) {
    const now = new Date();
    const plan = await this.prisma.subscription_plans.findFirst({
      where: { tier: PlanTier.FREE, billing_period: BillingPeriod.MONTHLY },
    });

    const updated = await this.prisma.$transaction(async (tx) => {
      const subscription = await tx.user_subscriptions.update({
        where: { subscription_id: subscriptionId },
        data: {
          status: SubscriptionStatus.cancelled,
          cancelled_at: now,
          expires_at: finalPeriodEnd,
          auto_renew: false,
          tier: PlanTier.FREE,
          billing_period: BillingPeriod.MONTHLY,
          plan_id: plan?.plan_id,
        },
      });

      await tx.users.update({
        where: { user_id: subscription.user_id },
        data: { current_tier: PlanTier.FREE },
      });

      await tx.strategies.updateMany({
        where: { user_id: subscription.user_id, is_active: true },
        data: { is_active: false },
      });

      return subscription;
    });

    // Engine 2 — paid → free downgrade. start() internally enforces the no-restart rule.
    await this.freeUpgradeCampaignService.start(updated.user_id);

    return updated;
  }

  async getMySubscription(userId: string) {
    // Current subscription
    const currentSubscription = await this.prisma.user_subscriptions.findFirst({
      where: { user_id: userId, status: 'active' },
      include: {
        plan: { include: { plan_features: true } },
        subscription_usage: true,
      },
      orderBy: { created_at: 'desc' },
    });
    // Check if user has *any* paid subscription (excluding free). If not, add hasPlan: true, otherwise false.
    const anyPlan = await this.prisma.user_subscriptions.findFirst({
      where: {
        user_id: userId,
      },
    });
    let hasPlan: boolean = false;
    if (anyPlan) {
      hasPlan = true;
    }


    if(!currentSubscription) {
      const currentTier = await this.prisma.users.findUnique({
        where: { user_id: userId },
        select: { current_tier: true },
      });

      if(currentTier?.current_tier === 'FREE') {
        const allSubscriptions = await this.prisma.subscription_plans.findMany({
          orderBy: [{ tier: 'asc' }, { billing_period: 'asc' }],
          include: { plan_features: true },
        });
        return {
          current: {
            subscription_id: null,
            user_id: userId,
            tier: 'FREE',
            plan_id: null,
            billing_period: 'MONTHLY',
            status: 'active',
            current_period_start: null,
            current_period_end: null,
            next_billing_date: null,
          },
          usage: null,
          payments: null,
          allSubscriptions: allSubscriptions,
          hasPlan: hasPlan,
        };
      }


     
    }

    // Payment history
    const payments = await this.prisma.payment_history.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
      take: 10,
    });

    // Transform usage array into keyed object by feature_type
    const usage: any = {};

    if (currentSubscription?.subscription_usage) {
      // ✅ Group by feature_type and show current month's usage
      const now = new Date();

      currentSubscription.subscription_usage.forEach((record: any) => {
        const featureLimit = currentSubscription.plan.plan_features.find(
          (f: any) => f.feature_type === record.feature_type
        );

        const limit = featureLimit?.limit_value || -1;

        // Check if this record is for current month
        const isCurrentMonth =
          new Date(record.period_start) <= now &&
          new Date(record.period_end) >= now;

        // Initialize if not exists
        if (!usage[record.feature_type]) {
          usage[record.feature_type] = {
            used: 0,
            limit: limit,
            percentage: 0,
            current_period: null,
            all_periods: [],
          };
        }

        // Add to all periods
        usage[record.feature_type].all_periods.push({
          used: record.usage_count || 0,
          period_start: record.period_start,
          period_end: record.period_end,
          is_current: isCurrentMonth,
        });

        // Set current month data
        if (isCurrentMonth) {
          usage[record.feature_type].used = record.usage_count || 0;
          usage[record.feature_type].percentage =
            limit === -1 ? 0 : ((record.usage_count || 0) / limit) * 100;
          usage[record.feature_type].current_period = {
            start: record.period_start,
            end: record.period_end,
          };
        }
      });
    }

    // Format current subscription
    const current = currentSubscription
      ? {
        subscription_id: currentSubscription.subscription_id,
        user_id: currentSubscription.user_id,
        tier: currentSubscription.tier || 'FREE',
        plan_id: currentSubscription.plan_id,
        billing_period: currentSubscription.billing_period || 'MONTHLY',
        status: currentSubscription.status,
        current_period_start: currentSubscription.current_period_start,
        current_period_end: currentSubscription.current_period_end,
        next_billing_date: currentSubscription.next_billing_date,
        last_payment_date: currentSubscription.last_payment_date,
        auto_renew: currentSubscription.auto_renew || false,
        cancelled_at: currentSubscription.cancelled_at,
        external_id: currentSubscription.external_id,
      }
      : null;

    const allSubscriptions = await this.prisma.subscription_plans.findMany({
      orderBy: [{ tier: 'asc' }, { billing_period: 'asc' }],
      include: { plan_features: true },
    });

    return {
      current,
      usage,
      payments: payments.map((p: any) => ({
        payment_id: p.payment_id,
        subscription_id: p.subscription_id,
        user_id: p.user_id,
        amount: p.amount,
        currency: p.currency,
        status: p.status,
        payment_provider: p.payment_provider,
        external_payment_id: p.external_payment_id,
        payment_method: p.payment_method,
        invoice_url: p.invoice_url,
        receipt_url: p.receipt_url,
        failure_reason: p.failure_reason,
        paid_at: p.paid_at,
        created_at: p.created_at,
      })),
      allSubscriptions,
      hasPlan: hasPlan,
    };
  }

  /**
 * Check if user can use a feature in current month
 */
  // canUseFeature update karo - monthly auto-reset ke saath:
  async canUseFeature(userId: string, featureType: FeatureType): Promise<{
    allowed: boolean;
    used: number;
    limit: number;
    currentMonth: { start: Date; end: Date };
  }> {
    const now = new Date();
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const currentMonthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    const subscription = await this.getActiveSubscriptionWithFeatures(userId);

    if (!subscription) {
      return {
        allowed: false,
        used: 0,
        limit: 0,
        currentMonth: { start: currentMonthStart, end: currentMonthEnd },
      };
    }

    const feature = subscription.plan.plan_features.find(
      f => f.feature_type === featureType
    );

    if (!feature || !feature.enabled) {
      return {
        allowed: false,
        used: 0,
        limit: 0,
        currentMonth: { start: currentMonthStart, end: currentMonthEnd },
      };
    }

    // ✅ Get usage record
    let usage = await this.prisma.subscription_usage.findFirst({
      where: {
        subscription_id: subscription.subscription_id,
        user_id: userId,
        feature_type: featureType,
      },
    });

    if (!usage) {
      return {
        allowed: false,
        used: 0,
        limit: 0,
        currentMonth: { start: currentMonthStart, end: currentMonthEnd },
      };
    }

    // ✅ Check if month has changed - auto reset
    const usagePeriodStart = new Date(usage.period_start);
    const isNewMonth = usagePeriodStart.getMonth() !== now.getMonth() ||
      usagePeriodStart.getFullYear() !== now.getFullYear();

    if (isNewMonth) {
      // Reset for new month
      usage = await this.prisma.subscription_usage.update({
        where: { usage_id: usage.usage_id },
        data: {
          usage_count: 0,
          period_start: currentMonthStart,
          period_end: currentMonthEnd,
        },
      });
    }

    const used = usage.usage_count || 0;
    const limit = feature.limit_value || 0;

    return {
      allowed: limit === -1 || used < limit,
      used,
      limit,
      currentMonth: { start: currentMonthStart, end: currentMonthEnd },
    };
  }

  /**
   * Increment usage for current month
   */
  async incrementUsage(userId: string, featureType: FeatureType): Promise<void> {
    const now = new Date();

    // Get active subscription
    const subscription = await this.getActiveSubscriptionWithFeatures(userId);

    if (!subscription) {
      throw new Error('No active subscription found');
    }

    // Find current month's usage record
    const usage = await this.prisma.subscription_usage.findFirst({
      where: {
        subscription_id: subscription.subscription_id,
        user_id: userId,
        feature_type: featureType,
        period_start: {
          lte: now,
        },
        period_end: {
          gte: now,
        },
      },
    });

    if (!usage) {
      throw new Error('Usage record not found for current month');
    }

    // Increment usage count
    await this.prisma.subscription_usage.update({
      where: {
        usage_id: usage.usage_id,
      },
      data: {
        usage_count: {
          increment: 1,
        },
      },
    });
  }

  async createSubscriptionUser(data: {
    user_id: string;
    plan_id: string;
    status?: SubscriptionStatus;
    external_id?: string;
    billing_provider?: string;
    auto_renew?: boolean;
  }) {
   try {
    const result = await this.prisma.$transaction(async (tx) => {
      const plan = await tx.subscription_plans.findFirst({
        where: { tier: data.plan_id as PlanTier },
      });
      if (!plan) {
        throw new Error('Plan not found');
      }

      const subscription = await tx.user_subscriptions.create({
        data: {
          user_id: data.user_id,
          plan_id: plan.plan_id,
          tier: plan.tier,
          billing_period: plan.billing_period,
        },
        include: {
          user: true,
          plan: true,
        },
      });
      await tx.users.update({
        where: { user_id: data.user_id },
        data: { current_tier: plan.tier },
      });
      return subscription;
    }, { timeout: 30000 });

    // 🔔 Send admin notification about new subscription
    try {
      await this.authEmailService.sendNewSubscriptionNotification({
        username: result.user.username,
        email: result.user.email,
        userId: result.user.user_id,
        tier: result.tier,
        billingPeriod: result.billing_period,
        createdAt: result.started_at,
      });
    } catch (error) {
      this.logger.error(`Failed to send subscription notification: ${error instanceof Error ? error.message : String(error)}`);
    }

    return result;
   } catch (error) {
    throw new Error('Failed to create subscription');
   }
  }

}

