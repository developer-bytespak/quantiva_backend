import Stripe from 'stripe';
import { Injectable, Logger } from '@nestjs/common';
import { PREMIUM_BILLING_PERIODS, PremiumBillingPeriod } from '../../common/tiers';

/** Days of free Premium access for first-time subscribers (all billing periods). */
export const PREMIUM_TRIAL_DAYS = Number(process.env.PREMIUM_TRIAL_DAYS || 7);

/** Env var holding the Stripe Price id for each Premium billing period. */
const PREMIUM_PRICE_ENV: Record<PremiumBillingPeriod, string> = {
  MONTHLY: 'STRIPE_PREMIUM_PRICE_ID',
  QUARTERLY: 'STRIPE_PREMIUM_PRICE_ID_QUARTERLY',
  YEARLY: 'STRIPE_PREMIUM_PRICE_ID_YEARLY',
};

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private stripe: Stripe;

  constructor() {
    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) {
      throw new Error('STRIPE_SECRET_KEY is required');
    }
    this.stripe = new Stripe(secret, {
      apiVersion: '2026-02-25.clover' as any,
    });
    for (const period of PREMIUM_BILLING_PERIODS) {
      if (!process.env[PREMIUM_PRICE_ENV[period]]) {
        this.logger.warn(
          `${PREMIUM_PRICE_ENV[period]} is not set; Premium ${period} checkout will fail until it is configured`,
        );
      }
    }
  }

  /** Stripe Price id of the Premium plan for a billing period (test or live, per environment). */
  premiumPriceIdFor(period: PremiumBillingPeriod): string {
    const envName = PREMIUM_PRICE_ENV[period];
    const id = process.env[envName];
    if (!id) {
      throw new Error(`${envName} is not configured`);
    }
    return id;
  }

  /** @deprecated monthly price id; prefer premiumPriceIdFor(period). */
  get premiumPriceId(): string {
    return this.premiumPriceIdFor('MONTHLY');
  }

  /** Configured Premium price ids -> billing period (only the ones present in env). */
  premiumPriceMap(): Record<string, PremiumBillingPeriod> {
    const map: Record<string, PremiumBillingPeriod> = {};
    for (const period of PREMIUM_BILLING_PERIODS) {
      const id = process.env[PREMIUM_PRICE_ENV[period]];
      if (id) map[id] = period;
    }
    return map;
  }

  periodForPriceId(priceId: string | null | undefined): PremiumBillingPeriod | null {
    if (!priceId) return null;
    return this.premiumPriceMap()[priceId] ?? null;
  }

  /**
   * Subscription-mode Checkout. When `trialDays` > 0 the card is still collected
   * up front (payment_method_collection: 'always') and Stripe charges the first
   * invoice automatically when the trial ends; a trial with no card on file is
   * cancelled rather than converted.
   */
  async createCheckoutSession(params: {
    priceId: string;
    successUrl?: string;
    cancelUrl?: string;
    clientReferenceId?: string;
    customerId?: string | null;
    customerEmail?: string | null;
    metadata?: Record<string, string>;
    discountPercent?: number;
    trialDays?: number;
  }) {
    try {
      // If QHQ discount is available, create a one-time Stripe coupon
      let discounts: Stripe.Checkout.SessionCreateParams.Discount[] | undefined;
      if (params.discountPercent && params.discountPercent > 0) {
        const coupon = await this.stripe.coupons.create({
          percent_off: params.discountPercent,
          duration: 'once',
          name: `QHQ ${params.discountPercent}% Discount`,
        });
        discounts = [{ coupon: coupon.id }];
      }

      const trialDays = params.trialDays && params.trialDays > 0 ? Math.floor(params.trialDays) : 0;

      const subscriptionData: Stripe.Checkout.SessionCreateParams.SubscriptionData = {
        metadata: params.metadata,
        ...(trialDays > 0
          ? {
              trial_period_days: trialDays,
              trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
            }
          : {}),
      };

      const session = await this.stripe.checkout.sessions.create({
        mode: 'subscription',
        payment_method_types: ['card'],
        payment_method_collection: 'always',
        line_items: [{ price: params.priceId, quantity: 1 }],
        success_url: params.successUrl || `${process.env.FRONTEND_URL}/success`,
        cancel_url: params.cancelUrl || `${process.env.FRONTEND_URL}/cancel`,
        ...(params.clientReferenceId && { client_reference_id: params.clientReferenceId }),
        // `customer` and `customer_email` are mutually exclusive in Checkout.
        ...(params.customerId
          ? { customer: params.customerId }
          : params.customerEmail
            ? { customer_email: params.customerEmail }
            : {}),
        ...(discounts && { discounts }),
        subscription_data: subscriptionData,
        metadata: params.metadata,
      });

      return session;
    } catch (error) {
      this.logger.error(`Stripe checkout session creation failed: ${(error as any)?.message}`);
      throw error;
    }
  }

  async retrieveInvoice(invoiceId: string) {
    return this.stripe.invoices.retrieve(invoiceId);
  }

  async retrievePaymentIntent(paymentIntentId: string) {
    return this.stripe.paymentIntents.retrieve(paymentIntentId);
  }

  /** Always fetch the latest subscription state before syncing (webhooks can arrive out of order). */
  async retrieveSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
    return this.stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['items.data.price'],
    });
  }

  constructWebhookEvent(
    payload: Buffer | string,
    signature: string,
    webhookSecret: string,
  ): Stripe.Event {
    return this.stripe.webhooks.constructEvent(payload, signature, webhookSecret);
  }

  /** Stop renewal; access continues until the current period (or trial) ends. */
  async cancelSubscriptionAtPeriodEnd(stripeSubscriptionId: string) {
    return this.stripe.subscriptions.update(stripeSubscriptionId, {
      cancel_at_period_end: true,
    });
  }

  /** Undo a pending cancel-at-period-end. */
  async resumeSubscription(stripeSubscriptionId: string) {
    return this.stripe.subscriptions.update(stripeSubscriptionId, {
      cancel_at_period_end: false,
    });
  }

  /** Cancel subscription immediately (no schedule for period end). */
  async cancelSubscriptionImmediately(stripeSubscriptionId: string) {
    return this.stripe.subscriptions.cancel(stripeSubscriptionId);
  }

  // ─── Legacy -> Premium price switch (one-off migration) ────────────────

  /**
   * Dry-run helper: what would the next invoice look like if this subscription
   * moved to `priceId` with no proration? Nothing is written.
   */
  async previewPriceSwitch(stripeSubscriptionId: string, priceId: string) {
    const sub: any = await this.retrieveSubscription(stripeSubscriptionId);
    const item = sub.items?.data?.[0];
    const currentPriceId: string | undefined = item?.price?.id;
    const periodEnd = this.getPeriodEnd(sub);
    if (!item || currentPriceId === priceId) {
      return {
        status: sub.status as string,
        current_price_id: currentPriceId ?? null,
        already_on_price: currentPriceId === priceId,
        period_end: periodEnd,
        next_invoice_amount: null as number | null,
        next_invoice_date: periodEnd,
      };
    }
    let nextAmount: number | null = null;
    let nextDate: Date | null = periodEnd;
    try {
      const preview: any = await this.stripe.invoices.createPreview({
        subscription: stripeSubscriptionId,
        subscription_details: {
          items: [{ id: item.id, price: priceId }],
          proration_behavior: 'none',
        },
      });
      nextAmount = typeof preview.amount_due === 'number' ? preview.amount_due / 100 : null;
      const due = preview.next_payment_attempt ?? preview.period_end;
      nextDate = typeof due === 'number' ? new Date(due * 1000) : periodEnd;
    } catch (err: any) {
      this.logger.warn(`Invoice preview failed for ${stripeSubscriptionId}: ${err?.message}`);
    }
    return {
      status: sub.status as string,
      current_price_id: currentPriceId ?? null,
      already_on_price: false,
      period_end: periodEnd,
      next_invoice_amount: nextAmount,
      next_invoice_date: nextDate,
    };
  }

  /**
   * Move a live subscription to `priceId` with NO proration and no change to
   * the billing anchor: nothing is charged now and the new price bills at the
   * existing period end. Returns false when already on that price.
   */
  async switchSubscriptionPrice(stripeSubscriptionId: string, priceId: string) {
    const sub: any = await this.retrieveSubscription(stripeSubscriptionId);
    const item = sub.items?.data?.[0];
    if (!item) {
      throw new Error(`Stripe subscription ${stripeSubscriptionId} has no items`);
    }
    if (item.price?.id === priceId) {
      return { changed: false, subscription: sub as Stripe.Subscription };
    }
    if (!['active', 'trialing', 'past_due'].includes(sub.status)) {
      throw new Error(`Stripe subscription ${stripeSubscriptionId} is ${sub.status}; not switching price`);
    }
    const updated = await this.stripe.subscriptions.update(stripeSubscriptionId, {
      items: [{ id: item.id, price: priceId }],
      proration_behavior: 'none',
      metadata: { ...(sub.metadata ?? {}), migrated_to_premium: new Date().toISOString() },
    });
    return { changed: true, subscription: updated };
  }

  // ─── Shape helpers (API 2025-03 "Basil" and later moved several fields) ───

  /** `invoice.subscription` moved to `invoice.parent.subscription_details.subscription`. */
  getSubscriptionIdFromInvoice(invoice: any): string | null {
    const fromParent = invoice?.parent?.subscription_details?.subscription;
    const raw = fromParent ?? invoice?.subscription ?? null;
    if (!raw) return null;
    return typeof raw === 'string' ? raw : raw.id ?? null;
  }

  /** `current_period_end` moved from the subscription to its items. */
  getPeriodEnd(sub: any): Date | null {
    const unix = sub?.items?.data?.[0]?.current_period_end ?? sub?.current_period_end ?? null;
    return typeof unix === 'number' ? new Date(unix * 1000) : null;
  }

  getPeriodStart(sub: any): Date | null {
    const unix = sub?.items?.data?.[0]?.current_period_start ?? sub?.current_period_start ?? null;
    return typeof unix === 'number' ? new Date(unix * 1000) : null;
  }

  // ─── Trade-fee billing helpers ────────────────────────────────────

  /** Create or retrieve a Stripe customer for fee billing. */
  async createCustomer(email: string, userId: string) {
    return this.stripe.customers.create({
      email,
      metadata: { quantiva_user_id: userId },
    });
  }

  /** Create a one-off invoice item on a customer's next invoice. */
  async createInvoiceItem(params: {
    customerId: string;
    amountCents: number;
    description: string;
    metadata?: Record<string, string>;
  }) {
    return this.stripe.invoiceItems.create({
      customer: params.customerId,
      amount: params.amountCents,
      currency: 'usd',
      description: params.description,
      metadata: params.metadata,
    });
  }

  /** Create a new invoice, finalize it, and optionally auto-collect. */
  async createAndFinalizeInvoice(params: {
    customerId: string;
    autoAdvance?: boolean;
    metadata?: Record<string, string>;
  }) {
    const invoice = await this.stripe.invoices.create({
      customer: params.customerId,
      auto_advance: params.autoAdvance ?? true,
      collection_method: 'charge_automatically',
      metadata: params.metadata,
    });

    return this.stripe.invoices.finalizeInvoice(invoice.id);
  }

  /** Attempt to pay an existing open/draft invoice. */
  async payInvoice(invoiceId: string) {
    return this.stripe.invoices.pay(invoiceId);
  }
}
