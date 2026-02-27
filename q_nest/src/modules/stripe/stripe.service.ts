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
}
