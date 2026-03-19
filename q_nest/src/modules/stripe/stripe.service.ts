import Stripe from 'stripe';
import { Injectable } from '@nestjs/common';

@Injectable()
export class StripeService {
  private stripe: Stripe;

  constructor() {
    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) {
      throw new Error('STRIPE_SECRET_KEY is required');
    }
    this.stripe = new Stripe(secret, {
      apiVersion: '2026-01-28.clover',
    });
  }

  async createCheckoutSession(params: {
    priceId: string;
    successUrl?: string;
    cancelUrl?: string;
    clientReferenceId?: string;
    metadata?: Record<string, string>;
  }) {
    try {
      console.log('PARAMS', params);

      const session = await this.stripe.checkout.sessions.create({
        mode: 'subscription',
        payment_method_types: ['card'],
        line_items: [
          {
            price: params.priceId,
            quantity: 1,
          },
        ],
        success_url: params.successUrl || 'http://localhost:3001/success',
        cancel_url: params.cancelUrl || 'http://localhost:3001/cancel',
        ...(params.clientReferenceId && { client_reference_id: params.clientReferenceId }),
        metadata: params.metadata,
      });

      console.log('DONE', session);
      return session;
    } catch (error) {
      console.error('STRIPE ERROR ❌', error);
      throw error;
    }
  }

  async retrieveInvoice(invoiceId: string) {
    return this.stripe.invoices.retrieve(invoiceId);
  }

  async retrievePaymentIntent(paymentIntentId: string) {
    return this.stripe.paymentIntents.retrieve(paymentIntentId);
  }

  constructWebhookEvent(
    payload: Buffer | string,
    signature: string,
    webhookSecret: string,
  ): Stripe.Event {
    return this.stripe.webhooks.constructEvent(payload, signature, webhookSecret);
  }

  async cancelSubscriptionAtPeriodEnd(stripeSubscriptionId: string) {
    return this.stripe.subscriptions.update(stripeSubscriptionId, {
      cancel_at_period_end: true,
    });
  }

  /** Cancel subscription immediately (no schedule for period end). */
  async cancelSubscriptionImmediately(stripeSubscriptionId: string) {
    return this.stripe.subscriptions.cancel(stripeSubscriptionId);
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
