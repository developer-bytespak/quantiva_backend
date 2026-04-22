import { Injectable, Logger } from '@nestjs/common';
import sgMail from '@sendgrid/mail';

@Injectable()
export class AuthEmailService {
  private readonly logger = new Logger(AuthEmailService.name);
  private readonly fromEmail: string;
  private readonly adminEmail: string;
  private readonly initialized: boolean;

  constructor() {
    const apiKey = process.env.SENDGRID_API_KEY;
    this.fromEmail = process.env.SENDGRID_FROM_EMAIL || process.env.SMTP_FROM_EMAIL || '';
    this.adminEmail = process.env.CONTACT_ADMIN_EMAIL || process.env.ADMIN_EMAIL || '';

    if (apiKey && this.fromEmail && this.adminEmail) {
      sgMail.setApiKey(apiKey);
      this.initialized = true;
    } else {
      this.logger.warn('SendGrid or admin email not configured for Auth emails');
      this.initialized = false;
    }
  }

  // ── Helper: wrap email body in branded template ──
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

  /**
   * Send email to admin about new user signup
   */
  async sendNewSignupNotification(data: {
    username: string;
    email: string;
    userId: string;
    signupTime?: Date;
  }): Promise<void> {
    if (!this.initialized) {
      this.logger.warn('Email service not initialized, skipping new signup notification');
      return;
    }

    try {
      const signupTime = data.signupTime ? new Date(data.signupTime).toLocaleString() : new Date().toLocaleString();

      await sgMail.send({
        to: this.adminEmail,
        from: { email: this.fromEmail, name: 'Quantiva' },
        subject: `🎉 New User Signup – ${data.username}`,
        html: this.wrapTemplate(`
          <h2 style="color: #333; margin-top: 0;">New User Registration</h2>
          <p style="color: #666; font-size: 16px;">A new user has signed up for Quantiva!</p>
          ${this.infoBox(`
            <p style="margin: 0 0 10px; color: #333;"><strong>Username:</strong> ${data.username}</p>
            <p style="margin: 0 0 10px; color: #333;"><strong>Email:</strong> ${data.email}</p>
            <p style="margin: 0 0 10px; color: #333;"><strong>User ID:</strong> <code>${data.userId}</code></p>
            <p style="margin: 0; color: #333;"><strong>Signup Time:</strong> ${signupTime}</p>
          `)}
          <p style="color: #666; font-size: 14px;">User has been automatically assigned a FREE plan subscription.</p>
          <p style="color: #999; font-size: 12px; margin-top: 30px; border-top: 1px solid #eee; padding-top: 15px;">
            <strong>Action Items:</strong> Monitor user activity and follow up if needed.
          </p>
        `),
      });

      this.logger.log(`New signup notification email sent to ${this.adminEmail} for user ${data.username}`);
    } catch (error) {
      this.logger.error(
        `Failed to send new signup notification: ${error instanceof Error ? error.message : String(error)}`
      );
      // Don't throw - we don't want to break signup flow if email fails
    }
  }

  /**
   * Send email to admin about new subscription created
   */
  async sendNewSubscriptionNotification(data: {
    username: string;
    email: string;
    userId: string;
    tier: string;
    billingPeriod: string;
    planPrice?: number;
    currency?: string;
    createdAt?: Date;
  }): Promise<void> {
    if (!this.initialized) {
      this.logger.warn('Email service not initialized, skipping new subscription notification');
      return;
    }

    try {
      const createdAt = data.createdAt ? new Date(data.createdAt).toLocaleString() : new Date().toLocaleString();
      const priceInfo = data.planPrice ? `${data.currency || 'USD'} ${data.planPrice}` : 'N/A';

      await sgMail.send({
        to: this.adminEmail,
        from: { email: this.fromEmail, name: 'Quantiva' },
        subject: `💳 New Subscription Created – ${data.tier} Plan`,
        html: this.wrapTemplate(`
          <h2 style="color: #333; margin-top: 0;">New Subscription Created</h2>
          <p style="color: #666; font-size: 16px;">A user has created a new subscription.</p>
          ${this.infoBox(`
            <p style="margin: 0 0 10px; color: #333;"><strong>Username:</strong> ${data.username}</p>
            <p style="margin: 0 0 10px; color: #333;"><strong>Email:</strong> ${data.email}</p>
            <p style="margin: 0 0 10px; color: #333;"><strong>User ID:</strong> <code>${data.userId}</code></p>
            <p style="margin: 0 0 10px; color: #333;"><strong>Plan Tier:</strong> <strong style="color: #fc4f02;">${data.tier}</strong></p>
            <p style="margin: 0 0 10px; color: #333;"><strong>Billing Period:</strong> ${data.billingPeriod}</p>
            <p style="margin: 0 0 10px; color: #333;"><strong>Price:</strong> ${priceInfo}</p>
            <p style="margin: 0; color: #333;"><strong>Created At:</strong> ${createdAt}</p>
          `)}
          <p style="color: #666; font-size: 14px;">The subscription is now active and the user can access all associated features.</p>
        `),
      });

      this.logger.log(`New subscription notification email sent to ${this.adminEmail} for user ${data.username}`);
    } catch (error) {
      this.logger.error(
        `Failed to send new subscription notification: ${error instanceof Error ? error.message : String(error)}`
      );
      // Don't throw - we don't want to break subscription flow if email fails
    }
  }

  /**
   * Send email to admin about subscription change/upgrade/downgrade
   */
  async sendSubscriptionChangedNotification(data: {
    username: string;
    email: string;
    userId: string;
    oldTier: string;
    newTier: string;
    oldBillingPeriod: string;
    newBillingPeriod: string;
    oldPrice?: number;
    newPrice?: number;
    currency?: string;
    changedAt?: Date;
    changeReason?: string;
  }): Promise<void> {
    if (!this.initialized) {
      this.logger.warn('Email service not initialized, skipping subscription changed notification');
      return;
    }

    try {
      const changedAt = data.changedAt ? new Date(data.changedAt).toLocaleString() : new Date().toLocaleString();
      const oldPriceInfo = data.oldPrice ? `${data.currency || 'USD'} ${data.oldPrice}` : 'N/A';
      const newPriceInfo = data.newPrice ? `${data.currency || 'USD'} ${data.newPrice}` : 'N/A';
      const isUpgrade = (
        data.newTier === 'ELITE_PLUS' ||
        (data.newTier === 'ELITE' && data.oldTier !== 'ELITE_PLUS') ||
        (data.newTier === 'PRO' && data.oldTier === 'FREE')
      );
      const changeType = isUpgrade ? '⬆️ Upgrade' : '⬇️ Downgrade';

      await sgMail.send({
        to: this.adminEmail,
        from: { email: this.fromEmail, name: 'Quantiva' },
        subject: `${changeType} – Subscription Changed (${data.oldTier} → ${data.newTier})`,
        html: this.wrapTemplate(`
          <h2 style="color: #333; margin-top: 0;">Subscription Changed</h2>
          <p style="color: #666; font-size: 16px;">A user has changed their subscription plan.</p>
          ${this.infoBox(`
            <p style="margin: 0 0 10px; color: #333;"><strong>Username:</strong> ${data.username}</p>
            <p style="margin: 0 0 10px; color: #333;"><strong>Email:</strong> ${data.email}</p>
            <p style="margin: 0 0 10px; color: #333;"><strong>User ID:</strong> <code>${data.userId}</code></p>
            <p style="margin: 0 0 10px; color: #333;">
              <strong>Plan Change:</strong>
              <span style="background: #ffe8d1; padding: 2px 8px; border-radius: 4px; margin: 0 4px;">
                ${data.oldTier} (${data.oldBillingPeriod})
              </span>
              <span style="color: #999;">→</span>
              <span style="background: #d1ffe8; padding: 2px 8px; border-radius: 4px; margin: 0 4px;">
                ${data.newTier} (${data.newBillingPeriod})
              </span>
            </p>
            <p style="margin: 0 0 10px; color: #333;">
              <strong>Price Change:</strong> ${oldPriceInfo} → ${newPriceInfo}
            </p>
            ${data.changeReason ? `<p style="margin: 0 0 10px; color: #333;"><strong>Reason:</strong> ${data.changeReason}</p>` : ''}
            <p style="margin: 0; color: #333;"><strong>Changed At:</strong> ${changedAt}</p>
          `)}
          <p style="color: #666; font-size: 14px;">The new subscription plan is now active and features have been updated accordingly.</p>
        `),
      });

      this.logger.log(`Subscription changed notification email sent to ${this.adminEmail} for user ${data.username}`);
    } catch (error) {
      this.logger.error(
        `Failed to send subscription changed notification: ${error instanceof Error ? error.message : String(error)}`
      );
      // Don't throw - we don't want to break subscription flow if email fails
    }
  }
}
