import { Injectable, Logger } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../../../prisma/prisma.service';

interface SettingsSnapshot {
  subscription_commission_pct: Decimal;
  recurring_months_cap: number;
  refund_clawback_days: number;
}

@Injectable()
export class AffiliateCommissionService {
  private readonly logger = new Logger(AffiliateCommissionService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Accrue an affiliate commission for one subscription payment.
   *
   * Idempotent on (event_type, source_reference) — Stripe webhook replays,
   * duplicate writes, or retries cannot double-pay.
   *
   * No-ops cleanly when:
   *   - The user has no referrer
   *   - The referrer is not currently APPROVED
   *   - The recurring_months_cap has already been reached for this user
   *   - This same source_reference was already recorded
   *
   * Wrapped in try/catch by the caller — must never block subscription
   * payment recording.
   */
  async recordSubscriptionPayment(params: {
    userId: string;
    paymentReference: string;
    grossAmountUsd: number | Decimal;
  }): Promise<void> {
    const { userId, paymentReference } = params;
    const gross = new Decimal(params.grossAmountUsd);

    if (gross.lte(0)) return;

    const user = await this.prisma.users.findUnique({
      where: { user_id: userId },
      select: { referred_by_affiliate_id: true },
    });
    if (!user?.referred_by_affiliate_id) return;

    const affiliate = await this.prisma.affiliates.findUnique({
      where: { affiliate_id: user.referred_by_affiliate_id },
      select: {
        affiliate_id: true,
        status: true,
        commission_pct: true,
      },
    });
    if (!affiliate || affiliate.status !== 'APPROVED') return;

    const settings = await this.getActiveSettings();
    if (!settings) {
      this.logger.warn(
        'No active affiliate_program_settings — skipping commission accrual',
      );
      return;
    }

    // Recurring-months cap: count existing SUBSCRIPTION_PAYMENT events for
    // this affiliate × user pair. cap = 0 means unlimited.
    if (settings.recurring_months_cap > 0) {
      const prior = await this.prisma.affiliate_commission_events.count({
        where: {
          affiliate_id: affiliate.affiliate_id,
          user_id: userId,
          event_type: 'SUBSCRIPTION_PAYMENT',
          status: { in: ['ACCRUED', 'PAID'] },
        },
      });
      if (prior >= settings.recurring_months_cap) {
        this.logger.debug(
          `Skipping commission — cap reached: ${prior}/${settings.recurring_months_cap} for user ${userId}`,
        );
        return;
      }
    }

    // Every affiliate has their own rate, stamped at approval time and
    // editable by the super admin. The program default rate is only the
    // pre-fill in the approve form; it isn't used here.
    const rate = new Decimal(
      affiliate.commission_pct ?? settings.subscription_commission_pct,
    );
    const commission = gross.times(rate).toDecimalPlaces(2);

    // Determine if this is the first paying conversion for this user (used
    // to drive the `conversion_count` denormalized counter on the affiliate).
    const existingForUser = await this.prisma.affiliate_commission_events.count({
      where: {
        affiliate_id: affiliate.affiliate_id,
        user_id: userId,
        event_type: 'SUBSCRIPTION_PAYMENT',
      },
    });
    const isFirstConversion = existingForUser === 0;

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.affiliate_commission_events.create({
          data: {
            affiliate_id: affiliate.affiliate_id,
            user_id: userId,
            event_type: 'SUBSCRIPTION_PAYMENT',
            source_reference: paymentReference,
            gross_amount_usd: gross.toNumber(),
            commission_rate: rate.toNumber(),
            commission_usd: commission.toNumber(),
          },
        });
        await tx.affiliates.update({
          where: { affiliate_id: affiliate.affiliate_id },
          data: {
            pending_balance: { increment: commission.toNumber() },
            revenue_generated: { increment: gross.toNumber() },
            last_activity_at: new Date(),
            ...(isFirstConversion
              ? { conversion_count: { increment: 1 } }
              : {}),
          },
        });
        await tx.affiliate_audit_log.create({
          data: {
            affiliate_id: affiliate.affiliate_id,
            action: 'AFFILIATE_COMMISSION_ACCRUED',
            metadata: {
              user_id: userId,
              source_reference: paymentReference,
              gross_amount_usd: gross.toString(),
              commission_rate: rate.toString(),
              commission_usd: commission.toString(),
              first_conversion: isFirstConversion,
            },
          },
        });
      });

      this.logger.log(
        `Accrued $${commission.toFixed(2)} commission for affiliate ${affiliate.affiliate_id} (user ${userId}, payment ${paymentReference})`,
      );
    } catch (err: any) {
      // The unique constraint on (event_type, source_reference) will throw
      // P2002 on replays — that's exactly the idempotency we want.
      if (err?.code === 'P2002') {
        this.logger.debug(
          `Commission already accrued for ${paymentReference} — skipping replay`,
        );
        return;
      }
      this.logger.error(
        `Commission accrual failed for user ${userId} payment ${paymentReference}: ${err?.message}`,
      );
      // Don't rethrow — accrual must never block the source-of-truth write.
    }
  }

  /**
   * Reverse an accrued or paid commission when its underlying payment is
   * refunded / cancelled within the refund_clawback_days window.
   *
   * Decrement the right balance bucket based on whether the original event
   * was still ACCRUED (debit pending_balance) or already PAID (debit
   * paid_total). Either way, increment clawed_back_total for visibility.
   */
  async clawbackCommission(params: {
    paymentReference: string;
    reason?: string;
  }): Promise<void> {
    const events = await this.prisma.affiliate_commission_events.findMany({
      where: {
        source_reference: params.paymentReference,
        status: { in: ['ACCRUED', 'PAID'] },
      },
    });
    if (events.length === 0) return;

    for (const event of events) {
      try {
        await this.prisma.$transaction(async (tx) => {
          await tx.affiliate_commission_events.update({
            where: { event_id: event.event_id },
            data: {
              status: 'CLAWED_BACK',
              clawed_back_at: new Date(),
            },
          });
          const amount = new Decimal(event.commission_usd).toNumber();
          await tx.affiliates.update({
            where: { affiliate_id: event.affiliate_id },
            data: {
              ...(event.status === 'ACCRUED'
                ? { pending_balance: { decrement: amount } }
                : { paid_total: { decrement: amount } }),
              clawed_back_total: { increment: amount },
            },
          });
          await tx.affiliate_audit_log.create({
            data: {
              affiliate_id: event.affiliate_id,
              action: 'AFFILIATE_COMMISSION_CLAWED_BACK',
              metadata: {
                event_id: event.event_id,
                user_id: event.user_id,
                source_reference: event.source_reference,
                commission_usd: event.commission_usd,
                previous_status: event.status,
                reason: params.reason ?? 'refund_or_cancel_within_window',
              },
            },
          });
        });
        this.logger.log(
          `Clawed back $${event.commission_usd} from affiliate ${event.affiliate_id} (event ${event.event_id})`,
        );
      } catch (err: any) {
        this.logger.error(
          `Clawback failed for event ${event.event_id}: ${err?.message}`,
        );
      }
    }
  }

  /**
   * Convenience wrapper for cancellation/refund flows: look up the most
   * recent successful payment for a subscription and, if it falls within the
   * refund clawback window, claw back the matching commission event.
   *
   * Only call this when the cancellation is effectively a refund. Pure
   * end-of-period cancellations (auto_renew=false) should NOT trigger this.
   */
  async clawbackForSubscriptionIfRecent(params: {
    subscriptionId: string;
  }): Promise<void> {
    const settings = await this.getActiveSettings();
    if (!settings) return;

    const lastPayment = await this.prisma.payment_history.findFirst({
      where: {
        subscription_id: params.subscriptionId,
        status: 'succeeded',
      },
      orderBy: { paid_at: 'desc' },
      select: { payment_id: true, paid_at: true },
    });
    if (!lastPayment?.paid_at) return;

    const ageDays =
      (Date.now() - lastPayment.paid_at.getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays > settings.refund_clawback_days) return;

    await this.clawbackCommission({
      paymentReference: lastPayment.payment_id,
      reason: `subscription_cancelled_within_${settings.refund_clawback_days}d`,
    });
  }

  private async getActiveSettings(): Promise<SettingsSnapshot | null> {
    const row = await this.prisma.affiliate_program_settings.findFirst({
      where: { is_active: true },
      orderBy: { version: 'desc' },
      select: {
        subscription_commission_pct: true,
        recurring_months_cap: true,
        refund_clawback_days: true,
      },
    });
    if (!row) return null;
    return {
      subscription_commission_pct: new Decimal(row.subscription_commission_pct),
      recurring_months_cap: row.recurring_months_cap,
      refund_clawback_days: row.refund_clawback_days,
    };
  }
}
