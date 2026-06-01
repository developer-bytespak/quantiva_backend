import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

@Injectable()
export class AffiliateAttributionService {
  private readonly logger = new Logger(AffiliateAttributionService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Attribute a freshly-signed-up user to an affiliate based on the referral code
   * captured in their cookie (or manually entered on the signup form).
   *
   * Wrapped in try/catch — attribution must never block signup. The caller passes
   * the new user's id, the code (may be undefined/empty/invalid — all are no-ops),
   * and request context for the fraud-velocity audit trail.
   */
  async attribute(params: {
    userId: string;
    referralCode?: string | null;
    ipAddress?: string;
    deviceId?: string;
  }): Promise<void> {
    const code = params.referralCode?.trim();
    if (!code) return;

    try {
      const affiliate = await this.prisma.affiliates.findUnique({
        where: { referral_code: code },
        select: {
          affiliate_id: true,
          email: true,
          status: true,
        },
      });
      if (!affiliate || affiliate.status !== 'APPROVED') {
        this.logger.debug(
          `Attribution skipped: code "${code}" did not resolve to an APPROVED affiliate`,
        );
        return;
      }

      const user = await this.prisma.users.findUnique({
        where: { user_id: params.userId },
        select: { email: true },
      });
      if (
        user &&
        affiliate.email.toLowerCase() === user.email.toLowerCase()
      ) {
        this.logger.warn(
          `Attribution blocked: self-referral attempt by affiliate ${affiliate.affiliate_id}`,
        );
        return;
      }

      const existing = await this.prisma.affiliate_referrals.findUnique({
        where: { user_id: params.userId },
      });
      if (existing) return;

      const settings = await this.prisma.affiliate_program_settings.findFirst({
        where: { is_active: true },
        orderBy: { version: 'desc' },
      });

      if (settings) {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const recent = await this.prisma.affiliate_referrals.count({
          where: {
            affiliate_id: affiliate.affiliate_id,
            attributed_at: { gte: since },
          },
        });
        if (recent >= settings.affiliate_signup_velocity_24h) {
          this.logger.warn(
            `Velocity flag: affiliate ${affiliate.affiliate_id} exceeded 24h signup limit (${recent}); skipping attribution`,
          );
          await this.prisma.affiliate_audit_log.create({
            data: {
              affiliate_id: affiliate.affiliate_id,
              action: 'AFFILIATE_VELOCITY_FLAG',
              metadata: {
                user_id: params.userId,
                recent_signups_24h: recent,
                threshold: settings.affiliate_signup_velocity_24h,
              },
            },
          });
          return;
        }
      }

      await this.prisma.$transaction(async (tx) => {
        await tx.affiliate_referrals.create({
          data: {
            affiliate_id: affiliate.affiliate_id,
            user_id: params.userId,
            referral_code: code,
            source: 'signup',
          },
        });
        await tx.users.update({
          where: { user_id: params.userId },
          data: { referred_by_affiliate_id: affiliate.affiliate_id },
        });
        await tx.affiliates.update({
          where: { affiliate_id: affiliate.affiliate_id },
          data: {
            signup_count: { increment: 1 },
            last_activity_at: new Date(),
          },
        });
        await tx.affiliate_audit_log.create({
          data: {
            affiliate_id: affiliate.affiliate_id,
            action: 'AFFILIATE_ATTRIBUTION',
            metadata: {
              user_id: params.userId,
              referral_code: code,
              source: 'signup',
              ip_address: params.ipAddress ?? null,
              device_id: params.deviceId ?? null,
            },
          },
        });
      });

      this.logger.log(
        `Attributed user ${params.userId} to affiliate ${affiliate.affiliate_id} (code: ${code})`,
      );
    } catch (err: any) {
      this.logger.error(
        `Affiliate attribution failed for user ${params.userId}: ${err?.message ?? err}`,
      );
    }
  }
}
