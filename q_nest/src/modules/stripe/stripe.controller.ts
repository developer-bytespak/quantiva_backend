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
import { AppGateway } from 'src/gateways/app.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { TradeFeesService } from '../trade-fees/trade-fees.service';
import { PrismaService } from '../../prisma/prisma.service';
import { QhqTokenService } from '../qhq-token/qhq-token.service';
import { QhqTransactionType } from '.prisma/client';

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
  ) {}

  @Post('create-checkout-session')
  async createCheckout(
    @Req() req: any,
  ) {

    const userId = req.subscriptionUser?.user_id;
    if (!userId) {
      throw new UnauthorizedException('User not authenticated!');
    }

    // Query DB directly instead of relying on cached tier
    const activeSubscription = await this.prisma.user_subscriptions.findFirst({
      where: { user_id: userId, status: 'active' },
    });

    // Block any non-FREE active subscription from starting a new checkout —
    // user must cancel first regardless of how they got their plan.
    if (activeSubscription && activeSubscription.tier !== 'FREE') {
      throw new BadRequestException(
        'Cancel your current subscription.',
      );
    }

    const { price_id, success_url, cancel_url, plan_id } = req.body;

    if (!price_id) {
      throw new BadRequestException('price_id is required');
    }

    // if (plan_id) {
    //   try {
    //     await this.subscriptionsService.validateDowngradeToProBeforeCheckout(
    //     userId,
    //     plan_id,
    //   );
    //   } catch (error) {
    //     throw new BadRequestException((error as Error).message);
    //   }
    // }


    // Check for pending QHQ subscription discount
    let discountPercent: number | undefined;
    const pendingDiscount = await this.qhqService.getPendingDiscount(userId);
    if (pendingDiscount) {
      discountPercent = pendingDiscount.discount_percent;
    }

    const session = await this.stripeService.createCheckoutSession({
      priceId: price_id,
      successUrl: success_url,
      cancelUrl: cancel_url,
      clientReferenceId: userId,
      metadata: {
        ...(plan_id ? { plan_id } : {}),
        ...(pendingDiscount ? { qhq_discount_id: pendingDiscount.id } : {}),
      },
      discountPercent,
    });
    return { url: session.url, sessionId: session.id };
  }

  @Post('subscription/cancel')
  async cancelSubscription(@Req() req: any) {
    const userId = req.subscriptionUser?.user_id;
    if (!userId) {
      throw new UnauthorizedException('User not authenticated');
    }

    // Query DB directly instead of relying on cached tier
    const active = await this.prisma.user_subscriptions.findFirst({
      where: { user_id: userId, status: 'active' },
      include: { plan: true },
    });

    if (!active || active.tier === 'FREE') {
      throw new BadRequestException('You are already on the FREE tier');
    }

    let updated;
    if (active.billing_provider === 'admin_override') {
      // Comp plan granted by super-admin — no Stripe subscription to cancel,
      // no trade-fee billing path. Just downgrade locally to FREE.
      updated = await this.subscriptionsService.handleAdminOverrideSubscriptionCancelled(
        active.subscription_id,
      );
    } else if (active.billing_provider === 'stripe' && active.external_id) {
      await this.stripeService.cancelSubscriptionImmediately(active.external_id);

      // Bill any accumulated trade fees BEFORE completing cancellation
      try {
        await this.tradeFeesService.processCancellationFees(userId);
      } catch (err: any) {
        this.logger.warn(`Trade-fee cancellation billing failed (non-blocking): ${err.message}`);
      }

      updated = await this.subscriptionsService.handleStripeSubscriptionCancelled(
        active.external_id,
        new Date(),
      );
    } else {
      throw new BadRequestException('No active subscription to cancel');
    }

    if (!updated) {
      throw new BadRequestException('Failed to cancel subscription');
    }

    const notification = await this.notificationsService.createNotification({user_id: userId, type: "subscription_cancelled",title:"Subscription Cancelled",message:"Your subscription has been cancelled",read:false,metadata:null});
    this.notificationsService.sendNotification(userId, "Subscription Cancelled", "Your subscription has been cancelled");
    this.appGateway.emitNotificationCount(userId, 1, notification); // notification count increment by 1



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

    // console.log("RAW BODY", rawBody);

    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    // Webhook secret loaded from env (never log secrets)
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


    if (event.type === 'checkout.session.completed') {
      this.logger.log('checkout.session.completed received');
      this.logger.log('checkout.session.completed received');
      const session = event.data.object as Stripe.Checkout.Session;

      const userId = session.client_reference_id;
      const planId = session.metadata?.plan_id;

      // ── Save Stripe Customer ID so trade-fee invoices reuse the same
      //    customer (which already has the card on file) ──────────────
      const stripeCustomerId =
        typeof session.customer === 'string'
          ? session.customer
          : session.customer?.id ?? null;

      if (userId && stripeCustomerId) {
        await this.prisma.users.update({
          where: { user_id: userId },
          data: { stripe_customer_id: stripeCustomerId },
        }).catch((err) =>
          this.logger.warn(`Failed to save stripe_customer_id: ${err.message}`),
        );
      }

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

            this.logger.log(
              `Subscription updated for user ${userId}, plan ${planId} and payment recorded`,
            );
          } else {
            // User has no current subscription — create new subscription and update all related tables
            const newSubscription = await this.subscriptionsService.createSubscription({
              user_id: userId,
              plan_id: planId,
              status: 'active',
              billing_provider: 'stripe',
              external_id: externalId,
              auto_renew: true,
            });

            // Payment history entry for new subscription
            await this.subscriptionsService.recordPayment({
              subscription_id: newSubscription.subscription_id,
              user_id: newSubscription.user_id,
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
              `New subscription created for user ${userId}, plan ${planId}; user_subscriptions, users, subscription_usage, and payment_history updated`,
            );
          }
          // ── Award QHQ tokens for subscription payment ──
          const sub = await this.prisma.user_subscriptions.findFirst({
            where: { user_id: userId, status: 'active' },
          });
          if (sub) {
            const ruleKey = sub.tier === 'ELITE' ? 'MONTHLY_ELITE' : sub.tier === 'PRO' ? 'MONTHLY_PRO' : null;
            if (ruleKey) {
              const monthlyAmount = await this.qhqService.getRuleAmount(ruleKey);
              if (monthlyAmount > 0) {
                const multiplier = sub.billing_period === 'YEARLY' ? 12 : sub.billing_period === 'QUARTERLY' ? 3 : 1;
                const totalAmount = monthlyAmount * multiplier;
                await this.qhqService.earnTokens(
                  userId,
                  QhqTransactionType.EARN_SUBSCRIPTION,
                  totalAmount,
                  `Subscription payment: ${sub.tier} (${sub.billing_period})`,
                  session.id,
                );
                this.logger.log(`Awarded ${totalAmount} QHQ to user ${userId} for ${sub.tier} ${sub.billing_period}`);
              }
            }
          }

          // Mark QHQ discount as applied if one was used
          const qhqDiscountId = session.metadata?.qhq_discount_id;
          if (qhqDiscountId) {
            await this.prisma.qhq_subscription_discounts.update({
              where: { id: qhqDiscountId },
              data: { applied: true },
            }).catch((err) => this.logger.warn(`Failed to mark QHQ discount as applied: ${err.message}`));
            this.logger.log(`QHQ discount ${qhqDiscountId} marked as applied for user ${userId}`);
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

    // ───────────────────────────────────────────────────────────────
    // Recurring subscription renewals.
    //
    // Stripe fires `invoice.paid` in multiple scenarios:
    //   - billing_reason: 'subscription_create'  → first invoice (also covered
    //     by checkout.session.completed above; ignore here to avoid duplicate
    //     payment_history rows / duplicate commission accrual)
    //   - billing_reason: 'subscription_cycle'   → recurring renewal — this is
    //     what we want
    //   - billing_reason: 'subscription_update'  → mid-cycle proration
    //   - billing_reason: 'manual'               → admin-created
    //
    // For now we only handle the 'subscription_cycle' renewal case. The
    // affiliate commission engine is wired into recordPayment, so accrual
    // (and the recurring_months_cap) happen automatically.
    //
    // Idempotency: external_payment_id is set to the Stripe invoice.id, and
    // affiliate_commission_events has @@unique(event_type, source_reference),
    // so a webhook replay is safe end-to-end.
    if (event.type === 'invoice.paid') {
      const invoice: any = event.data.object;
      const billingReason: string | undefined = invoice?.billing_reason;
      if (billingReason !== 'subscription_cycle') {
        return { received: true };
      }

      const stripeSubscriptionId: string | undefined = invoice?.subscription;
      const amountPaidCents: number = Number(invoice?.amount_paid ?? 0);
      const currency: string = (invoice?.currency || 'usd').toUpperCase();
      const amount = amountPaidCents / 100;

      if (!stripeSubscriptionId || amount <= 0) {
        return { received: true };
      }

      try {
        const userSubscription =
          await this.prisma.user_subscriptions.findFirst({
            where: {
              external_id: stripeSubscriptionId,
              billing_provider: 'stripe',
            },
            select: { subscription_id: true, user_id: true },
          });

        if (!userSubscription) {
          this.logger.warn(
            `invoice.paid for unknown stripe subscription ${stripeSubscriptionId}; skipping`,
          );
          return { received: true };
        }

        const receiptUrl: string | undefined =
          invoice?.charge?.receipt_url ?? undefined;

        await this.subscriptionsService.recordPayment({
          subscription_id: userSubscription.subscription_id,
          user_id: userSubscription.user_id,
          amount,
          currency,
          status: 'succeeded',
          payment_provider: 'stripe',
          external_payment_id: invoice.id,
          payment_method: 'stripe',
          invoice_url: invoice.hosted_invoice_url || null,
          receipt_url: receiptUrl || null,
          failure_reason: null,
        });

        this.logger.log(
          `Renewal payment recorded for subscription ${userSubscription.subscription_id}: $${amount} ${currency}`,
        );
      } catch (err: any) {
        this.logger.error(
          `Failed to record renewal for ${stripeSubscriptionId}: ${err?.message}`,
        );
        // Swallow — return 200 so Stripe doesn't retry indefinitely. Logged
        // for manual recovery.
      }
    }

    return { received: true };
  }
}
