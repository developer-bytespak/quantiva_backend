import {
  Controller,
  Post,
  Req,
  Headers,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
  Logger,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Request } from 'express';
import Stripe from 'stripe';
import { QhqTransactionType } from '.prisma/client';
import { StripeService, PREMIUM_TRIAL_DAYS } from './stripe.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { AppGateway } from 'src/gateways/app.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { TradeFeesService } from '../trade-fees/trade-fees.service';
import { PrismaService } from '../../prisma/prisma.service';
import { QhqTokenService } from '../qhq-token/qhq-token.service';
import { EmailSenderService } from '../onboarding-emails/services/email-sender.service';
import {
  isPremiumBillingPeriod,
  PREMIUM_BILLING_PERIODS,
  PremiumBillingPeriod,
  subscriptionQhqRuleKey,
} from '../../common/tiers';
import {
  amountLabel,
  cancelScheduledEmail,
  formatDate,
  frontendBase,
  paymentFailedEmail,
  premiumActiveEmail,
  priceLabel,
  subscriptionEndedEmail,
  trialEndingSoonEmail,
  trialStartedEmail,
} from '../subscriptions/emails/premium-emails';

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

@Controller('stripe')
export class StripeController {
  private readonly logger = new Logger(StripeController.name);

  constructor(
    private readonly stripeService: StripeService,
    private readonly appGateway: AppGateway,
    private readonly notificationsService: NotificationsService,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly tradeFeesService: TradeFeesService,
    private readonly prisma: PrismaService,
    private readonly qhqService: QhqTokenService,
    private readonly emailSender: EmailSenderService,
  ) {}

  // ───────────────────────────────────────────────────────────────────
  // Checkout
  // ───────────────────────────────────────────────────────────────────

  /**
   * Start a Premium checkout for a billing period (MONTHLY default, QUARTERLY,
   * YEARLY). The plan row and Stripe price are resolved server side. First-time
   * subscribers get a 7-day trial on any period; the card is collected either
   * way and Stripe charges the period amount automatically when the trial ends
   * unless the user cancels first.
   */
  @Post('create-checkout-session')
  async createCheckout(@Req() req: any) {
    const userId = req.subscriptionUser?.user_id;
    if (!userId) {
      throw new UnauthorizedException('User not authenticated!');
    }

    const activeSubscription = await this.prisma.user_subscriptions.findFirst({
      where: { user_id: userId, status: 'active' },
    });

    if (activeSubscription && activeSubscription.tier !== 'FREE') {
      if (!activeSubscription.auto_renew && activeSubscription.cancelled_at) {
        const until = activeSubscription.expires_at ?? activeSubscription.current_period_end;
        throw new BadRequestException(
          `Your subscription is active until ${formatDate(until)}. Resume it from Settings instead of starting a new one.`,
        );
      }
      throw new BadRequestException('You already have an active subscription.');
    }

    const { success_url, cancel_url, price_id, plan_id, billing_period } = req.body ?? {};
    if (price_id || plan_id) {
      // Legacy clients still send these; they are ignored on purpose.
      this.logger.debug(`Ignoring client-supplied price_id/plan_id for user ${userId}`);
    }

    const period: PremiumBillingPeriod = isPremiumBillingPeriod(billing_period) ? billing_period : 'MONTHLY';
    if (billing_period !== undefined && !isPremiumBillingPeriod(billing_period)) {
      throw new BadRequestException(`billing_period must be one of: ${PREMIUM_BILLING_PERIODS.join(', ')}`);
    }

    const premiumPlan = await this.subscriptionsService.getPremiumPlan(period);
    if (!premiumPlan) {
      throw new ServiceUnavailableException('The Premium plan is not configured');
    }

    let priceId: string;
    try {
      priceId = this.stripeService.premiumPriceIdFor(period);
    } catch {
      throw new ServiceUnavailableException('Stripe pricing is not configured');
    }

    const [trialEligible, user, pendingDiscount] = await Promise.all([
      this.subscriptionsService.isTrialEligible(userId),
      this.prisma.users.findUnique({
        where: { user_id: userId },
        select: { email: true, stripe_customer_id: true },
      }),
      this.qhqService.getPendingDiscount(userId),
    ]);

    const checkoutParams = {
      priceId,
      successUrl: success_url,
      cancelUrl: cancel_url,
      clientReferenceId: userId,
      customerEmail: user?.email ?? null,
      metadata: {
        user_id: userId,
        plan_id: premiumPlan.plan_id,
        billing_period: period,
        ...(pendingDiscount ? { qhq_discount_id: pendingDiscount.id } : {}),
      },
      discountPercent: pendingDiscount?.discount_percent,
      trialDays: trialEligible ? PREMIUM_TRIAL_DAYS : 0,
    };

    let session;
    try {
      session = await this.stripeService.createCheckoutSession({
        ...checkoutParams,
        customerId: user?.stripe_customer_id ?? null,
      });
    } catch (err: any) {
      // A stored customer id that Stripe does not know in this mode (e.g. one
      // created in a sandbox before going live, or deleted in the Dashboard).
      // Forget it and let Checkout create a fresh customer.
      const staleCustomer =
        !!user?.stripe_customer_id && err?.code === 'resource_missing' && err?.param === 'customer';
      if (!staleCustomer) throw err;
      this.logger.warn(
        `Stripe customer ${user!.stripe_customer_id} for user ${userId} does not exist in this mode; clearing and retrying checkout`,
      );
      await this.prisma.users
        .update({ where: { user_id: userId }, data: { stripe_customer_id: null } })
        .catch(() => undefined);
      session = await this.stripeService.createCheckoutSession({ ...checkoutParams, customerId: null });
    }

    return {
      url: session.url,
      sessionId: session.id,
      billing_period: period,
      trial: trialEligible,
      trial_days: trialEligible ? PREMIUM_TRIAL_DAYS : 0,
    };
  }

  // ───────────────────────────────────────────────────────────────────
  // Cancel / resume (cancel-at-period-end)
  // ───────────────────────────────────────────────────────────────────

  @Post('subscription/cancel')
  async cancelSubscription(@Req() req: any) {
    const userId = req.subscriptionUser?.user_id;
    if (!userId) {
      throw new UnauthorizedException('User not authenticated');
    }

    const active = await this.prisma.user_subscriptions.findFirst({
      where: { user_id: userId, status: 'active' },
      include: { plan: true },
    });

    if (!active || active.tier === 'FREE') {
      throw new BadRequestException('You are on the Free plan. There is nothing to cancel.');
    }

    const now = Date.now();
    const isTrialing = !!active.trial_end && new Date(active.trial_end).getTime() > now;

    let updated: any;
    let accessUntil: Date | null = active.expires_at ?? active.current_period_end ?? null;

    if (active.billing_provider === 'admin_override') {
      // Comp plan granted by super-admin: no billing involved, downgrade now.
      updated = await this.subscriptionsService.handleAdminOverrideSubscriptionCancelled(
        active.subscription_id,
      );
      accessUntil = new Date();
    } else if (active.billing_provider === 'stripe' && active.external_id) {
      if (!active.auto_renew && active.cancelled_at) {
        // Already scheduled; idempotent.
        return this.cancelResponse(active, accessUntil, isTrialing, true);
      }

      const stripeSub = await this.stripeService.cancelSubscriptionAtPeriodEnd(active.external_id);
      accessUntil = this.stripeService.getPeriodEnd(stripeSub) ?? accessUntil;

      // Bill any accumulated trade fees now rather than waiting for month end.
      try {
        await this.tradeFeesService.processCancellationFees(userId);
      } catch (err: any) {
        this.logger.warn(`Trade-fee cancellation billing failed (non-blocking): ${err.message}`);
      }

      updated = await this.subscriptionsService.cancelUserSubscription(userId, {
        stripeSubscriptionId: active.external_id,
        stripeCurrentPeriodEnd: accessUntil,
      });
    } else if (active.billing_provider === 'apple') {
      throw new BadRequestException(
        'This subscription is billed through the App Store. Manage it in iOS Settings > Subscriptions.',
      );
    } else {
      throw new BadRequestException('No active subscription to cancel');
    }

    if (!updated) {
      throw new BadRequestException('Failed to cancel subscription');
    }

    const title = isTrialing ? 'Trial cancelled' : 'Cancellation scheduled';
    const message = isTrialing
      ? `Your free trial is cancelled and you will not be charged. Premium access continues until ${formatDate(accessUntil)}.`
      : active.billing_provider === 'admin_override'
        ? 'Your complimentary plan has ended and your account is now on the Free plan.'
        : `Your Premium plan will not renew. You keep full access until ${formatDate(accessUntil)}.`;
    await this.notifyUser(userId, 'subscription_cancelled', title, message);
    if (active.billing_provider === 'stripe') {
      await this.emailUser(userId, (name) => cancelScheduledEmail({ name, accessUntil, wasTrial: isTrialing }));
    }

    return this.cancelResponse(updated, accessUntil, isTrialing, false);
  }

  private cancelResponse(row: any, accessUntil: Date | null, isTrialing: boolean, alreadyScheduled: boolean) {
    return {
      subscription_id: row.subscription_id,
      status: row.status,
      current_period_end: row.current_period_end,
      expires_at: row.expires_at,
      auto_renew: row.auto_renew,
      access_until: accessUntil,
      is_trialing: isTrialing,
      already_scheduled: alreadyScheduled,
    };
  }

  /** Undo a pending cancellation before the period ends. */
  @Post('subscription/resume')
  async resumeSubscription(@Req() req: any) {
    const userId = req.subscriptionUser?.user_id;
    if (!userId) {
      throw new UnauthorizedException('User not authenticated');
    }

    const active = await this.prisma.user_subscriptions.findFirst({
      where: { user_id: userId, status: 'active', billing_provider: 'stripe' },
    });
    if (!active || active.tier === 'FREE' || !active.external_id) {
      throw new BadRequestException('No subscription to resume');
    }
    if (active.auto_renew || !active.cancelled_at) {
      throw new BadRequestException('Your subscription is not scheduled for cancellation');
    }
    const periodEnd = active.expires_at ?? active.current_period_end;
    if (periodEnd && new Date(periodEnd).getTime() < Date.now()) {
      throw new BadRequestException('This subscription has already ended. Please subscribe again.');
    }

    const stripeSub = await this.stripeService.resumeSubscription(active.external_id);
    const updated = await this.subscriptionsService.resumeStripeSubscriptionLocal(userId, active.external_id);

    const renewsOn = this.stripeService.getPeriodEnd(stripeSub) ?? active.current_period_end;
    await this.notifyUser(
      userId,
      'subscription_resumed',
      'Premium resumed',
      `Your Premium plan will renew on ${formatDate(renewsOn)}.`,
    );

    return {
      subscription_id: updated?.subscription_id ?? active.subscription_id,
      status: updated?.status ?? active.status,
      auto_renew: true,
      current_period_end: renewsOn,
    };
  }

  /**
   * Switch a Premium subscription between monthly / quarterly / yearly.
   * The Stripe price is swapped with no proration and the billing anchor is
   * kept, so nothing is charged now: the new amount bills at the current
   * period end (or at the end of the trial), and the new interval applies
   * from then on.
   */
  @Post('subscription/change-period')
  async changeBillingPeriod(@Req() req: any) {
    const userId = req.subscriptionUser?.user_id;
    if (!userId) {
      throw new UnauthorizedException('User not authenticated');
    }

    const requested = req.body?.billing_period;
    if (!isPremiumBillingPeriod(requested)) {
      throw new BadRequestException(`billing_period must be one of: ${PREMIUM_BILLING_PERIODS.join(', ')}`);
    }

    const active = await this.prisma.user_subscriptions.findFirst({
      where: { user_id: userId, status: 'active' },
    });
    if (!active || active.tier === 'FREE') {
      throw new BadRequestException('You are on the Free plan. Start a Premium plan first.');
    }
    if (active.billing_provider === 'apple') {
      throw new BadRequestException(
        'This subscription is billed through the App Store. Change it in iOS Settings > Subscriptions.',
      );
    }
    if (active.billing_provider !== 'stripe' || !active.external_id) {
      throw new BadRequestException('This plan cannot be changed here. Contact support.');
    }
    if (!active.auto_renew && active.cancelled_at) {
      throw new BadRequestException('Resume your subscription before changing its billing period.');
    }
    if (active.billing_period === requested) {
      throw new BadRequestException(`You are already billed ${requested.toLowerCase()}.`);
    }

    const plan = await this.subscriptionsService.getPremiumPlan(requested);
    if (!plan) {
      throw new ServiceUnavailableException('The Premium plan is not configured');
    }
    let priceId: string;
    try {
      priceId = this.stripeService.premiumPriceIdFor(requested);
    } catch {
      throw new ServiceUnavailableException('Stripe pricing is not configured');
    }

    const { subscription: stripeSub } = await this.stripeService.switchSubscriptionPrice(active.external_id, priceId);
    const row = await this.subscriptionsService.syncFromStripeSubscription(stripeSub, this.syncOpts(userId));

    const effectiveOn = row?.next_billing_date ?? row?.current_period_end ?? active.current_period_end;
    const label = priceLabel(requested, plan.price as any);
    await this.notifyUser(
      userId,
      'subscription_updated',
      'Billing period updated',
      `Your Premium plan switches to ${label} on ${formatDate(effectiveOn)}. Nothing is charged today.`,
    );

    return {
      subscription_id: row?.subscription_id ?? active.subscription_id,
      billing_period: requested,
      price: plan.price,
      effective_on: effectiveOn,
      message: `Your plan switches to ${label} on ${formatDate(effectiveOn)}.`,
    };
  }

  // ───────────────────────────────────────────────────────────────────
  // Webhook
  // ───────────────────────────────────────────────────────────────────

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async handleWebhook(@Req() req: RawBodyRequest, @Headers('stripe-signature') signature: string) {
    const rawBody = req.rawBody;
    if (!rawBody) {
      this.logger.error('Raw body not available; ensure json({ verify }) middleware is configured in main.ts');
      throw new UnauthorizedException('Webhook signature verification failed');
    }

    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      this.logger.error('STRIPE_WEBHOOK_SECRET is not set');
      throw new UnauthorizedException('Webhook not configured');
    }

    let event: Stripe.Event;
    try {
      event = this.stripeService.constructWebhookEvent(rawBody, signature, webhookSecret);
    } catch (err: any) {
      this.logger.warn(`Stripe webhook signature verification failed: ${err?.message}`);
      throw new UnauthorizedException('Invalid webhook signature');
    }

    // Event-level idempotency: Stripe retries on timeouts and may deliver twice.
    try {
      await this.prisma.billing_webhook_events.create({
        data: { event_id: event.id, provider: 'stripe', type: event.type },
      });
    } catch (err: any) {
      if (err?.code === 'P2002') {
        this.logger.log(`Stripe event ${event.id} (${event.type}) already processed; skipping`);
        return { received: true, duplicate: true };
      }
      throw err;
    }

    let error: string | null = null;
    try {
      await this.handleStripeEvent(event);
    } catch (err: any) {
      error = err?.message ?? String(err);
      // Return 200 so Stripe does not retry forever; the ledger row keeps the error for recovery.
      this.logger.error(`Stripe event ${event.id} (${event.type}) failed: ${error}`);
    }

    await this.prisma.billing_webhook_events
      .update({ where: { event_id: event.id }, data: { processed_at: new Date(), error } })
      .catch(() => undefined);

    return { received: true };
  }

  private async handleStripeEvent(event: Stripe.Event): Promise<void> {
    switch (event.type) {
      case 'checkout.session.completed':
        return this.onCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        return this.onSubscriptionChanged((event.data.object as Stripe.Subscription).id);
      case 'customer.subscription.deleted':
        return this.onSubscriptionDeleted(event.data.object as Stripe.Subscription);
      case 'customer.subscription.trial_will_end':
        return this.onTrialWillEnd(event.data.object as Stripe.Subscription);
      case 'invoice.paid':
        return this.onInvoicePaid(event.data.object as Stripe.Invoice);
      case 'invoice.payment_failed':
        return this.onInvoicePaymentFailed(event.data.object as Stripe.Invoice);
      default:
        this.logger.debug(`Unhandled Stripe event type ${event.type}`);
    }
  }

  private syncOpts(userIdHint?: string) {
    return { premiumPriceMap: this.stripeService.premiumPriceMap(), userIdHint };
  }

  /** Plan price for a local row's billing period (for emails), or null. */
  private async rowPrice(row: { plan_id?: string | null }): Promise<string | null> {
    if (!row?.plan_id) return null;
    const plan = await this.prisma.subscription_plans.findUnique({
      where: { plan_id: row.plan_id },
      select: { price: true },
    });
    return plan ? String(plan.price) : null;
  }

  /**
   * Checkout finished: link the Stripe customer, mirror the subscription
   * (trialing or active) and welcome the user. Payments are NOT recorded here;
   * invoice.paid owns payment history and QHQ so a $0 trial invoice never
   * produces a fake payment.
   */
  private async onCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
    if (session.mode !== 'subscription') return;

    const userId = session.client_reference_id ?? session.metadata?.user_id ?? null;
    const stripeCustomerId = typeof session.customer === 'string' ? session.customer : session.customer?.id ?? null;
    const subscriptionId =
      typeof session.subscription === 'string' ? session.subscription : session.subscription?.id ?? null;

    if (userId && stripeCustomerId) {
      await this.prisma.users
        .update({ where: { user_id: userId }, data: { stripe_customer_id: stripeCustomerId } })
        .catch((err) => this.logger.warn(`Failed to save stripe_customer_id: ${err.message}`));
    }

    if (!subscriptionId) {
      this.logger.warn(`checkout.session.completed ${session.id} has no subscription id`);
      return;
    }

    const stripeSub = await this.stripeService.retrieveSubscription(subscriptionId);
    const row = await this.subscriptionsService.syncFromStripeSubscription(
      stripeSub,
      this.syncOpts(userId ?? undefined),
    );
    if (!row) {
      this.logger.warn(`checkout.session.completed ${session.id}: sync produced no row`);
      return;
    }

    const qhqDiscountId = session.metadata?.qhq_discount_id;
    if (qhqDiscountId) {
      await this.prisma.qhq_subscription_discounts
        .update({ where: { id: qhqDiscountId }, data: { applied: true, applied_at: new Date() } })
        .catch((err) => this.logger.warn(`Failed to mark QHQ discount as applied: ${err.message}`));
    }

    const price = await this.rowPrice(row);
    const period = row.billing_period;
    const trialEnd = row.trial_end ? new Date(row.trial_end) : null;
    const trialing = !!trialEnd && trialEnd.getTime() > Date.now();
    if (trialing) {
      await this.notifyUser(
        row.user_id,
        'subscription_trial_started',
        'Your 7-day Premium trial has started',
        `Every Premium feature is unlocked. Your card will be charged ${amountLabel(period, price)} on ${formatDate(trialEnd)} unless you cancel before then.`,
      );
      await this.emailUser(row.user_id, (name) =>
        trialStartedEmail({ name, trialEnd, billingPeriod: period, price }),
      );
    } else {
      await this.notifyUser(
        row.user_id,
        'subscription_active',
        'Premium is active',
        `Your Premium subscription is active at ${priceLabel(period, price)} and every feature is unlocked.`,
      );
      await this.emailUser(row.user_id, (name) =>
        premiumActiveEmail({
          name,
          nextBillingDate: row.next_billing_date ?? row.current_period_end,
          billingPeriod: period,
          price,
        }),
      );
    }
    this.logger.log(`Premium ${trialing ? 'trial' : 'subscription'} (${period}) activated for user ${row.user_id}`);
  }

  /** created / updated: re-fetch and mirror (status, periods, trial, cancel_at_period_end). */
  private async onSubscriptionChanged(subscriptionId: string): Promise<void> {
    const stripeSub = await this.stripeService.retrieveSubscription(subscriptionId);
    await this.subscriptionsService.syncFromStripeSubscription(stripeSub, this.syncOpts());
  }

  /** deleted: period (or trial) ended after a scheduled cancel, or Stripe gave up on payment. */
  private async onSubscriptionDeleted(sub: Stripe.Subscription): Promise<void> {
    const periodEnd = this.stripeService.getPeriodEnd(sub);
    const local = await this.prisma.user_subscriptions.findFirst({
      where: { billing_provider: 'stripe', external_id: sub.id },
      select: { user_id: true, status: true },
    });
    const result = await this.subscriptionsService.handleStripeSubscriptionCancelled(sub.id, periodEnd);
    if (!result || !local || local.status === 'cancelled') return;

    try {
      await this.tradeFeesService.processCancellationFees(local.user_id);
    } catch (err: any) {
      this.logger.warn(`Trade-fee billing on subscription end failed (non-blocking): ${err?.message}`);
    }

    await this.notifyUser(
      local.user_id,
      'subscription_ended',
      'Your Premium subscription has ended',
      'Your account is now on the Free plan. You can resubscribe anytime from Settings.',
    );
    await this.emailUser(local.user_id, (name) => subscriptionEndedEmail({ name }));
  }

  /** Fires 3 days before a trial ends. One reminder per subscription. */
  private async onTrialWillEnd(sub: Stripe.Subscription): Promise<void> {
    const local = await this.prisma.user_subscriptions.findFirst({
      where: { billing_provider: 'stripe', external_id: sub.id },
    });
    if (!local || local.trial_reminder_sent_at) return;
    if (!local.auto_renew && local.cancelled_at) return; // already cancelled; nothing will be charged

    const trialEnd =
      typeof (sub as any).trial_end === 'number' ? new Date((sub as any).trial_end * 1000) : local.trial_end;
    const price = await this.rowPrice(local);

    await this.notifyUser(
      local.user_id,
      'subscription_trial_ending',
      'Your Premium trial ends in 3 days',
      `Your card will be charged ${amountLabel(local.billing_period, price)} on ${formatDate(trialEnd)} unless you cancel before then.`,
    );
    await this.emailUser(local.user_id, (name) =>
      trialEndingSoonEmail({ name, trialEnd, billingPeriod: local.billing_period, price }),
    );

    await this.prisma.user_subscriptions.update({
      where: { subscription_id: local.subscription_id },
      data: { trial_reminder_sent_at: new Date() },
    });
  }

  /**
   * Every successful subscription charge: first invoice (no trial), the
   * post-trial charge, and renewals. Idempotent on invoice.id for both the
   * payment row and the QHQ award. Trade-fee invoices have no subscription and
   * are skipped; $0 trial invoices are skipped.
   */
  private async onInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
    const subscriptionId = this.stripeService.getSubscriptionIdFromInvoice(invoice);
    if (!subscriptionId) return;

    const amount = Number((invoice as any).amount_paid ?? 0) / 100;
    if (amount <= 0) return;

    const billingReason = (invoice as any).billing_reason as string | undefined;
    if (billingReason && !['subscription_create', 'subscription_cycle'].includes(billingReason)) {
      return;
    }

    // Keep the local row current (period roll-over, trialing -> active).
    const stripeSub = await this.stripeService.retrieveSubscription(subscriptionId);
    await this.subscriptionsService.syncFromStripeSubscription(stripeSub, this.syncOpts());

    const local = await this.prisma.user_subscriptions.findFirst({
      where: { billing_provider: 'stripe', external_id: subscriptionId },
    });
    if (!local) {
      this.logger.warn(`invoice.paid ${invoice.id}: no local subscription for ${subscriptionId}`);
      return;
    }

    const currency = ((invoice as any).currency || 'usd').toUpperCase();

    const alreadyRecorded = await this.prisma.payment_history.findFirst({
      where: { payment_provider: 'stripe', external_payment_id: invoice.id, status: 'succeeded' },
      select: { payment_id: true },
    });
    if (!alreadyRecorded) {
      await this.subscriptionsService.recordPayment({
        subscription_id: local.subscription_id,
        user_id: local.user_id,
        amount,
        currency,
        status: 'succeeded',
        payment_provider: 'stripe',
        external_payment_id: invoice.id,
        payment_method: 'card',
        invoice_url: (invoice as any).hosted_invoice_url || null,
        receipt_url: (invoice as any).invoice_pdf || null,
        failure_reason: null,
      });
      await this.prisma.user_subscriptions.update({
        where: { subscription_id: local.subscription_id },
        data: { last_payment_date: new Date(), provider_status: 'active' },
      });
      this.logger.log(`Payment recorded for subscription ${local.subscription_id}: ${amount} ${currency} (${billingReason})`);
    }

    await this.awardSubscriptionQhq(local.user_id, local.tier, local.billing_period, invoice.id);
  }

  /** Card declined: keep access, record the failure, ask the user to fix their card. */
  private async onInvoicePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
    const subscriptionId = this.stripeService.getSubscriptionIdFromInvoice(invoice);
    if (!subscriptionId) return;

    const local = await this.prisma.user_subscriptions.findFirst({
      where: { billing_provider: 'stripe', external_id: subscriptionId },
    });
    if (!local) return;

    await this.prisma.user_subscriptions.update({
      where: { subscription_id: local.subscription_id },
      data: { provider_status: 'past_due' },
    });

    const amount = Number((invoice as any).amount_due ?? 0) / 100;
    const alreadyRecorded = await this.prisma.payment_history.findFirst({
      where: { payment_provider: 'stripe', external_payment_id: invoice.id, status: 'failed' },
      select: { payment_id: true },
    });
    if (!alreadyRecorded && amount > 0) {
      await this.subscriptionsService.recordPayment({
        subscription_id: local.subscription_id,
        user_id: local.user_id,
        amount,
        currency: ((invoice as any).currency || 'usd').toUpperCase(),
        status: 'failed',
        payment_provider: 'stripe',
        external_payment_id: invoice.id,
        payment_method: 'card',
        invoice_url: (invoice as any).hosted_invoice_url || null,
        receipt_url: null,
        failure_reason:
          (invoice as any).last_finalization_error?.message ?? 'Payment failed',
      });
    }

    const invoiceUrl: string | null = (invoice as any).hosted_invoice_url || null;
    const price = amount > 0 ? amount : await this.rowPrice(local);
    await this.notifyUser(
      local.user_id,
      'subscription_payment_failed',
      'Payment failed',
      'We could not charge your card for Premium. Update your payment method to keep your access.',
    );
    await this.emailUser(local.user_id, (name) =>
      paymentFailedEmail({ name, invoiceUrl, billingPeriod: local.billing_period, price }),
    );
    this.subscriptionsService.clearSubscriptionCache(local.user_id);
  }

  // ───────────────────────────────────────────────────────────────────
  // Helpers
  // ───────────────────────────────────────────────────────────────────

  private async awardSubscriptionQhq(
    userId: string,
    tier: string,
    billingPeriod: string,
    reference: string,
  ): Promise<void> {
    try {
      const ruleKey = subscriptionQhqRuleKey(tier);
      if (!ruleKey) return;
      const already = await this.prisma.qhq_transactions.findFirst({
        where: { user_id: userId, type: QhqTransactionType.EARN_SUBSCRIPTION, reference_id: reference },
        select: { id: true },
      });
      if (already) return;
      const monthlyAmount = await this.qhqService.getRuleAmount(ruleKey);
      if (monthlyAmount <= 0) return;
      const multiplier = billingPeriod === 'YEARLY' ? 12 : billingPeriod === 'QUARTERLY' ? 3 : 1;
      const total = monthlyAmount * multiplier;
      await this.qhqService.earnTokens(
        userId,
        QhqTransactionType.EARN_SUBSCRIPTION,
        total,
        `Subscription payment: ${tier} (${billingPeriod})`,
        reference,
      );
      this.logger.log(`Awarded ${total} QHQ to user ${userId} for ${tier} ${billingPeriod}`);
    } catch (err: any) {
      this.logger.warn(`QHQ award failed for user ${userId}: ${err?.message}`);
    }
  }

  private async notifyUser(userId: string, type: string, title: string, message: string): Promise<void> {
    try {
      const notification = await this.notificationsService.createNotification({
        user_id: userId,
        type,
        title,
        message,
        read: false,
        metadata: null,
      });
      this.notificationsService.sendNotification(userId, title, message);
      this.appGateway.emitNotificationCount(userId, 1, notification);
    } catch (err: any) {
      this.logger.warn(`In-app notification (${type}) failed for ${userId}: ${err?.message}`);
    }
  }

  private async emailUser(
    userId: string,
    build: (name: string) => { subject: string; html: string },
  ): Promise<void> {
    try {
      const user = await this.prisma.users.findUnique({
        where: { user_id: userId },
        select: { email: true, username: true, full_name: true },
      });
      if (!user?.email) return;
      const email = build(user.full_name ?? user.username);
      await this.emailSender.send({
        to: user.email,
        subject: email.subject,
        html: email.html,
        unsubscribeUrl: `${frontendBase()}/unsubscribe`,
      });
    } catch (err: any) {
      this.logger.warn(`Email failed for ${userId}: ${err?.message}`);
    }
  }
}
