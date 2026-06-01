import { Injectable, Logger } from '@nestjs/common';
import { EmailSenderService } from '../../onboarding-emails/services/email-sender.service';

const BRAND_COLOR = '#fc4f02';
const ACCENT_COLOR = '#fda300';

function frontendBase(): string {
  return (
    (process.env.FRONTEND_URL || '').trim().replace(/\/+$/, '') ||
    'https://quantivahq.com'
  );
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shell(opts: {
  preheader: string;
  greetingName: string;
  bodyHtml: string;
}): string {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#050a12;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#e2e8f0;">
  <span style="display:none;opacity:0;visibility:hidden;mso-hide:all;height:0;width:0;overflow:hidden;">${escape(opts.preheader)}</span>
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#050a12;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;background:#0b1220;border:1px solid #1e293b;border-radius:14px;">
        <tr><td style="padding:28px 32px 8px 32px;">
          <div style="font-size:12px;letter-spacing:.15em;text-transform:uppercase;color:${BRAND_COLOR};font-weight:700;">QuantivaHQ Affiliate Program</div>
        </td></tr>
        <tr><td style="padding:8px 32px 24px 32px;">
          <h1 style="margin:0 0 16px 0;font-size:22px;font-weight:700;color:#ffffff;">Hi ${escape(opts.greetingName)},</h1>
          <div style="font-size:14px;line-height:1.6;color:#cbd5e1;">${opts.bodyHtml}</div>
        </td></tr>
        <tr><td style="padding:16px 32px 28px 32px;border-top:1px solid #1e293b;font-size:12px;color:#64748b;">
          You're receiving this because you applied to the QuantivaHQ Affiliate Program.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function ctaButton(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0;"><tr><td style="background:linear-gradient(90deg,${BRAND_COLOR},${ACCENT_COLOR});border-radius:8px;">
    <a href="${href}" style="display:inline-block;padding:12px 22px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">${escape(label)}</a>
  </td></tr></table>`;
}

@Injectable()
export class AffiliateEmailService {
  private readonly logger = new Logger(AffiliateEmailService.name);

  constructor(private readonly emailSender: EmailSenderService) {}

  private async send(opts: {
    to: string;
    subject: string;
    html: string;
  }): Promise<void> {
    try {
      const result = await this.emailSender.send({
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
        unsubscribeUrl: `${frontendBase()}/unsubscribe`,
      });
      if (!result.ok) {
        this.logger.warn(
          `Affiliate email send failed (${opts.subject}): ${result.error}`,
        );
      }
    } catch (err: any) {
      this.logger.error(
        `Affiliate email send threw (${opts.subject}): ${err?.message}`,
      );
    }
  }

  async sendApplicationReceived(args: {
    email: string;
    displayName: string;
  }): Promise<void> {
    const pendingUrl = `${frontendBase()}/affiliate/pending`;
    const html = shell({
      preheader: 'We received your QuantivaHQ Affiliate application.',
      greetingName: args.displayName,
      bodyHtml: `
        <p>Thanks for applying to the QuantivaHQ Affiliate Program. We've received your application and a team member will review it within a few business days.</p>
        <p>You can check your application status at any time from your affiliate dashboard:</p>
        ${ctaButton(pendingUrl, 'View application status')}
        <p style="font-size:13px;color:#94a3b8;">If we need anything else, we'll reach out by email.</p>
      `,
    });
    await this.send({
      to: args.email,
      subject: 'Thanks for applying — QuantivaHQ Affiliate Program',
      html,
    });
  }

  async sendApplicationApproved(args: {
    email: string;
    displayName: string;
    referralCode: string;
  }): Promise<void> {
    const base = frontendBase();
    const dashboardUrl = `${base}/affiliate/dashboard`;
    const referralLink = `${base}/?ref=${encodeURIComponent(args.referralCode)}`;
    const html = shell({
      preheader: `Your affiliate code is ${args.referralCode}.`,
      greetingName: args.displayName,
      bodyHtml: `
        <p><strong style="color:#ffffff;">Welcome to the QuantivaHQ Affiliate Program.</strong> Your application has been approved and your referral code is live.</p>
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px 0;width:100%;background:#070d17;border:1px solid #1e293b;border-radius:8px;"><tr>
          <td style="padding:14px 18px;">
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:#64748b;">Your code</div>
            <div style="font-family:monospace;font-size:18px;color:${BRAND_COLOR};font-weight:700;margin-top:4px;">${escape(args.referralCode)}</div>
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:#64748b;margin-top:12px;">Referral link</div>
            <div style="font-family:monospace;font-size:13px;color:#cbd5e1;word-break:break-all;margin-top:4px;">${escape(referralLink)}</div>
          </td>
        </tr></table>
        ${ctaButton(dashboardUrl, 'Open your dashboard')}
        <p style="font-size:13px;color:#94a3b8;">From the dashboard you can track signups, conversions, earnings, and set up how you'd like to be paid.</p>
      `,
    });
    await this.send({
      to: args.email,
      subject: `You're in — your QuantivaHQ affiliate code is ${args.referralCode}`,
      html,
    });
  }

  async sendApplicationRejected(args: {
    email: string;
    displayName: string;
    reason: string;
    message?: string;
  }): Promise<void> {
    const html = shell({
      preheader: 'Update on your QuantivaHQ Affiliate application.',
      greetingName: args.displayName,
      bodyHtml: `
        <p>Thanks again for applying to the QuantivaHQ Affiliate Program. After review, we're not able to approve your application at this time.</p>
        <p><strong style="color:#ffffff;">Reason:</strong> ${escape(args.reason)}</p>
        ${args.message ? `<p>${escape(args.message)}</p>` : ''}
        <p style="font-size:13px;color:#94a3b8;">You're welcome to re-apply after 30 days. If you believe this was a mistake, reach out via our contact form.</p>
      `,
    });
    await this.send({
      to: args.email,
      subject: 'Update on your QuantivaHQ Affiliate Program application',
      html,
    });
  }

  async sendInfoRequested(args: {
    email: string;
    displayName: string;
    message: string;
  }): Promise<void> {
    const pendingUrl = `${frontendBase()}/affiliate/pending`;
    const html = shell({
      preheader: 'We need a bit more info to finish reviewing your application.',
      greetingName: args.displayName,
      bodyHtml: `
        <p>Thanks for applying. To finish reviewing your application, we need a bit more info:</p>
        <div style="margin:12px 0;padding:14px 16px;background:#070d17;border:1px solid #1e293b;border-radius:8px;font-size:14px;color:#e2e8f0;white-space:pre-wrap;">${escape(args.message)}</div>
        <p>You can reply directly to this email, or update your application from your dashboard:</p>
        ${ctaButton(pendingUrl, 'Open application')}
      `,
    });
    await this.send({
      to: args.email,
      subject: 'QuantivaHQ Affiliate Program — additional info needed',
      html,
    });
  }

  async sendPayoutSent(args: {
    email: string;
    displayName: string;
    period: string;
    netUsd: number | string;
    paymentReference?: string | null;
  }): Promise<void> {
    const payoutsUrl = `${frontendBase()}/affiliate/payouts`;
    const html = shell({
      preheader: `Your QuantivaHQ affiliate payout for ${args.period}.`,
      greetingName: args.displayName,
      bodyHtml: `
        <p>Your QuantivaHQ affiliate payout for <strong style="color:#ffffff;">${escape(args.period)}</strong> has been marked paid.</p>
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px 0;width:100%;background:#070d17;border:1px solid #1e293b;border-radius:8px;"><tr>
          <td style="padding:14px 18px;">
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:#64748b;">Period</div>
            <div style="font-size:14px;color:#e2e8f0;margin-top:2px;">${escape(args.period)}</div>
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:#64748b;margin-top:10px;">Net amount</div>
            <div style="font-size:18px;color:#34d399;font-weight:700;margin-top:2px;">$${Number(args.netUsd).toFixed(2)}</div>
            ${args.paymentReference ? `<div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:#64748b;margin-top:10px;">Reference</div><div style="font-family:monospace;font-size:13px;color:#cbd5e1;margin-top:2px;">${escape(args.paymentReference)}</div>` : ''}
          </td>
        </tr></table>
        ${ctaButton(payoutsUrl, 'View payout history')}
        <p style="font-size:13px;color:#94a3b8;">If you don't see the funds within a few business days, check the payment reference above against your records or reach out.</p>
      `,
    });
    await this.send({
      to: args.email,
      subject: `Your QuantivaHQ affiliate payout for ${args.period}`,
      html,
    });
  }
}
