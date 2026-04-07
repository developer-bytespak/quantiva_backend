import { Injectable, Logger } from '@nestjs/common';
import sgMail from '@sendgrid/mail';

@Injectable()
export class VcPoolEmailService {
  private readonly logger = new Logger(VcPoolEmailService.name);
  private readonly fromEmail: string;
  private readonly initialized: boolean;

  constructor() {
    const apiKey = process.env.SENDGRID_API_KEY;
    this.fromEmail = process.env.SENDGRID_FROM_EMAIL || process.env.SMTP_FROM_EMAIL || '';

    if (apiKey && this.fromEmail) {
      sgMail.setApiKey(apiKey);
      this.initialized = true;
    } else {
      this.logger.warn('SendGrid not configured for VC Pool emails');
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

  // ── 1. Join Request → Admin ──
  async sendJoinRequestToAdmin(data: {
    adminEmail: string;
    poolName: string;
    userName: string;
    userEmail: string;
    contributionAmount: number;
    coinType: string;
    paymentMethod: string;
  }): Promise<void> {
    if (!this.initialized) return;
    try {
      await sgMail.send({
        to: data.adminEmail,
        from: { email: this.fromEmail, name: 'Quantiva' },
        subject: `New VC Pool Join Request – ${data.poolName}`,
        html: this.wrapTemplate(`
          <h2 style="color: #333; margin-top: 0;">New Join Request</h2>
          <p style="color: #666; font-size: 16px;">A user has requested to join your pool <strong>${data.poolName}</strong>.</p>
          ${this.infoBox(`
            <p style="margin: 0 0 10px; color: #333;"><strong>User:</strong> ${data.userName}</p>
            <p style="margin: 0 0 10px; color: #333;"><strong>Email:</strong> ${data.userEmail}</p>
            <p style="margin: 0 0 10px; color: #333;"><strong>Amount:</strong> ${data.contributionAmount} ${data.coinType}</p>
            <p style="margin: 0; color: #333;"><strong>Payment Method:</strong> ${data.paymentMethod}</p>
          `)}
          <p style="color: #666; font-size: 14px;">Please log in to the admin panel to review and approve this request.</p>
        `),
      });
      this.logger.log(`Join request email sent to admin ${data.adminEmail} for pool ${data.poolName}`);
    } catch (error) {
      this.logger.error(`Failed to send join request email to admin: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ── 2. Join Accepted → User ──
  async sendJoinAcceptedToUser(data: {
    userEmail: string;
    userName: string;
    poolName: string;
    contributionAmount: number;
    coinType: string;
  }): Promise<void> {
    if (!this.initialized) return;
    try {
      await sgMail.send({
        to: data.userEmail,
        from: { email: this.fromEmail, name: 'Quantiva' },
        subject: `You've Been Accepted to ${data.poolName}!`,
        html: this.wrapTemplate(`
          <h2 style="color: #333; margin-top: 0;">Welcome to ${data.poolName}!</h2>
          <p style="color: #666; font-size: 16px;">Hello${data.userName ? ` ${data.userName}` : ''},</p>
          <p style="color: #666; font-size: 16px;">Great news! Your payment has been verified and you are now an official member of <strong>${data.poolName}</strong>.</p>
          ${this.infoBox(`
            <p style="margin: 0 0 10px; color: #333;"><strong>Pool:</strong> ${data.poolName}</p>
            <p style="margin: 0; color: #333;"><strong>Your Contribution:</strong> ${data.contributionAmount} ${data.coinType}</p>
          `)}
          <p style="color: #666; font-size: 16px;">You'll receive another email once the pool starts trading. Stay tuned!</p>
          <p style="color: #999; font-size: 12px; margin-top: 30px;">If you have any questions, please contact the pool admin.</p>
        `),
      });
      this.logger.log(`Join accepted email sent to user ${data.userEmail} for pool ${data.poolName}`);
    } catch (error) {
      this.logger.error(`Failed to send join accepted email: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ── 3. Exit Request → Admin ──
  async sendExitRequestToAdmin(data: {
    adminEmail: string;
    poolName: string;
    userName: string;
    userEmail: string;
    investedAmount: number;
    refundAmount: number;
    coinType: string;
  }): Promise<void> {
    if (!this.initialized) return;
    try {
      await sgMail.send({
        to: data.adminEmail,
        from: { email: this.fromEmail, name: 'Quantiva' },
        subject: `Exit Request – ${data.poolName}`,
        html: this.wrapTemplate(`
          <h2 style="color: #333; margin-top: 0;">Member Exit Request</h2>
          <p style="color: #666; font-size: 16px;">A member has requested to exit your pool <strong>${data.poolName}</strong>.</p>
          ${this.infoBox(`
            <p style="margin: 0 0 10px; color: #333;"><strong>User:</strong> ${data.userName}</p>
            <p style="margin: 0 0 10px; color: #333;"><strong>Email:</strong> ${data.userEmail}</p>
            <p style="margin: 0 0 10px; color: #333;"><strong>Invested Amount:</strong> ${data.investedAmount} ${data.coinType}</p>
            <p style="margin: 0; color: #333;"><strong>Estimated Refund:</strong> ${data.refundAmount} ${data.coinType}</p>
          `)}
          <p style="color: #666; font-size: 14px;">Please log in to the admin panel to approve or reject this exit request.</p>
        `),
      });
      this.logger.log(`Exit request email sent to admin ${data.adminEmail} for pool ${data.poolName}`);
    } catch (error) {
      this.logger.error(`Failed to send exit request email to admin: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ── 4. Exit Accepted → User ──
  async sendExitAcceptedToUser(data: {
    userEmail: string;
    userName: string;
    poolName: string;
    refundAmount: number;
    coinType: string;
  }): Promise<void> {
    if (!this.initialized) return;
    try {
      await sgMail.send({
        to: data.userEmail,
        from: { email: this.fromEmail, name: 'Quantiva' },
        subject: `Exit Request Approved – ${data.poolName}`,
        html: this.wrapTemplate(`
          <h2 style="color: #333; margin-top: 0;">Exit Request Approved</h2>
          <p style="color: #666; font-size: 16px;">Hello${data.userName ? ` ${data.userName}` : ''},</p>
          <p style="color: #666; font-size: 16px;">Your exit request from <strong>${data.poolName}</strong> has been approved.</p>
          ${this.infoBox(`
            <p style="margin: 0 0 10px; color: #333;"><strong>Pool:</strong> ${data.poolName}</p>
            <p style="margin: 0; color: #333;"><strong>Refund Amount:</strong> ${data.refundAmount} ${data.coinType}</p>
          `)}
          <p style="color: #666; font-size: 16px; font-weight: bold;">We are processing your refund and will transfer it to you as soon as possible.</p>
          <p style="color: #666; font-size: 14px;">You will receive a confirmation email once the refund has been completed.</p>
          <p style="color: #999; font-size: 12px; margin-top: 30px;">If you have any questions about your refund, please contact the pool admin.</p>
        `),
      });
      this.logger.log(`Exit accepted email sent to user ${data.userEmail} for pool ${data.poolName}`);
    } catch (error) {
      this.logger.error(`Failed to send exit accepted email: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ── 5. Pool Completed → All Members ──
  async sendPoolCompletedToMembers(data: {
    members: Array<{ email: string; name: string; netPayout: number; profitLoss: number }>;
    poolName: string;
    coinType: string;
    finalPoolValue: number;
    totalProfit: number;
  }): Promise<void> {
    if (!this.initialized) return;
    for (const member of data.members) {
      try {
        const profitColor = member.profitLoss >= 0 ? '#16a34a' : '#dc2626';
        const profitSign = member.profitLoss >= 0 ? '+' : '';
        await sgMail.send({
          to: member.email,
          from: { email: this.fromEmail, name: 'Quantiva' },
          subject: `Pool Completed – ${data.poolName}`,
          html: this.wrapTemplate(`
            <h2 style="color: #333; margin-top: 0;">Pool Completed!</h2>
            <p style="color: #666; font-size: 16px;">Hello${member.name ? ` ${member.name}` : ''},</p>
            <p style="color: #666; font-size: 16px;">The pool <strong>${data.poolName}</strong> has been completed. Here are your results:</p>
            ${this.infoBox(`
              <p style="margin: 0 0 10px; color: #333;"><strong>Pool:</strong> ${data.poolName}</p>
              <p style="margin: 0 0 10px; color: #333;"><strong>Final Pool Value:</strong> ${data.finalPoolValue.toFixed(2)} ${data.coinType}</p>
              <p style="margin: 0 0 10px; color: #333;"><strong>Your Payout:</strong> ${member.netPayout.toFixed(2)} ${data.coinType}</p>
              <p style="margin: 0; color: ${profitColor}; font-weight: bold;"><strong>Profit/Loss:</strong> ${profitSign}${member.profitLoss.toFixed(2)} ${data.coinType}</p>
            `)}
            <p style="color: #666; font-size: 16px;">The admin will process your payout soon. You'll receive a notification once the transfer is complete.</p>
            <p style="color: #999; font-size: 12px; margin-top: 30px;">Thank you for being a part of this pool!</p>
          `),
        });
        this.logger.log(`Pool completed email sent to ${member.email} for pool ${data.poolName}`);
      } catch (error) {
        this.logger.error(`Failed to send pool completed email to ${member.email}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  // ── 6. Refund Completed → User ──
  async sendRefundCompletedToUser(data: {
    userEmail: string;
    userName: string;
    poolName: string;
    refundAmount: number;
    coinType: string;
    txHash?: string;
  }): Promise<void> {
    if (!this.initialized) return;
    try {
      const txInfo = data.txHash
        ? `<p style="margin: 0; color: #333;"><strong>TX Hash:</strong> <a href="https://bscscan.com/tx/${data.txHash}" style="color: #fc4f02;">${data.txHash.substring(0, 20)}...</a></p>`
        : '';
      await sgMail.send({
        to: data.userEmail,
        from: { email: this.fromEmail, name: 'Quantiva' },
        subject: `Refund Completed – ${data.poolName}`,
        html: this.wrapTemplate(`
          <h2 style="color: #333; margin-top: 0;">Refund Completed!</h2>
          <p style="color: #666; font-size: 16px;">Hello${data.userName ? ` ${data.userName}` : ''},</p>
          <p style="color: #666; font-size: 16px;">Your refund from <strong>${data.poolName}</strong> has been processed and transferred to your wallet.</p>
          ${this.infoBox(`
            <p style="margin: 0 0 10px; color: #333;"><strong>Pool:</strong> ${data.poolName}</p>
            <p style="margin: 0 0 10px; color: #333;"><strong>Refund Amount:</strong> ${data.refundAmount} ${data.coinType}</p>
            ${txInfo}
          `)}
          <p style="color: #666; font-size: 14px;">The funds should reflect in your wallet shortly. If you have any issues, please contact the pool admin.</p>
          <p style="color: #999; font-size: 12px; margin-top: 30px;">Thank you for using Quantiva.</p>
        `),
      });
      this.logger.log(`Refund completed email sent to ${data.userEmail} for pool ${data.poolName}`);
    } catch (error) {
      this.logger.error(`Failed to send refund completed email: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ── 7. Pool Started → All Members ──
  async sendPoolStartedToMembers(data: {
    members: Array<{ email: string; name: string }>;
    poolName: string;
    coinType: string;
    totalInvested: number;
    durationDays: number;
    endDate: Date;
  }): Promise<void> {
    if (!this.initialized) return;
    const endDateStr = data.endDate.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    for (const member of data.members) {
      try {
        await sgMail.send({
          to: member.email,
          from: { email: this.fromEmail, name: 'Quantiva' },
          subject: `Pool Started – ${data.poolName} is Now Live!`,
          html: this.wrapTemplate(`
            <h2 style="color: #333; margin-top: 0;">Pool is Now Live! 🚀</h2>
            <p style="color: #666; font-size: 16px;">Hello${member.name ? ` ${member.name}` : ''},</p>
            <p style="color: #666; font-size: 16px;">The pool <strong>${data.poolName}</strong> has officially started trading!</p>
            ${this.infoBox(`
              <p style="margin: 0 0 10px; color: #333;"><strong>Pool:</strong> ${data.poolName}</p>
              <p style="margin: 0 0 10px; color: #333;"><strong>Total Invested:</strong> ${data.totalInvested} ${data.coinType}</p>
              <p style="margin: 0 0 10px; color: #333;"><strong>Duration:</strong> ${data.durationDays} days</p>
              <p style="margin: 0; color: #333;"><strong>Expected End Date:</strong> ${endDateStr}</p>
            `)}
            <p style="color: #666; font-size: 16px;">You can track your pool's performance in real-time from your dashboard.</p>
            <p style="color: #999; font-size: 12px; margin-top: 30px;">Happy trading!</p>
          `),
        });
        this.logger.log(`Pool started email sent to ${member.email} for pool ${data.poolName}`);
      } catch (error) {
        this.logger.error(`Failed to send pool started email to ${member.email}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
