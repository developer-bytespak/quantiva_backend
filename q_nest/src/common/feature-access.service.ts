// src/common/feature-access.service.ts
import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
// import { FeatureType, PlanTier } from '@prisma/client';

export enum FeatureType {
  CUSTOM_STRATEGIES = 'CUSTOM_STRATEGIES',
  VC_POOL_ACCESS = 'VC_POOL_ACCESS',
  EARLY_ACCESS = 'EARLY_ACCESS',
  // Add more features as needed
}

export enum PlanTier {
  FREE = 'FREE',
  PRO = 'PRO',
  ELITE = 'ELITE',
}

interface FeatureCheckResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  message: string;
}

@Injectable()
export class FeatureAccessService {
  constructor(private prisma: PrismaService) {}

  /**
   * Check if user can access a feature
   */
  async canAccessFeature(
    userId: string,
    featureType: FeatureType,
  ): Promise<FeatureCheckResult> {
    // Get user's active subscription
    const subscription = await this.prisma.user_subscriptions.findFirst({
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
      },
    });

    // FREE tier - most features blocked
    if (!subscription) {
      return {
        allowed: false,
        remaining: 0,
        limit: 0,
        message: `Upgrade to PRO or ELITE to access ${featureType}`,
      };
    }

    // Check if feature is enabled for this plan
    const feature = subscription.plan.plan_features.find(
      (f) => f.feature_type === featureType,
    );

    if (!feature || !feature.enabled) {
      return {
        allowed: false,
        remaining: 0,
        limit: 0,
        message: `${featureType} not available in ${subscription.tier} plan`,
      };
    }

    // Check usage limits
    if (feature.limit_value !== null && feature.limit_value > 0) {
      const usage = await this.getFeatureUsage(
        subscription.subscription_id,
        featureType,
      );

      const remaining = Math.max(0, feature.limit_value - usage);

      if (remaining <= 0) {
        return {
          allowed: false,
          remaining: 0,
          limit: feature.limit_value,
          message: `${featureType} limit reached. Upgrade to increase limit.`,
        };
      }

      return {
        allowed: true,
        remaining,
        limit: feature.limit_value,
        message: 'Feature access allowed',
      };
    }

    // Unlimited feature
    return {
      allowed: true,
      remaining: -1, // -1 means unlimited
      limit: -1,
      message: 'Feature access allowed (unlimited)',
    };
  }

  /**
   * Get current usage count for a feature
   */
  async getFeatureUsage(
    subscriptionId: string,
    featureType: FeatureType,
  ): Promise<number> {
    const usage = await this.prisma.subscription_usage.findUnique({
      where: {
        subscription_id_feature_type: {
          subscription_id: subscriptionId,
          feature_type: featureType,
        },
      },
    });

    return usage?.usage_count || 0;
  }

  /**
   * Increment feature usage
   */
  async incrementUsage(
    subscriptionId: string,
    userId: string,
    featureType: FeatureType,
  ): Promise<void> {
    const subscription = await this.prisma.user_subscriptions.findUnique({
      where: { subscription_id: subscriptionId },
    });

    if (!subscription) {
      throw new BadRequestException('Subscription not found');
    }

    // Get current billing period
    const now = new Date();
    const periodStart = subscription.current_period_start || now;
    const periodEnd = subscription.current_period_end || this.getNextBillingDate(now, subscription.billing_period);

    await this.prisma.subscription_usage.upsert({
      where: {
        subscription_id_feature_type: {
          subscription_id: subscriptionId,
          feature_type: featureType,
        },
      },
      update: {
        usage_count: {
          increment: 1,
        },
        updated_at: new Date(),
      },
      create: {
        subscription_id: subscriptionId,
        user_id: userId,
        feature_type: featureType,
        usage_count: 1,
        period_start: periodStart,
        period_end: periodEnd,
      },
    });
  }

  /**
   * Get user's current tier
   */
  async getUserTier(userId: string): Promise<PlanTier> {
    const user = await this.prisma.users.findUnique({
      where: { user_id: userId },
      select: { current_tier: true },
    });

    return user?.current_tier || PlanTier.FREE;
  }

  /**
   * Check if user has at least the specified tier
   */
  async hasTierOrHigher(
    userId: string,
    requiredTier: PlanTier,
  ): Promise<boolean> {
    const tierHierarchy = {
      [PlanTier.FREE]: 0,
      [PlanTier.PRO]: 1,
      [PlanTier.ELITE]: 2,
    };

    const userTier = await this.getUserTier(userId);
    return tierHierarchy[userTier] >= tierHierarchy[requiredTier];
  }

  /**
   * Get active subscription for user
   */
  async getActiveSubscription(userId: string) {
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
      },
    });
  }

  /**
   * Helper: Calculate next billing date
   */
  private getNextBillingDate(date: Date, billingPeriod: any): Date {
    const next = new Date(date);
    switch (billingPeriod) {
      case 'MONTHLY':
        next.setMonth(next.getMonth() + 1);
        break;
      case 'QUARTERLY':
        next.setMonth(next.getMonth() + 3);
        break;
      case 'YEARLY':
        next.setFullYear(next.getFullYear() + 1);
        break;
    }
    return next;
  }
}