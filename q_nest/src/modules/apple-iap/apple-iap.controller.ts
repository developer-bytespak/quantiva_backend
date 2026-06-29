import {
  Controller,
  Post,
  Body,
  Req,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { PlanTier, QhqTransactionType } from '.prisma/client';
import { NotificationTypeV2 } from '@apple/app-store-server-library';
import { AppleIapService } from './apple-iap.service';
import { mapAppleProductId } from './apple-product-map';
import { VerifyApplePurchaseDto } from './dto/verify-purchase.dto';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AppGateway } from 'src/gateways/app.gateway';
import { QhqTokenService } from '../qhq-token/qhq-token.service';

@Controller()
export class AppleIapController {
  private readonly logger = new Logger(AppleIapController.name);

  constructor(
    private readonly appleIap: AppleIapService,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly appGateway: AppGateway,
    private readonly qhqService: QhqTokenService,
  ) {}

  // ──────────────────────────────────────────────────────────────────────
  // 1. POST /subscriptions/apple/verify  — called after a StoreKit purchase
  // ──────────────────────────────────────────────────────────────────────
  @Post('subscriptions/apple/verify')
  async verify(@Req() req: any, @Body() dto: VerifyApplePurchaseDto) {
    const userId = req.subscriptionUser?.user_id;
    if (!userId) {
      throw new UnauthorizedException('User not authenticated');
    }
    return this.processPurchase(userId, dto, false);
  }

  // ──────────────────────────────────────────────────────────────────────
  // 2. POST /subscriptions/apple/restore  — "Restore Purchases"
  // ──────────────────────────────────────────────────────────────────────
  @Post('subscriptions/apple/restore')
  async restore(@Req() req: any, @Body() dto: VerifyApplePurchaseDto) {
    const userId = req.subscriptionUser?.user_id;
    if (!userId) {
      throw new UnauthorizedException('User not authenticated');
    }
    return this.processPurchase(userId, dto, true);
  }

  /**
   * Shared verify/restore flow. Verifies the transaction with Apple, enforces
   * the dedup + cross-provider-overlap guards, then links the subscription to
   * the same user_subscriptions row Stripe uses.
   */
  private async processPurchase(
    userId: string,
    dto: VerifyApplePurchaseDto,
    isRestore: boolean,
  ) {
    if (!this.appleIap.isConfigured()) {
      throw new BadRequestException('Apple purchases are not enabled on this server');
    }

    // 1. Verify the transaction against the App Store Server API (authoritative).
    let verified;
    try {
      verified = await this.appleIap.verifyTransaction(dto.transactionId);
    } catch (err: any) {
      this.logger.warn(`Apple transaction verification failed for user ${userId}: ${err?.message}`);
      throw new BadRequestException('Could not verify Apple transaction');
    }

    const tx = verified.transaction;
    const originalTransactionId = tx.originalTransactionId;
    const productId = tx.productId;

    if (!originalTransactionId || !productId) {
      throw new BadRequestException('Apple transaction is missing required fields');
    }

    // 2. Map the (verified) product id to an internal plan.
    const mapping = mapAppleProductId(productId);
    if (!mapping) {
      throw new BadRequestException(`Unknown Apple product: ${productId}`);
    }

    const plan = await this.prisma.subscription_plans.findFirst({
      where: { tier: mapping.tier, billing_period: mapping.billingPeriod },
    });
    if (!plan) {
      this.logger.error(
        `No subscription_plans row for ${mapping.tier}/${mapping.billingPeriod} (Apple product ${productId})`,
      );
      throw new BadRequestException('Subscription plan not configured');
    }

    // 3. Revocation / expiry sanity check.
    if (tx.revocationDate) {
      throw new BadRequestException('This Apple transaction has been refunded or revoked');
    }
    const expiresDate = tx.expiresDate ? new Date(tx.expiresDate) : null;
    if (!expiresDate || expiresDate.getTime() <= Date.now()) {
      throw new BadRequestException('This Apple subscription is not active');
    }

    // 4. Dedup / account-sharing guard. Each Apple originalTransactionId links
    //    to exactly one Quantiva user (first to link wins).
    const linked = await this.subscriptionsService.findAppleSubscription(originalTransactionId);
    if (linked && linked.user_id !== userId) {
      throw new ConflictException(
        'This Apple subscription is already linked to another account',
      );
    }

    // If it's already linked to THIS user with the SAME product, treat as a
    // refresh (the expected path for restore, and idempotent for a repeated
    // verify). A *different* product on the same originalTransactionId means an
    // in-group upgrade/crossgrade (e.g. Pro → Elite) — Apple keeps the same
    // originalTransactionId across that change, so fall through to update the
    // tier instead of only bumping the expiry.
    if (linked && linked.user_id === userId && linked.plan_id === plan.plan_id) {
      const refreshed = await this.subscriptionsService.applyAppleRenewal(
        originalTransactionId,
        expiresDate,
      );
      return this.buildResponse(refreshed ?? linked, true);
    }

    // 5. Cross-provider overlap guard. When a user buys another plan in the same
    //    Apple subscription group, Apple AUTOMATICALLY cancels the prior plan and
    //    pro-rates a refund — so an existing Apple subscription is fine to replace
    //    in place, and an in-group upgrade keeps the same originalTransactionId
    //    (handled above / via the linked row below). Only a web/Stripe
    //    subscription must be cancelled by the user first; Apple cannot touch it.
    //    Skip the guard entirely when this Apple transaction is already linked to
    //    the user (the upgrade path).
    if (!linked) {
      const activeStripeSub = await this.prisma.user_subscriptions.findFirst({
        where: { user_id: userId, status: 'active', billing_provider: 'stripe' },
      });
      if (activeStripeSub && activeStripeSub.tier !== PlanTier.FREE) {
        throw new BadRequestException(
          'Please cancel your existing subscription on web first',
        );
      }
    }

    // 6. Create or update the subscription (mirrors the Stripe webhook). Prefer
    //    the Apple-linked row when it exists (in-group upgrade), otherwise the
    //    user's current active subscription (e.g. a different-group Apple sub that
    //    Apple already cancelled, or an existing FREE row), else create a new one.
    const existing =
      linked ?? (await this.subscriptionsService.getActiveSubscriptionWithFeatures(userId));
    let subscription;
    if (existing) {
      subscription = await this.subscriptionsService.updateSubscription(existing.subscription_id, {
        status: 'active',
        auto_renew: true,
        plan_id: plan.plan_id,
        billing_provider: 'apple',
        external_id: originalTransactionId,
      });
    } else {
      subscription = await this.subscriptionsService.createSubscription({
        user_id: userId,
        plan_id: plan.plan_id,
        status: 'active',
        billing_provider: 'apple',
        external_id: originalTransactionId,
        auto_renew: true,
      });
    }

    // 7. Sync the exact Apple expiry onto the row (Apple is the source of truth
    //    for the period end, not our locally-computed date).
    const synced = await this.subscriptionsService.applyAppleRenewal(
      originalTransactionId,
      expiresDate,
    );
    const finalSub = synced ?? subscription;

    // 8. Record the payment. Prefer Apple's actual charged amount (App Store
    //    Connect prices differ from our Stripe/DB prices), falling back to the
    //    plan price if Apple didn't include one.
    const { amount, currency } = this.resolveTxAmount(tx, plan.price);
    try {
      await this.subscriptionsService.recordPayment({
        subscription_id: finalSub.subscription_id,
        user_id: userId,
        amount,
        currency,
        status: 'succeeded',
        payment_provider: 'apple',
        external_payment_id: tx.transactionId || dto.transactionId,
        payment_method: 'apple_iap',
        invoice_url: null,
        receipt_url: null,
        failure_reason: null,
      });
    } catch (err: any) {
      this.logger.error(`Failed to record Apple payment for user ${userId}: ${err?.message}`);
    }

    // 9. Award QHQ tokens (parity with the Stripe flow). Non-blocking.
    if (!isRestore) {
      await this.awardQhqTokens(userId, finalSub.tier, finalSub.billing_period, tx.transactionId);
    }

    // 10. Notify the user (parity with Stripe).
    try {
      const notification = await this.notificationsService.createNotification({
        user_id: userId,
        type: 'subscription_active',
        title: 'Subscription Active',
        message: `Your ${finalSub.tier} subscription is now active`,
        read: false,
        metadata: null,
      });
      this.notificationsService.sendNotification(
        userId,
        'Subscription Active',
        `Your ${finalSub.tier} subscription is now active`,
      );
      this.appGateway.emitNotificationCount(userId, 1, notification);
    } catch (err: any) {
      this.logger.warn(`Apple purchase notification failed for user ${userId}: ${err?.message}`);
    }

    return this.buildResponse(finalSub, false);
  }

  private buildResponse(sub: any, restored: boolean) {
    return {
      success: true,
      restored,
      tier: sub.tier,
      billing_period: sub.billing_period,
      expires_at: sub.expires_at ?? sub.current_period_end ?? null,
      auto_renew: sub.auto_renew,
    };
  }

  private async awardQhqTokens(
    userId: string,
    tier: PlanTier,
    billingPeriod: string,
    reference?: string,
  ): Promise<void> {
    try {
      const ruleKey =
        tier === PlanTier.ELITE ? 'MONTHLY_ELITE' : tier === PlanTier.PRO ? 'MONTHLY_PRO' : null;
      if (!ruleKey) return;
      const monthlyAmount = await this.qhqService.getRuleAmount(ruleKey);
      if (monthlyAmount <= 0) return;
      const multiplier = billingPeriod === 'YEARLY' ? 12 : billingPeriod === 'QUARTERLY' ? 3 : 1;
      const totalAmount = monthlyAmount * multiplier;
      await this.qhqService.earnTokens(
        userId,
        QhqTransactionType.EARN_SUBSCRIPTION,
        totalAmount,
        `Apple subscription payment: ${tier} (${billingPeriod})`,
        reference,
      );
      this.logger.log(`Awarded ${totalAmount} QHQ to user ${userId} for Apple ${tier} ${billingPeriod}`);
    } catch (err: any) {
      this.logger.warn(`QHQ award failed for Apple purchase (user ${userId}): ${err?.message}`);
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // 3. POST /webhooks/apple — App Store Server Notifications V2
  // ──────────────────────────────────────────────────────────────────────
  @Post('webhooks/apple')
  @HttpCode(HttpStatus.OK)
  async webhook(@Body() body: { signedPayload?: string }) {
    // Always return 200 so Apple stops retrying; failures are logged for
    // manual recovery (same posture as the Stripe webhook).
    if (!this.appleIap.isConfigured()) {
      this.logger.warn('Received Apple webhook but Apple IAP is not configured');
      return { received: true };
    }

    const signedPayload = body?.signedPayload;
    if (!signedPayload) {
      this.logger.warn('Apple webhook missing signedPayload');
      return { received: true };
    }

    let notification;
    try {
      notification = await this.appleIap.verifyNotification(signedPayload);
    } catch (err: any) {
      this.logger.warn(`Apple webhook signature verification failed: ${err?.message}`);
      // Do not reveal verification internals; 200 to avoid retries on bad data.
      return { received: true };
    }

    try {
      await this.dispatchNotification(notification);
    } catch (err: any) {
      this.logger.error(
        `Failed to process Apple notification ${notification?.notificationType}: ${err?.message}`,
      );
    }

    return { received: true };
  }

  private async dispatchNotification(notification: any): Promise<void> {
    const type = notification?.notificationType as NotificationTypeV2 | string;
    const data = notification?.data;
    if (!data?.signedTransactionInfo) {
      this.logger.warn(`Apple notification ${type} has no transaction info; skipping`);
      return;
    }

    const tx = await this.appleIap.decodeSignedTransaction(data.signedTransactionInfo);
    const renewalInfo = data.signedRenewalInfo
      ? await this.appleIap.decodeSignedRenewalInfo(data.signedRenewalInfo)
      : null;

    const originalTransactionId = tx.originalTransactionId;
    if (!originalTransactionId) {
      this.logger.warn(`Apple notification ${type} missing originalTransactionId; skipping`);
      return;
    }

    const expiresDate = tx.expiresDate ? new Date(tx.expiresDate) : null;

    switch (type) {
      case NotificationTypeV2.SUBSCRIBED:
      case NotificationTypeV2.DID_RENEW: {
        if (expiresDate) {
          const updated = await this.subscriptionsService.applyAppleRenewal(
            originalTransactionId,
            expiresDate,
          );
          // Record renewal payments (not the initial SUBSCRIBED — that is
          // recorded by /verify). external_payment_id = transactionId keeps
          // replays from double-billing affiliate commissions.
          if (updated && type === NotificationTypeV2.DID_RENEW) {
            await this.recordRenewalPayment(updated, tx);
          }
        }
        break;
      }

      case NotificationTypeV2.DID_CHANGE_RENEWAL_STATUS: {
        // autoRenewStatus: 1 = ON, 0 = OFF. Access is unchanged until expiry.
        const autoRenew = renewalInfo?.autoRenewStatus === 1;
        await this.subscriptionsService.setAppleAutoRenew(originalTransactionId, autoRenew);
        break;
      }

      case NotificationTypeV2.DID_FAIL_TO_RENEW: {
        // Grace period / billing retry — keep access, do NOT revoke. We wait for
        // EXPIRED / GRACE_PERIOD_EXPIRED before downgrading.
        this.logger.log(
          `Apple subscription ${originalTransactionId} failed to renew (grace period); access retained`,
        );
        break;
      }

      case NotificationTypeV2.EXPIRED:
      case NotificationTypeV2.GRACE_PERIOD_EXPIRED: {
        await this.subscriptionsService.handleAppleSubscriptionCancelled(
          originalTransactionId,
          expiresDate,
        );
        await this.notifyCancelled(originalTransactionId);
        break;
      }

      case NotificationTypeV2.REFUND:
      case NotificationTypeV2.REVOKE: {
        // Immediate revocation regardless of expiry.
        await this.subscriptionsService.handleAppleSubscriptionCancelled(originalTransactionId, new Date());
        await this.notifyCancelled(originalTransactionId);
        break;
      }

      default:
        this.logger.log(`Unhandled Apple notification type: ${type}`);
    }
  }

  /**
   * Resolve the amount/currency Apple actually charged. Apple's transaction
   * `price` is in milliunits (price × 1000), so $189.99 arrives as 189990.
   * Falls back to the plan price (USD) when Apple omits it.
   */
  private resolveTxAmount(tx: any, planPrice: any): { amount: number; currency: string } {
    if (typeof tx?.price === 'number' && tx.price > 0) {
      return { amount: tx.price / 1000, currency: tx.currency || 'USD' };
    }
    return { amount: Number(planPrice) || 0, currency: 'USD' };
  }

  private async recordRenewalPayment(sub: any, tx: any): Promise<void> {
    const plan = await this.prisma.subscription_plans.findUnique({
      where: { plan_id: sub.plan_id },
    });
    const { amount, currency } = this.resolveTxAmount(tx, plan?.price);
    if (amount <= 0) return;
    try {
      await this.subscriptionsService.recordPayment({
        subscription_id: sub.subscription_id,
        user_id: sub.user_id,
        amount,
        currency,
        status: 'succeeded',
        payment_provider: 'apple',
        external_payment_id: tx.transactionId,
        payment_method: 'apple_iap',
        invoice_url: null,
        receipt_url: null,
        failure_reason: null,
      });
    } catch (err: any) {
      this.logger.error(`Failed to record Apple renewal payment: ${err?.message}`);
    }
  }

  private async notifyCancelled(originalTransactionId: string): Promise<void> {
    try {
      const sub = await this.subscriptionsService.findAppleSubscription(originalTransactionId);
      if (!sub) return;
      const notification = await this.notificationsService.createNotification({
        user_id: sub.user_id,
        type: 'subscription_cancelled',
        title: 'Subscription Ended',
        message: 'Your subscription has ended and your account is now on the FREE tier',
        read: false,
        metadata: null,
      });
      this.notificationsService.sendNotification(
        sub.user_id,
        'Subscription Ended',
        'Your subscription has ended and your account is now on the FREE tier',
      );
      this.appGateway.emitNotificationCount(sub.user_id, 1, notification);
    } catch (err: any) {
      this.logger.warn(`Apple cancellation notification failed: ${err?.message}`);
    }
  }
}
