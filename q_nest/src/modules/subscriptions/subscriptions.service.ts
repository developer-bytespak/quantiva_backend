import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SubscriptionStatus } from '@prisma/client';

export enum PlanTier {
  FREE = 'FREE',
  PRO = 'PRO',
  ELITE = 'ELITE',
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
export class SubscriptionsService {
  constructor(private prisma: PrismaService) { }

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
    return this.prisma.subscription_plans.findMany({
      orderBy: [{ tier: 'asc' }, { billing_period: 'asc' }],
    });
  }

  /**
   * Find all plans grouped by tier with pricing tiers
   */
  async findAllPlansGrouped() {
    const allPlans = await this.prisma.subscription_plans.findMany({
      orderBy: [{ tier: 'asc' }, { billing_period: 'asc' }],
    });

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

    return Object.values(grouped);
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
      });

      results.push(result);
    }

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

    return results;
  }

  /**
   * Delete plan by tier (deletes all billing period variants)
   */
  async deletePlan(tier: PlanTier) {
    return this.prisma.subscription_plans.deleteMany({
      where: { tier },
    });
  }

  /**
   * Delete single plan by ID
   */
  async deletePlanById(planId: string) {
    return this.prisma.subscription_plans.delete({
      where: { plan_id: planId },
    });
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

  async createSubscription(data: {
    user_id: string;
    plan_id: string;
    status?: SubscriptionStatus;
    external_id?: string;
    billing_provider?: string;
    auto_renew?: boolean;
  }) {

    return this.prisma.$transaction(async (tx) => {
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

      // 3️⃣ Subscription create karo
      const subscription = await tx.user_subscriptions.create({
        data: {
          user_id: data.user_id,
          plan_id: data.plan_id,
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

      // 5️⃣ Subscription usage records initialize karo
      // createSubscription me Line 489-520 replace karo:
      // 5️⃣ Subscription usage records initialize karo
      if (plan.plan_features && plan.plan_features.length > 0) {
        await tx.subscription_usage.createMany({
          data: plan.plan_features.map(feature => ({
            subscription_id: subscription.subscription_id,
            user_id: data.user_id,
            feature_type: feature.feature_type,
            usage_count: 0,
            period_start: current_period_start,
            period_end: current_period_end,
          })),
        });
      }
      return subscription;
    });
  }

  async updateSubscription(id: string, data: {
    status?: SubscriptionStatus;
    expires_at?: Date;
    billing_provider?: string;
    plan_id?: string;
    auto_renew?: boolean;
  }) {
    return this.prisma.$transaction(async (tx) => {
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
      };

      if (data.plan_id && data.plan_id !== currentSubscription.plan_id) {
        newPlan = await tx.subscription_plans.findUnique({
          where: { plan_id: data.plan_id },
          include: { plan_features: true },
        });

        if (!newPlan) {
          throw new Error('New plan not found');
        }

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
          plan_id: data.plan_id,
          tier: newPlan.tier,
          billing_period: newPlan.billing_period,
          current_period_start: now,
          current_period_end,
          next_billing_date: current_period_end,
          last_payment_date: now,
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

        // 6️⃣ Create new subscription usage records for new plan features
        // updateSubscription me Line 489-520 replace karo (same):
        // 6️⃣ Create new subscription usage records for new plan features
        if (newPlan.plan_features && newPlan.plan_features.length > 0) {
          await tx.subscription_usage.createMany({
            data: newPlan.plan_features.map(feature => ({
              subscription_id: id,
              user_id: currentSubscription.user_id,
              feature_type: feature.feature_type,
              usage_count: 0,
              period_start: updateData.current_period_start,
              period_end: updateData.current_period_end,
            })),
          });
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

      return updated;
    });
  }

  async deleteSubscription(id: string) {
    return this.prisma.user_subscriptions.delete({
      where: { subscription_id: id },
    });
  }


  /**
 * Get active subscription with all features
 */
  async getActiveSubscriptionWithFeatures(userId: string) {
    return this.prisma.user_subscriptions.findFirst({
      where: {
        user_id: userId,
        status: 'active',
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
  }) {
    return this.prisma.payment_history.create({
      data: {
        ...data,
        currency: data.currency || 'USD',
        paid_at: data.status === 'succeeded' ? new Date() : null,
      },
    });
  }

  /**
   * Cancel subscription
   */
  async cancelSubscription(subscriptionId: string) {
    return this.prisma.user_subscriptions.update({
      where: { subscription_id: subscriptionId },
      data: {
        status: 'cancelled',
        cancelled_at: new Date(),
        auto_renew: false,
      },
    });
  }

  async getDashboard(userId: string) {
    // Current subscription
    const currentSubscription = await this.prisma.user_subscriptions.findFirst({
      where: { user_id: userId, status: 'active' },
      include: {
        plan: { include: { plan_features: true } },
        subscription_usage: true,
      },
      orderBy: { created_at: 'desc' },
    });

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

}

