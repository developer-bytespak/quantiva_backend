// Transactional emails for the Premium plan lifecycle. Plain HTML strings in
// the same visual style as comp-expiry.scheduler.ts so they can be sent through
// EmailSenderService without a template engine.

import { premiumPriceLabel, tierLabel } from '../../../common/tiers';

export function frontendBase(): string {
  return (
    (process.env.FRONTEND_URL || '').trim().replace(/\/+$/, '') || 'https://quantivahq.com'
  );
}

export function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatDate(d: Date | string | null | undefined): string {
  if (!d) return 'your next billing date';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return 'your next billing date';
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

/** "$29.99/month" etc. for a subscription row's billing period and (optional) plan price. */
export function priceLabel(period?: string | null, price?: number | string | null): string {
  return premiumPriceLabel(period, price);
}

/** Just the money part, "$79.99". */
export function amountLabel(period?: string | null, price?: number | string | null): string {
  return premiumPriceLabel(period, price).split(/\/| every /)[0];
}

/** "monthly" | "every 3 months" | "yearly" */
export function renewalCadence(period?: string | null): string {
  switch (period) {
    case 'QUARTERLY':
      return 'every 3 months';
    case 'YEARLY':
      return 'yearly';
    default:
      return 'monthly';
  }
}

function layout(opts: { name: string; title: string; bodyHtml: string; cta?: { label: string; href: string }; footer: string }): string {
  const cta = opts.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0;"><tr><td style="background:linear-gradient(90deg,#fc4f02,#fda300);border-radius:8px;">
        <a href="${opts.cta.href}" style="display:inline-block;padding:12px 22px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">${escapeHtml(opts.cta.label)}</a>
      </td></tr></table>`
    : '';
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#050a12;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#e2e8f0;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#050a12;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;background:#0b1220;border:1px solid #1e293b;border-radius:14px;">
        <tr><td style="padding:28px 32px 8px 32px;">
          <div style="font-size:12px;letter-spacing:.15em;text-transform:uppercase;color:#fc4f02;font-weight:700;">QuantivaHQ</div>
        </td></tr>
        <tr><td style="padding:8px 32px 24px 32px;">
          <h1 style="margin:0 0 16px 0;font-size:22px;font-weight:700;color:#ffffff;">${escapeHtml(opts.title)}</h1>
          <div style="font-size:14px;line-height:1.6;color:#cbd5e1;">
            <p>Hi ${escapeHtml(opts.name)},</p>
            ${opts.bodyHtml}
            ${cta}
          </div>
        </td></tr>
        <tr><td style="padding:16px 32px 28px 32px;border-top:1px solid #1e293b;font-size:12px;color:#64748b;">
          ${escapeHtml(opts.footer)}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

const settingsUrl = () => `${frontendBase()}/dashboard/settings/subscription`;
const strong = (s: string) => `<strong style="color:#ffffff;">${escapeHtml(s)}</strong>`;

export interface PeriodOpts {
  billingPeriod?: string | null;
  price?: number | string | null;
}

export function trialStartedEmail(opts: { name: string; trialEnd: Date | null } & PeriodOpts) {
  return {
    subject: 'Your 7-day Premium trial has started',
    html: layout({
      name: opts.name,
      title: 'Welcome to Quantiva Premium',
      bodyHtml: `
        <p>Your 7-day free trial is active and every Premium feature is unlocked.</p>
        <p>Your card will be charged ${strong(amountLabel(opts.billingPeriod, opts.price))} on ${strong(formatDate(opts.trialEnd))} and ${renewalCadence(opts.billingPeriod)} after that, unless you cancel before then.</p>
        <p>You can cancel anytime from your subscription settings and keep access until the trial ends.</p>`,
      cta: { label: 'Manage subscription', href: settingsUrl() },
      footer: 'You are receiving this because you started a Premium trial on QuantivaHQ.',
    }),
  };
}

export function premiumActiveEmail(opts: { name: string; nextBillingDate: Date | null } & PeriodOpts) {
  return {
    subject: 'Your Quantiva Premium subscription is active',
    html: layout({
      name: opts.name,
      title: 'Premium is active',
      bodyHtml: `
        <p>Thanks for subscribing. Every Premium feature is now unlocked.</p>
        <p>Your plan renews at ${strong(priceLabel(opts.billingPeriod, opts.price))}. Your next charge is on ${strong(formatDate(opts.nextBillingDate))}.</p>`,
      cta: { label: 'Manage subscription', href: settingsUrl() },
      footer: 'You are receiving this because you subscribed to Premium on QuantivaHQ.',
    }),
  };
}

export function trialEndingSoonEmail(opts: { name: string; trialEnd: Date | null } & PeriodOpts) {
  return {
    subject: 'Your Premium trial ends in 3 days',
    html: layout({
      name: opts.name,
      title: 'Your trial ends soon',
      bodyHtml: `
        <p>Your 7-day Premium trial ends on ${strong(formatDate(opts.trialEnd))}.</p>
        <p>If you do nothing, your card will be charged ${strong(amountLabel(opts.billingPeriod, opts.price))} on that date and your plan continues ${renewalCadence(opts.billingPeriod)}.</p>
        <p>Not for you? Cancel before then from your subscription settings and you will not be charged.</p>`,
      cta: { label: 'Review subscription', href: settingsUrl() },
      footer: 'You are receiving this because your Premium trial on QuantivaHQ is about to end.',
    }),
  };
}

export function paymentFailedEmail(opts: { name: string; invoiceUrl: string | null } & PeriodOpts) {
  return {
    subject: 'Action needed: your Premium payment did not go through',
    html: layout({
      name: opts.name,
      title: 'Payment failed',
      bodyHtml: `
        <p>We could not charge your card for Quantiva Premium (${escapeHtml(amountLabel(opts.billingPeriod, opts.price))}).</p>
        <p>Your access continues for now while we retry. To avoid losing Premium, update your card or pay the open invoice.</p>`,
      cta: { label: opts.invoiceUrl ? 'Pay invoice' : 'Update payment method', href: opts.invoiceUrl || settingsUrl() },
      footer: 'You are receiving this because a Premium payment on QuantivaHQ failed.',
    }),
  };
}

export function subscriptionEndedEmail(opts: { name: string }) {
  return {
    subject: 'Your Quantiva Premium subscription has ended',
    html: layout({
      name: opts.name,
      title: 'Premium has ended',
      bodyHtml: `
        <p>Your Premium subscription has ended and your account is now on the Free plan.</p>
        <p>You can resubscribe at any time from ${escapeHtml(priceLabel('MONTHLY'))}.</p>`,
      cta: { label: 'Resubscribe', href: settingsUrl() },
      footer: 'You are receiving this because your Premium subscription on QuantivaHQ ended.',
    }),
  };
}

export function cancelScheduledEmail(opts: { name: string; accessUntil: Date | null; wasTrial: boolean }) {
  return {
    subject: opts.wasTrial ? 'Your Premium trial is cancelled' : 'Your Premium cancellation is scheduled',
    html: layout({
      name: opts.name,
      title: opts.wasTrial ? 'Trial cancelled' : 'Cancellation scheduled',
      bodyHtml: opts.wasTrial
        ? `<p>Your free trial has been cancelled. You will not be charged.</p>
           <p>You keep Premium access until ${strong(formatDate(opts.accessUntil))}, then your account moves to the Free plan.</p>`
        : `<p>Your Premium plan will not renew. You keep full access until ${strong(formatDate(opts.accessUntil))}, then your account moves to the Free plan.</p>
           <p>Changed your mind? You can resume before that date from your subscription settings.</p>`,
      cta: { label: 'Subscription settings', href: settingsUrl() },
      footer: 'You are receiving this because you cancelled Premium on QuantivaHQ.',
    }),
  };
}

export function upgradedToPremiumEmail(opts: {
  name: string;
  oldTier: string;
  billingProvider: string | null;
  billingPeriod: string | null;
  periodEnd: Date | null;
}) {
  const old = tierLabel(opts.oldTier);
  const newPrice = priceLabel(opts.billingPeriod);
  let billing: string;
  if (opts.billingProvider === 'apple') {
    billing = `Your App Store subscription continues at its current price. To move to the ${escapeHtml(newPrice)} Premium plan, update it in Settings &gt; Subscriptions on your iPhone.`;
  } else if (opts.billingProvider === 'admin_override') {
    billing = `Your complimentary access runs until ${strong(formatDate(opts.periodEnd))}. After that you can continue on Premium from ${escapeHtml(priceLabel('MONTHLY'))}.`;
  } else {
    billing = `Nothing changes on your current billing cycle. From ${strong(formatDate(opts.periodEnd))} your plan is ${escapeHtml(newPrice)}.`;
  }
  return {
    subject: 'You have been upgraded to Quantiva Premium',
    html: layout({
      name: opts.name,
      title: 'Welcome to Premium',
      bodyHtml: `
        <p>We have simplified our plans. Your ${strong(old)} plan is now ${strong('Premium')}, which unlocks every Quantiva feature: options trading, VC pools, unlimited custom strategies and more.</p>
        <p>${billing}</p>`,
      cta: { label: 'See what is new', href: settingsUrl() },
      footer: 'You are receiving this because your QuantivaHQ plan was upgraded to Premium.',
    }),
  };
}
