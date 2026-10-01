import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SubscriptionsService, PlanTier } from './subscriptions.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AppGateway } from 'src/gateways/app.gateway';
import { EmailSenderService } from '../onboarding-emails/services/email-sender.service';
import { frontendBase, upgradedToPremiumEmail } from './emails/premium-emails';
import { premiumPriceLabel } from '../../common/tiers';

/**
 * Billing-provider hook supplied by the caller (the super-admin controller
 * injects StripeService and adapts it). Kept as an interface so this module
 * does not depend on StripeModule (which already depends on this one).
 */
export interface StripePriceSwitcher {
  /** Read-only: what the next invoice would be after switching to the Premium price for `billingPeriod`. */
  preview(stripeSubscriptionId: string, billingPeriod: string): Promise<{
    status: string;
    current_price_id: string | null;
    already_on_price: boolean;
    period_end: Date | null;
    next_invoice_amount: number | null;
    next_invoice_date: Date | null;
  }>;
  /** Writes: move the subscription to the Premium price for `billingPeriod` with no proration. */
  switchPrice(stripeSubscriptionId: string, billingPeriod: string): Promise<{ changed: boolean }>;
}

export interface PremiumMigrationOptions {
  /** Default true. Only `{ dry_run: false }` writes anything. */
  dryRun?: boolean;
  /** Restrict to these users (canary runs). */
  userIds?: string[];
  /** When provided, Stripe-billed rows have their Stripe price switched too. */
  stripe?: StripePriceSwitcher;
}

export interface PremiumMigrationRow {
  subscription_id: string;
  user_id: string;
  email: string;
  old_tier: string;
  billing_period: string;
  billing_provider: string | null;
  current_period_end: Date | null;
  auto_renew: boolean;
  action: 'would_migrate' | 'migrated' | 'skipped' | 'error';
  reason?: string;
  stripe?: {
    status: string;
    current_price_id: string | null;
    already_on_price: boolean;
    next_invoice_amount: number | null;
    next_invoice_date: Date | null;
    price_switched?: boolean;
  } | { error: string };
}

export interface PremiumMigrationResult {
  dry_run: boolean;
  stripe_price_switch_enabled: boolean;
  scanned: number;
  migrated: number;
  skipped: number;
  errors: Array<{ subscription_id: string; user_id: string; error: string }>;
  rows: PremiumMigrationRow[];
}

/**
 * One-off, re-runnable move of every active legacy-tier subscription to
 * PREMIUM.
 *
 * - Local rows: plan/tier -> PREMIUM, period and expiry untouched (prepaid or
 *   comped windows are honoured), usage reseeded, PRO strategy cap lifted.
 * - Stripe-billed rows: when a `stripe` hook is supplied, the Stripe
 *   subscription's price is switched to Premium with proration_behavior
 *   'none', so nothing is charged now and $29.99 bills at the existing period
 *   end. Without the hook, Stripe rows are reported but skipped.
 * - Apple-billed rows: local only (Apple controls billing).
 * - Each user is notified once (in-app + email); idempotent via
 *   migrated_to_premium_at.
 *
 * IMPORTANT: run only after the new backend is deployed. The old code does not
 * know the PREMIUM tier and would lock migrated users out.
 */
@Injectable()
export class PremiumMigrationService {
  private readonly logger = new Logger(PremiumMigrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionsService,
    private readonly notifications: NotificationsService,
    private readonly appGateway: AppGateway,
    private readonly emailSender: EmailSenderService,
  ) {}

  async run(opts: PremiumMigrationOptions = {}): Promise<PremiumMigrationResult> {
    const dryRun = opts.dryRun !== false;

    const candidates = await this.prisma.user_subscriptions.findMany({
      where: {
        status: 'active',
        tier: { notIn: [PlanTier.FREE, PlanTier.PREMIUM] },
        migrated_to_premium_at: null,
        ...(opts.userIds?.length ? { user_id: { in: opts.userIds } } : {}),
      },
      include: { user: { select: { email: true, username: true, full_name: true } } },
      orderBy: { created_at: 'asc' },
    });

    const result: PremiumMigrationResult = {
      dry_run: dryRun,
      stripe_price_switch_enabled: !!opts.stripe,
      scanned: candidates.length,
      migrated: 0,
      skipped: 0,
      errors: [],
      rows: [],
    };

    for (const sub of candidates) {
      const row: PremiumMigrationRow = {
        subscription_id: sub.subscription_id,
        user_id: sub.user_id,
        email: sub.user.email,
        old_tier: sub.tier,
        billing_period: sub.billing_period,
        billing_provider: sub.billing_provider,
        current_period_end: sub.current_period_end,
        auto_renew: sub.auto_renew,
        action: dryRun ? 'would_migrate' : 'migrated',
      };
      result.rows.push(row);

      const isStripe = sub.billing_provider === 'stripe' && !!sub.external_id;

      // Stripe: preview (always) and switch (live only).
      if (isStripe) {
        if (!opts.stripe) {
          row.action = 'skipped';
          row.reason = 'stripe_switch_not_configured';
          result.skipped++;
          continue;
        }
        try {
          const preview = await opts.stripe.preview(sub.external_id!, sub.billing_period);
          row.stripe = {
            status: preview.status,
            current_price_id: preview.current_price_id,
            already_on_price: preview.already_on_price,
            next_invoice_amount: preview.next_invoice_amount,
            next_invoice_date: preview.next_invoice_date,
          };
          if (!['active', 'trialing', 'past_due'].includes(preview.status)) {
            row.action = 'skipped';
            row.reason = `stripe_status_${preview.status}`;
            result.skipped++;
            continue;
          }
        } catch (err: any) {
          row.action = 'error';
          row.stripe = { error: err?.message ?? String(err) };
          result.errors.push({ subscription_id: sub.subscription_id, user_id: sub.user_id, error: `stripe preview: ${err?.message}` });
          continue;
        }
      }

      if (dryRun) continue;

      try {
        if (isStripe && opts.stripe) {
          const switched = await opts.stripe.switchPrice(sub.external_id!, sub.billing_period);
          (row.stripe as any).price_switched = switched.changed;
        }

        const outcome = await this.subscriptions.migrateRowToPremium(sub.subscription_id);
        if (outcome.migrated === false) {
          row.action = 'skipped';
          row.reason = outcome.reason;
          result.skipped++;
          continue;
        }
        result.migrated++;
        await this.notify(sub);
        this.logger.log(
          `Migrated ${sub.user.email} ${sub.tier}/${sub.billing_period} (${sub.billing_provider}) -> PREMIUM`,
        );
      } catch (err: any) {
        row.action = 'error';
        row.reason = err?.message ?? String(err);
        result.errors.push({ subscription_id: sub.subscription_id, user_id: sub.user_id, error: err?.message ?? String(err) });
        this.logger.error(`Premium migration failed for ${sub.subscription_id}: ${err?.message}`);
      }
    }

    return result;
  }

  private async notify(sub: {
    user_id: string;
    tier: string;
    billing_period: string;
    billing_provider: string | null;
    current_period_end: Date | null;
    user: { email: string; username: string; full_name: string | null };
  }): Promise<void> {
    const periodLabel = sub.current_period_end
      ? sub.current_period_end.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
      : 'your next billing date';
    const message =
      sub.billing_provider === 'apple'
        ? 'Your plan is now Premium with every feature unlocked. Your App Store billing is unchanged.'
        : `Your plan is now Premium with every feature unlocked. Nothing changes this cycle; from ${periodLabel} Premium is ${premiumPriceLabel(sub.billing_period)}.`;

    try {
      const notification = await this.notifications.createNotification({
        user_id: sub.user_id,
        type: 'subscription_upgraded',
        title: 'You have been upgraded to Premium',
        message,
        read: false,
        metadata: { old_tier: sub.tier, new_tier: PlanTier.PREMIUM },
      });
      this.notifications.sendNotification(sub.user_id, 'You have been upgraded to Premium', message);
      this.appGateway.emitNotificationCount(sub.user_id, 1, notification);
    } catch (err: any) {
      this.logger.warn(`In-app upgrade notice failed for ${sub.user_id}: ${err?.message}`);
    }

    try {
      const email = upgradedToPremiumEmail({
        name: sub.user.full_name ?? sub.user.username,
        oldTier: sub.tier,
        billingProvider: sub.billing_provider,
        billingPeriod: sub.billing_period,
        periodEnd: sub.current_period_end,
      });
      await this.emailSender.send({
        to: sub.user.email,
        subject: email.subject,
        html: email.html,
        unsubscribeUrl: `${frontendBase()}/unsubscribe`,
      });
    } catch (err: any) {
      this.logger.warn(`Upgrade email failed for ${sub.user.email}: ${err?.message}`);
    }
  }
}
