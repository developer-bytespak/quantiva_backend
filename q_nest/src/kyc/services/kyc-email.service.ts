import { Injectable, Logger } from '@nestjs/common';
import sgMail from '@sendgrid/mail';

@Injectable()
export class KycEmailService {
  private readonly logger = new Logger(KycEmailService.name);
  private readonly fromEmail: string;
  private readonly initialized: boolean;
  private readonly dashboardUrl: string;

  constructor() {
    const apiKey = process.env.SENDGRID_API_KEY;
    this.fromEmail = process.env.SENDGRID_FROM_EMAIL || process.env.SMTP_FROM_EMAIL || '';
    this.dashboardUrl = process.env.FRONTEND_URL || 'https://app.quantiva.com';

    if (apiKey && this.fromEmail) {
      sgMail.setApiKey(apiKey);
      this.initialized = true;
    } else {
      this.logger.warn('SendGrid not configured for KYC emails');
      this.initialized = false;
    }
  }

  private wrapTemplate(body: string): string {
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: linear-gradient(135deg, #fc4f02 0%, #fda300 100%); padding: 30px; border-radius: 10px 10px 0 0;">
          <h1 style="color: white; margin: 0; text-align: center;">Quantiva</h1>
        </div>
        <div style="background: #ffffff; padding: 30px; border-radius: 0 0 10px 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
          ${body}
        </div>
      </div>
    `;
  }

  private infoBox(content: string): string {
    return `<div style="background: #f8f8f8; border: 1px solid #ececec; border-radius: 8px; padding: 18px; margin: 20px 0;">${content}</div>`;
  }

  private ctaButton(href: string, label: string): string {
    return `<div style="text-align: center; margin: 28px 0;">
      <a href="${href}" style="background: linear-gradient(135deg, #fc4f02 0%, #fda300 100%); color: white; padding: 14px 34px; text-decoration: none; border-radius: 8px; font-weight: 600; display: inline-block;">${label}</a>
    </div>`;
  }

  private formatReasons(reasons: string[]): string {
    if (!reasons.length) return '';
    if (reasons.length === 1) return `<p style="margin: 0; color: #333;">${reasons[0]}</p>`;
    return `<ul style="margin: 0; padding-left: 20px; color: #333;">${reasons
      .map((r) => `<li style="margin-bottom: 8px;">${r}</li>`)
      .join('')}</ul>`;
  }

  async sendApprovedEmail(userEmail: string, userName?: string): Promise<void> {
    if (!this.initialized) return;
    try {
      await sgMail.send({
        to: userEmail,
        from: { email: this.fromEmail, name: 'Quantiva' },
        subject: 'Your identity has been verified!',
        html: this.wrapTemplate(`
          <h2 style="color: #333; margin-top: 0;">You're verified!</h2>
          <p style="color: #666; font-size: 16px;">Hello${userName ? ` ${userName}` : ''},</p>
          <p style="color: #666; font-size: 16px;">Great news — your identity has been successfully verified. Your Quantiva account is now fully active.</p>
          ${this.infoBox(
            `<p style="margin: 0; color: #333;">You can now trade, deposit, withdraw, and join VC Pools.</p>`,
          )}
          ${this.ctaButton(`${this.dashboardUrl}/dashboard`, 'Go to Dashboard')}
        `),
      });
      this.logger.log(`KYC approved email sent to ${userEmail}`);
    } catch (error) {
      this.logger.error(
        `Failed to send KYC approved email: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async sendRetryRejectionEmail(
    userEmail: string,
    userName: string | undefined,
    reasons: string[],
  ): Promise<void> {
    if (!this.initialized) return;
    try {
      await sgMail.send({
        to: userEmail,
        from: { email: this.fromEmail, name: 'Quantiva' },
        subject: 'Action required: Please resubmit your documents',
        html: this.wrapTemplate(`
          <h2 style="color: #333; margin-top: 0;">We need you to try again</h2>
          <p style="color: #666; font-size: 16px;">Hello${userName ? ` ${userName}` : ''},</p>
          <p style="color: #666; font-size: 16px;">Your identity verification could not be completed. Please log in and resubmit your documents.</p>
          ${this.infoBox(`
            <p style="margin: 0 0 10px; color: #333; font-weight: 600;">Reason${reasons.length > 1 ? 's' : ''}:</p>
            ${this.formatReasons(reasons)}
          `)}
          ${this.ctaButton(`${this.dashboardUrl}/onboarding/kyc-verification`, 'Retry Verification')}
        `),
      });
      this.logger.log(`KYC retry email sent to ${userEmail}`);
    } catch (error) {
      this.logger.error(
        `Failed to send KYC retry email: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async sendFinalRejectionEmail(
    userEmail: string,
    userName: string | undefined,
    reasons: string[],
  ): Promise<void> {
    if (!this.initialized) return;
    try {
      await sgMail.send({
        to: userEmail,
        from: { email: this.fromEmail, name: 'Quantiva' },
        subject: 'Verification permanently rejected',
        html: this.wrapTemplate(`
          <h2 style="color: #333; margin-top: 0;">Verification Rejected</h2>
          <p style="color: #666; font-size: 16px;">Hello${userName ? ` ${userName}` : ''},</p>
          <p style="color: #666; font-size: 16px;">Your identity verification has been permanently rejected. Your account will be deleted on your next login.</p>
          ${this.infoBox(`
            <p style="margin: 0 0 10px; color: #333; font-weight: 600;">Reason${reasons.length > 1 ? 's' : ''}:</p>
            ${this.formatReasons(reasons)}
          `)}
          <p style="color: #999; font-size: 14px; margin-top: 28px;">This decision is final and cannot be retried.</p>
        `),
      });
      this.logger.log(`KYC final rejection email sent to ${userEmail}`);
    } catch (error) {
      this.logger.error(
        `Failed to send KYC final rejection email: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
