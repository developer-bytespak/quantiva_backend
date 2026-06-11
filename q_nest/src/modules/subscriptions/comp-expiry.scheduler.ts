import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { SubscriptionsService, PlanTier } from './subscriptions.service';
import { EmailSenderService } from '../onboarding-emails/services/email-sender.service';

function frontendBase(): string {
  return (
    (process.env.FRONTEND_URL || '').trim().replace(/\/+$/, '') ||
    'https://quantivahq.com'
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function tierLabel(tier: string): string {
  return tier
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function expiryEmailHtml(opts: { name: string; tier: string }): string {
  const subscribeUrl = `${frontendBase()}/dashboard/settings/subscription`;
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#050a12;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#e2e8f0;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#050a12;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;background:#0b1220;border:1px solid #1e293b;border-radius:14px;">
        <tr><td style="padding:28px 32px 8px 32px;">
          <div style="font-size:12px;letter-spacing:.15em;text-transform:uppercase;color:#fc4f02;font-weight:700;">QuantivaHQ</div>
        </td></tr>
        <tr><td style="padding:8px 32px 24px 32px;">
          <h1 style="margin:0 0 16px 0;font-size:22px;font-weight:700;color:#ffffff;">Hi ${escapeHtml(opts.name)},</h1>
          <div style="font-size:14px;line-height:1.6;color:#cbd5e1;">
            <p>Your complimentary <strong style="color:#ffffff;">${escapeHtml(tierLabel(opts.tier))}</strong> access has ended, and your account is now on the Free plan.</p>
            <p>To keep using premium features, pick a plan from your subscription settings:</p>
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0;"><tr><td style="background:linear-gradient(90deg,#fc4f02,#fda300);border-radius:8px;">
              <a href="${subscribeUrl}" style="display:inline-block;padding:12px 22px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">Choose a plan</a>
            </td></tr></table>
            <p style="font-size:13px;color:#94a3b8;">Tip: QHQ tokens in your balance can be spent for a discount on your subscription from the QHQ page.</p>
          </div>
        </td></tr>
        <tr><td style="padding:16px 32px 28px 32px;border-top:1px solid #1e293b;font-size:12px;color:#64748b;">
          You're receiving this because your complimentary plan on QuantivaHQ expired.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

/**
 * Expires complimentary (admin_override) subscriptions whose period has
 * lapsed — e.g. the 30-day Elite Plus comp granted to approved affiliates.
 * Deliberately scoped to admin_override: Stripe-billed subscriptions manage
 * their own lifecycle through webhooks and must not be touched here.
 */
@Injectable()
export class CompExpiryScheduler {
  private readonly logger = new Logger(CompExpiryScheduler.name);

  constructor(
    private prisma: PrismaService,
    private subscriptionsService: SubscriptionsService,
    private emailSender: EmailSenderService,
  ) {}

  /** Hourly — downgrade lapsed comps, then notify the user in-app + by email. */
  @Cron('0 * * * *', { name: 'comp-subscription-expiry', timeZone: 'UTC' })
  async expireLapsedComps(): Promise<void> {
    const lapsed = await this.prisma.user_subscriptions.findMany({
      where: {
        status: 'active',
        billing_provider: 'admin_override',
        tier: { not: PlanTier.FREE },
        current_period_end: { lt: new Date() },
      },
      select: {
        subscription_id: true,
        user_id: true,
        tier: true,
        user: { select: { email: true, username: true, full_name: true } },
      },
    });
    if (lapsed.length === 0) return;

    this.logger.log(`Expiring ${lapsed.length} lapsed comped subscription(s)`);

    for (const sub of lapsed) {
      try {
        await this.subscriptionsService.handleAdminOverrideSubscriptionCancelled(
          sub.subscription_id,
        );
      } catch (err: any) {
        this.logger.error(
          `Failed to expire comped subscription ${sub.subscription_id}: ${err?.message}`,
        );
        continue; // don't notify about a downgrade that didn't happen
      }

      const label = tierLabel(sub.tier);
      try {
        await this.prisma.notifications.create({
          data: {
            user_id: sub.user_id,
            type: 'subscription',
            title: `Your complimentary ${label} has ended`,
            message: `Your free ${label} period is over and your account is now on the Free plan. Subscribe from Settings → Subscription to keep your premium features.`,
            metadata: { subscription_id: sub.subscription_id, tier: sub.tier },
          },
        });
      } catch (err: any) {
        this.logger.warn(
          `Comp-expiry notification failed for user ${sub.user_id}: ${err?.message}`,
        );
      }

      try {
        await this.emailSender.send({
          to: sub.user.email,
          subject: `Your complimentary ${label} on QuantivaHQ has ended`,
          html: expiryEmailHtml({
            name: sub.user.full_name ?? sub.user.username,
            tier: sub.tier,
          }),
          unsubscribeUrl: `${frontendBase()}/unsubscribe`,
        });
      } catch (err: any) {
        this.logger.warn(
          `Comp-expiry email failed for ${sub.user.email}: ${err?.message}`,
        );
      }
    }
  }
}
