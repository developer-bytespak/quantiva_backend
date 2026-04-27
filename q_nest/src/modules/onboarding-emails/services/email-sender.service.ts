import { Injectable, Logger } from '@nestjs/common';
import sgMail from '@sendgrid/mail';

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  unsubscribeUrl: string;
}

export interface SendEmailResult {
  ok: boolean;
  error?: string;
}

@Injectable()
export class EmailSenderService {
  private readonly logger = new Logger(EmailSenderService.name);
  private readonly fromEmail: string;
  private readonly initialized: boolean;

  constructor() {
    const apiKey = process.env.SENDGRID_API_KEY;
    this.fromEmail = process.env.SENDGRID_FROM_EMAIL || process.env.SMTP_FROM_EMAIL || '';

    if (apiKey && this.fromEmail) {
      sgMail.setApiKey(apiKey);
      this.initialized = true;
    } else {
      this.logger.warn('SendGrid not configured for onboarding drip emails');
      this.initialized = false;
    }
  }

  async send(params: SendEmailParams): Promise<SendEmailResult> {
    if (!this.initialized) {
      return { ok: false, error: 'sendgrid_not_configured' };
    }

    try {
      await sgMail.send({
        to: params.to,
        from: { email: this.fromEmail, name: 'Quantiva' },
        subject: params.subject,
        html: params.html,
        // RFC 8058 — Gmail/Outlook one-click unsubscribe
        headers: {
          'List-Unsubscribe': `<${params.unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      });
      return { ok: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`SendGrid send failed for ${params.to}: ${msg}`);
      return { ok: false, error: msg };
    }
  }
}
