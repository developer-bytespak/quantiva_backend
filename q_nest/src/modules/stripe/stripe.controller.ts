import {
  Controller,
  Post,
  Body,
  Req,
  Headers,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { Request } from 'express';
import { StripeService } from './stripe.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import Stripe from 'stripe';

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

@Controller('stripe')
export class StripeController {
  private readonly logger = new Logger(StripeController.name);

  constructor(
    private readonly stripeService: StripeService,
    private readonly subscriptionsService: SubscriptionsService,
  ) {}

  @Post('create-checkout-session')
  async createCheckout(
    @Req() req: any,
  ) {

    
    const { price_id, success_url, cancel_url, plan_id } = req.body;

    // console.log("BODY:", req.body);  
    if (!price_id) {
      throw new BadRequestException('price_id is required');
    }
    const userId = req.subscriptionUser?.user_id;
    if (!userId) {
      throw new UnauthorizedException('User not authenticated');
    }

    if (plan_id) {
      try {
        await this.subscriptionsService.validateDowngradeToProBeforeCheckout(
        userId,
        plan_id,
      );
      } catch (error) {
        throw new BadRequestException((error as Error).message);
      }
    }

    console.log('userId', userId + ' - ' + price_id + ' - ' + plan_id + ' - ' + success_url + ' - ' + cancel_url);

    const session = await this.stripeService.createCheckoutSession({
      priceId: price_id,
      successUrl: success_url,
      cancelUrl: cancel_url,
      clientReferenceId: userId,
      metadata: plan_id ? { plan_id: plan_id } : undefined,
    });
    console.log("Sessions",session)
    return { url: session.url, sessionId: session.id };
  }

  @Post('subscription/cancel')
  async cancelSubscription(@Req() req: any) {
    const userId = req.subscriptionUser?.user_id;
    if (!userId) {
      throw new UnauthorizedException('User not authenticated');
    }

    const active = await this.subscriptionsService.getActiveSubscriptionWithFeatures(
      userId,
    );

    if (!active || active.billing_provider !== 'stripe' || !active.external_id) {
      throw new BadRequestException('No active Stripe subscription to cancel');
    }

    const stripeSub: any = await this.stripeService.cancelSubscriptionAtPeriodEnd(
      active.external_id,
    );

    const currentPeriodEndUnix: number | null = stripeSub.current_period_end ?? null;
    const currentPeriodEnd = currentPeriodEndUnix
      ? new Date(currentPeriodEndUnix * 1000)
      : null;

    const updated = await this.subscriptionsService.cancelUserSubscription(userId, {
      subscriptionId: active.subscription_id,
      stripeCurrentPeriodEnd: currentPeriodEnd,
      stripeSubscriptionId: active.external_id,
    });

    return {
      subscription_id: updated.subscription_id,
      status: updated.status,
      current_period_end: updated.current_period_end,
      expires_at: updated.expires_at,
      auto_renew: updated.auto_renew,
    };
  }

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @Req() req: RawBodyRequest,
    @Headers('stripe-signature') signature: string,
  ) {
    const rawBody = req.rawBody;
    if (!rawBody) {
      this.logger.error('Raw body not available — ensure json({ verify }) middleware is configured in main.ts');
      throw new UnauthorizedException('Webhook signature verification failed');
    }

    console.log("RAW BODY", rawBody);

    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    console.log("WEBHOOK SECRET", webhookSecret);
    if (!webhookSecret) {
      this.logger.error('STRIPE_WEBHOOK_SECRET is not set');
      throw new UnauthorizedException('Webhook not configured');
    }

    let event: Stripe.Event;
    try {
      event = this.stripeService.constructWebhookEvent(rawBody, signature, webhookSecret);
    } catch (err: any) {
      console.log("ERROR--s", err);
      this.logger.warn(`Stripe webhook signature verification failed: ${err?.message}`);
      throw new UnauthorizedException('Invalid webhook signature');
    }


    if (event.type === 'checkout.session.completed') {
      console.log("CHECKOUT.SESSION.COMPLETED");
      const session = event.data.object as Stripe.Checkout.Session;
      console.log("SESSION--s", session.client_reference_id);
      console.log("SESSION--m", session.metadata);

      const userId = session.client_reference_id;
      const planId = session.metadata?.plan_id;
      console.log("Plan ID", planId);

      const externalId =
        typeof session.subscription === 'string'
          ? session.subscription
          : session.subscription?.id ?? undefined;

      // Amounts from Stripe are in the smallest currency unit (e.g. cents)
      const amount =
        typeof session.amount_total === 'number'
          ? session.amount_total / 100
          : 0;
      const currency = session.currency?.toUpperCase() || 'USD';
      const paymentMethod =
        (Array.isArray(session.payment_method_types) &&
          session.payment_method_types[0]) ||
        undefined;

      // Try to resolve invoice_url and receipt_url
      let invoiceUrl: string | undefined;
      let receiptUrl: string | undefined;

      try {
        if (session.invoice && typeof session.invoice === 'string') {
          const invoice: any = await this.stripeService.retrieveInvoice(session.invoice);
          invoiceUrl = invoice.hosted_invoice_url || undefined;

          const charge = invoice.charge as any;
          if (charge && charge.receipt_url) {
            receiptUrl = charge.receipt_url;
          }
        }

        if (!receiptUrl && session.payment_intent && typeof session.payment_intent === 'string') {
          const pi: any = await this.stripeService.retrievePaymentIntent(session.payment_intent);
          const firstCharge = pi.charges?.data?.[0];
          if (firstCharge && firstCharge.receipt_url) {
            receiptUrl = firstCharge.receipt_url;
          }
        }
      } catch (metaErr) {
        this.logger.warn(`Failed to fetch invoice/receipt URLs from Stripe: ${(metaErr as any)?.message}`);
      }

      if (userId && planId) {
        try {
          const existing = await this.subscriptionsService.getActiveSubscriptionWithFeatures(
            userId,
          );

          if (existing) {
            const updated = await this.subscriptionsService.updateSubscription(
              existing.subscription_id,
              {
                status: 'active',
                auto_renew: true,
                plan_id: planId,
                billing_provider: 'stripe',
                external_id: externalId,
              },
            );

            // Payment history entry for subscription update
            await this.subscriptionsService.recordPayment({
              subscription_id: updated.subscription_id,
              user_id: updated.user_id,
              amount,
              currency,
              status: 'succeeded',
              payment_provider: 'stripe',
              external_payment_id: externalId || session.id,
              payment_method: paymentMethod,
              invoice_url: invoiceUrl || null,
              receipt_url: receiptUrl || null,
              failure_reason: null,
            });

            console.log("EXISTING", existing);
            this.logger.log(
              `Subscription updated for user ${userId}, plan ${planId} and payment recorded`,
            );
          } else {
            const created = await this.subscriptionsService.createSubscription({
              user_id: userId,
              plan_id: planId,
              status: 'active',
              external_id: externalId,
              billing_provider: 'stripe',
            });

            // Payment history entry for new subscription
            await this.subscriptionsService.recordPayment({
              subscription_id: created.subscription_id,
              user_id: created.user_id,
              amount,
              currency,
              status: 'succeeded',
              payment_provider: 'stripe',
              external_payment_id: externalId || session.id,
              payment_method: paymentMethod,
              invoice_url: invoiceUrl || null,
              receipt_url: receiptUrl || null,
              failure_reason: null,
            });

            this.logger.log(
              `Subscription created for user ${userId}, plan ${planId} and payment recorded`,
            );
          }
        } catch (err: any) {
          this.logger.error(
            `Failed to create/update subscription or record payment for user ${userId}: ${err?.message}`,
          );
          // Still return 200 so Stripe doesn't retry; log for manual fix
        }
      } else {
        this.logger.warn(
          `checkout.session.completed missing userId or plan_id: client_reference_id=${userId}, metadata.plan_id=${planId}`,
        );
      }
    }

    if (
      event.type === 'customer.subscription.updated' ||
      event.type === 'customer.subscription.deleted'
    ) {
      const subscription: any = event.data.object;
      const stripeSubscriptionId: string = subscription.id;
      const stripeStatus: string | undefined = subscription.status;

      const currentPeriodEndUnix: number | null =
        subscription.current_period_end ?? null;
      const currentPeriodEnd = currentPeriodEndUnix
        ? new Date(currentPeriodEndUnix * 1000)
        : null;

      if (
        event.type === 'customer.subscription.deleted' ||
        stripeStatus === 'canceled'
      ) {
        try {
          await this.subscriptionsService.handleStripeSubscriptionCancelled(
            stripeSubscriptionId,
            currentPeriodEnd,
          );
        } catch (err: any) {
          this.logger.error(
            `Failed to handle Stripe subscription cancel for ${stripeSubscriptionId}: ${err?.message}`,
          );
        }
      }
    }

    return { received: true };
  }
}
