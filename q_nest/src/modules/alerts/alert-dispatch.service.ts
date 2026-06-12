import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailSenderService } from '../onboarding-emails/services/email-sender.service';
import { TemplateRendererService } from '../onboarding-emails/services/template-renderer.service';
import { UnsubscribeTokenService } from '../onboarding-emails/services/unsubscribe-token.service';

export type AlertType = 'price_alert' | 'signal_alert';

export interface DispatchParams {
  userId: string;
  symbol: string; // used for the per-(user,symbol) cooldown
  assetId?: string | null;
  type: AlertType;
  title: string; // push + in-app
  message: string; // push + in-app
  emailTemplate: string; // template file name (without .html)
  emailVars: Record<string, string>;
  cooldownHours: number;
}

export type DispatchResult = 'sent' | 'cooldown' | 'test_skipped' | 'disabled';

/**
 * Shared dispatch for price-move + new-signal alerts.
 *
 * One place handles: the global on/off switch, the TEST-USER gate (so we can verify the whole
 * flow against a single account before enabling for everyone), the per-(user,symbol,type)
 * cooldown, and fan-out to all three channels (in-app row + FCM push + SendGrid email),
 * respecting each user's `user_settings` flags.
 *
 * The in-app notification row doubles as the cooldown marker — no Redis needed.
 */
@Injectable()
export class AlertDispatchService {
  private readonly logger = new Logger(AlertDispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly emailSender: EmailSenderService,
    private readonly renderer: TemplateRendererService,
    private readonly unsubscribeToken: UnsubscribeTokenService,
    private readonly config: ConfigService,
  ) {}

  async dispatch(params: DispatchParams): Promise<DispatchResult> {
    const { userId, symbol, assetId, type, title, message, emailTemplate, emailVars, cooldownHours } = params;

    // 1. Global kill switch
    if (this.config.get('ALERTS_ENABLED') === 'false') return 'disabled';

    // 2. Load recipient + their channel preferences (default ON if no settings row)
    const user = await this.prisma.users.findUnique({
      where: { user_id: userId },
      select: { email: true, full_name: true, settings: { select: { notifications_email: true, notifications_push: true } } },
    });
    if (!user) return 'sent'; // user gone; nothing to do

    // 3. TEST gate — when ALERTS_TEST_EMAIL is set, ONLY that account receives anything.
    // Matched by email so it's easy to configure (no user-id lookup needed).
    const testEmail = this.config.get<string>('ALERTS_TEST_EMAIL');
    if (testEmail && user.email?.toLowerCase().trim() !== testEmail.toLowerCase().trim()) {
      return 'test_skipped';
    }

    // 4. Cooldown — already alerted this (user, symbol, type) within the window?
    const since = new Date(Date.now() - cooldownHours * 60 * 60 * 1000);
    const recent = await this.prisma.notifications.findFirst({
      where: {
        user_id: userId,
        type,
        created_at: { gte: since },
        metadata: { path: ['symbol'], equals: symbol },
      },
      select: { id: true },
    });
    if (recent) return 'cooldown';

    const pushOn = user.settings?.notifications_push !== false;
    const emailOn = user.settings?.notifications_email !== false;

    // 5. In-app notification row (always — also the cooldown marker)
    await this.notifications.createNotification({
      user_id: userId,
      title,
      message,
      type,
      metadata: { symbol, assetId: assetId ?? null },
    });

    // 6. FCM push
    if (pushOn) {
      try {
        await this.notifications.sendNotification(userId, title, message);
      } catch (err: any) {
        this.logger.warn(`Push failed for ${userId}: ${err?.message ?? err}`);
      }
    }

    // 7. Email
    if (emailOn && user.email) {
      try {
        const token = await this.unsubscribeToken.sign(userId);
        const unsubscribeUrl = this.unsubscribeToken.buildUrl(userId, token);
        const firstName = (user.full_name?.split(' ')[0] || 'there').trim();
        const dashboardUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/dashboard`;
        const rendered = await this.renderer.render(emailTemplate, {
          firstName,
          dashboardUrl,
          unsubscribeUrl,
          ...emailVars,
        });
        await this.emailSender.send({
          to: user.email,
          subject: rendered.subject,
          html: rendered.html,
          unsubscribeUrl,
        });
      } catch (err: any) {
        this.logger.warn(`Email failed for ${userId}: ${err?.message ?? err}`);
      }
    }

    return 'sent';
  }
}
