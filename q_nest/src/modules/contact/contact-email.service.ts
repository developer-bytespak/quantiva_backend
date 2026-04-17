import { Injectable, Logger } from '@nestjs/common';
import sgMail from '@sendgrid/mail';

interface ContactAdminEmailPayload {
  name: string;
  email: string;
  company?: string | null;
  phone?: string | null;
  subject: string;
  message: string;
  source: string;
  
  createdAt: Date;
}

@Injectable()
export class ContactEmailService {
  private readonly logger = new Logger(ContactEmailService.name);
  private readonly initialized: boolean;
  private readonly fromEmail: string;
  private readonly adminEmail: string;

  constructor() {
    const apiKey = process.env.SENDGRID_API_KEY;
    this.fromEmail = process.env.SENDGRID_FROM_EMAIL || process.env.SMTP_FROM_EMAIL || '';
    this.adminEmail =  process.env.CONTACT_ADMIN_EMAIL || 'support@quantivahq.com';

    if (apiKey && this.fromEmail) {
      sgMail.setApiKey(apiKey);
      this.initialized = true;
    } else {
      this.logger.warn('SendGrid not configured for contact admin emails');
      this.initialized = false;
    }
  }

  async sendAdminContactNotification(payload: ContactAdminEmailPayload): Promise<void> {
    if (!this.initialized) {
      this.logger.warn('Contact email skipped: email service not configured');
      return;
    }

    const contactEmailTimezone = process.env.CONTACT_EMAIL_TIMEZONE || 'Asia/Karachi';
    let readableSubmittedAt = payload.createdAt.toLocaleString('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });

    try {
      readableSubmittedAt = new Intl.DateTimeFormat('en-US', {
        dateStyle: 'full',
        timeStyle: 'long',
        timeZone: contactEmailTimezone,
      }).format(payload.createdAt);
    } catch {
      // Keep fallback locale string if timezone is invalid
    }

    const escaped = {
      name: this.escapeHtml(payload.name),
      email: this.escapeHtml(payload.email),
      company: this.escapeHtml(payload.company || 'N/A'),
      phone: this.escapeHtml(payload.phone || 'N/A'),
      subject: this.escapeHtml(payload.subject),
      source: this.escapeHtml(payload.source),
      
      message: this.escapeHtml(payload.message).replace(/\n/g, '<br/>'),
      createdAt: this.escapeHtml(`${readableSubmittedAt} (${contactEmailTimezone})`),
    };

    try {
      await sgMail.send({
        to: this.adminEmail,
        from: {
          email: this.fromEmail,
          name: 'Quantiva',
        },
        replyTo: {
          email: payload.email,
          name: payload.name,
        },
        subject: payload.source === 'help-support'
          ? `Help & Support From ${payload.name} - ${payload.subject}`
          : `New Contact Query From ${payload.name} - ${payload.subject}`,
        html: this.wrapTemplate(`
          <h2 style="color: #333; margin-top: 0;">New Contact Form Submission</h2>
          <p style="color: #666; font-size: 15px;">A new query has been submitted from <strong>${escaped.source}</strong>.</p>

          ${this.infoBox(`
            <p style="margin: 0 0 8px;"><strong>Name:</strong> ${escaped.name}</p>
            <p style="margin: 0 0 8px;"><strong>Email:</strong> ${escaped.email}</p>
            <p style="margin: 0 0 8px;"><strong>Company:</strong> ${escaped.company}</p>
            <p style="margin: 0 0 8px;"><strong>Phone:</strong> ${escaped.phone}</p>
            <p style="margin: 0 0 8px;"><strong>Subject:</strong> ${escaped.subject}</p> 
            <p style="margin: 0;"><strong>Submitted At:</strong> ${escaped.createdAt}</p>
          `)}

          <h3 style="color: #333; margin: 24px 0 10px;">Message</h3>
          <div style="background: #f8f8f8; border: 1px solid #ececec; border-radius: 8px; padding: 14px; color: #333; line-height: 1.6;">
            ${escaped.message}
          </div>
        `),
      });

      this.logger.log(`Contact notification email sent to admin ${this.adminEmail}`);
    } catch (error) {
      this.logger.error(`Failed to send contact notification email: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private wrapTemplate(body: string): string {
    return `
      <div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto; padding: 20px;">
        <div style="background: linear-gradient(135deg, #fc4f02 0%, #fda300 100%); padding: 24px; border-radius: 10px 10px 0 0;">
          <h1 style="color: white; margin: 0; text-align: center;">Quantiva</h1>
        </div>
        <div style="background: #ffffff; padding: 24px; border-radius: 0 0 10px 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.08);">
          ${body}
        </div>
      </div>
    `;
  }

  private infoBox(content: string): string {
    return `<div style="background: #f8f8f8; border: 1px solid #ececec; border-radius: 8px; padding: 14px; margin: 18px 0; color: #333;">${content}</div>`;
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}
