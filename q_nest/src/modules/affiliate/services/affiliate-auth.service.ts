import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomInt } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AffiliateTokenPayload,
  AffiliateTokenService,
} from './affiliate-token.service';
import { AffiliateSessionService } from './affiliate-session.service';
import { AffiliateEmailService } from './affiliate-email.service';
import { AffiliateSignupDto } from '../dto/affiliate-signup.dto';
import { AffiliateLoginDto } from '../dto/affiliate-login.dto';

@Injectable()
export class AffiliateAuthService {
  private readonly logger = new Logger(AffiliateAuthService.name);

  constructor(
    private prisma: PrismaService,
    private affiliateTokenService: AffiliateTokenService,
    private affiliateSessionService: AffiliateSessionService,
    private affiliateEmailService: AffiliateEmailService,
  ) {}

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  /**
   * Generate a 6-digit email-verification code, invalidate any prior unused
   * codes for this email, persist the new one (10-min expiry), and email it.
   * Public/unauthenticated — never reveals whether the email is already taken.
   */
  async sendEmailCode(email: string): Promise<{ message: string }> {
    const normalized = this.normalizeEmail(email);
    const code = randomInt(100000, 1000000).toString();
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + 10);

    // Invalidate any outstanding codes for this email so only the latest works.
    await this.prisma.affiliate_email_codes.updateMany({
      where: { email: normalized, used: false },
      data: { used: true },
    });

    await this.prisma.affiliate_email_codes.create({
      data: { email: normalized, code, expires_at: expiresAt },
    });

    await this.affiliateEmailService.sendVerificationCode({
      email: normalized,
      code,
    });

    return { message: 'Verification code sent. Check your inbox.' };
  }

  /**
   * Validate a code for an email. On success, mark the row `verified` and
   * extend its window so the applicant has time to finish the form; the row is
   * only consumed (`used=true`) once signup completes.
   */
  async verifyEmailCode(
    email: string,
    code: string,
  ): Promise<{ verified: true }> {
    const normalized = this.normalizeEmail(email);
    const row = await this.prisma.affiliate_email_codes.findFirst({
      where: {
        email: normalized,
        code,
        used: false,
        verified: false,
        expires_at: { gt: new Date() },
      },
      orderBy: { created_at: 'desc' },
    });

    if (!row) {
      throw new BadRequestException('Invalid or expired verification code');
    }

    const extended = new Date();
    extended.setMinutes(extended.getMinutes() + 30);
    await this.prisma.affiliate_email_codes.update({
      where: { code_id: row.code_id },
      data: { verified: true, expires_at: extended },
    });

    return { verified: true };
  }

  async signup(
    dto: AffiliateSignupDto,
    ipAddress?: string,
    deviceId?: string,
  ) {
    // Email must have been verified via sendEmailCode + verifyEmailCode first.
    const normalizedEmail = this.normalizeEmail(dto.email);
    const verifiedCode = await this.prisma.affiliate_email_codes.findFirst({
      where: {
        email: normalizedEmail,
        verified: true,
        used: false,
        expires_at: { gt: new Date() },
      },
      orderBy: { created_at: 'desc' },
    });
    if (!verifiedCode) {
      throw new BadRequestException(
        'Please verify your email before submitting your application',
      );
    }

    const existing = await this.prisma.affiliates.findFirst({
      where: {
        OR: [{ email: dto.email }, { display_name: dto.displayName }],
      },
      select: { affiliate_id: true, email: true, display_name: true },
    });

    if (existing) {
      if (existing.email === dto.email) {
        throw new ConflictException('Email already registered');
      }
      throw new ConflictException('Display name already taken');
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);

    const affiliate = await this.prisma.$transaction(async (tx) => {
      const created = await tx.affiliates.create({
        data: {
          email: dto.email,
          display_name: dto.displayName,
          password_hash: passwordHash,
          full_name: dto.fullName,
          country: dto.country,
          tax_residency: dto.taxResidency,
          email_verified: true,
        },
      });

      await tx.affiliate_applications.create({
        data: {
          affiliate_id: created.affiliate_id,
          primary_channel: dto.primaryChannel,
          primary_channel_custom_name: dto.primaryChannelCustomName,
          channel_url: dto.channelUrl,
          additional_channels:
            dto.additionalChannels && dto.additionalChannels.length > 0
              ? (dto.additionalChannels as unknown as object)
              : undefined,
          audience_size: dto.audienceSize,
          pitch: dto.pitch,
          ip_address: ipAddress,
          device_id: deviceId,
        },
      });

      await tx.affiliate_audit_log.create({
        data: {
          affiliate_id: created.affiliate_id,
          action: 'AFFILIATE_APPLICATION_SUBMITTED',
          metadata: {
            email: dto.email,
            primary_channel: dto.primaryChannel,
            audience_size: dto.audienceSize ?? null,
          },
        },
      });

      // Consume the verification code so it can't be reused for another signup.
      await tx.affiliate_email_codes.update({
        where: { code_id: verifiedCode.code_id },
        data: { used: true },
      });

      return created;
    });

    this.logger.log(
      `New affiliate application received: ${affiliate.email} (${affiliate.affiliate_id})`,
    );
    // Fire-and-forget transactional email; internal try/catch.
    await this.affiliateEmailService.sendApplicationReceived({
      email: affiliate.email,
      displayName: affiliate.display_name,
    });

    // Auto-login the applicant so they land on /affiliate/pending
    return this.issueSession(affiliate.affiliate_id, ipAddress, deviceId);
  }

  async login(
    dto: AffiliateLoginDto,
    ipAddress?: string,
    deviceId?: string,
  ) {
    const affiliate = await this.prisma.affiliates.findUnique({
      where: { email: dto.email },
    });
    if (!affiliate) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isPasswordValid = await bcrypt.compare(
      dto.password,
      affiliate.password_hash,
    );
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (affiliate.status === 'REJECTED' || affiliate.status === 'SUSPENDED') {
      throw new UnauthorizedException(
        'This affiliate account is not active. Contact support if you believe this is a mistake.',
      );
    }

    return this.issueSession(affiliate.affiliate_id, ipAddress, deviceId);
  }

  async refresh(refreshToken: string) {
    const session =
      await this.affiliateSessionService.findSessionByRefreshToken(
        refreshToken,
      );

    if (!session) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const affiliate = await this.prisma.affiliates.findUnique({
      where: { affiliate_id: session.affiliate_id },
      select: { affiliate_id: true, email: true, status: true },
    });
    if (!affiliate) {
      throw new UnauthorizedException('Affiliate not found');
    }

    if (
      affiliate.status === 'REJECTED' ||
      affiliate.status === 'SUSPENDED'
    ) {
      throw new UnauthorizedException('Affiliate account is not active');
    }

    const basePayload: AffiliateTokenPayload = {
      sub: affiliate.affiliate_id,
      email: affiliate.email,
      role: 'affiliate',
    };

    const newRefreshToken =
      await this.affiliateTokenService.generateRefreshToken(basePayload);

    await this.affiliateSessionService.updateSessionRefreshToken(
      session.session_id,
      newRefreshToken,
    );

    const newExpiresAt = new Date();
    newExpiresAt.setDate(newExpiresAt.getDate() + 7);
    await this.prisma.affiliate_sessions.update({
      where: { session_id: session.session_id },
      data: { expires_at: newExpiresAt },
    });

    const newAccessToken = await this.affiliateTokenService.generateAccessToken(
      {
        ...basePayload,
        session_id: session.session_id,
      },
    );

    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    };
  }

  async logout(sessionId: string) {
    await this.affiliateSessionService.deleteSession(sessionId);
    return { message: 'Affiliate logged out successfully' };
  }

  async getAffiliateById(affiliateId: string) {
    const affiliate = await this.prisma.affiliates.findUnique({
      where: { affiliate_id: affiliateId },
      select: {
        affiliate_id: true,
        email: true,
        display_name: true,
        full_name: true,
        country: true,
        tax_residency: true,
        referral_code: true,
        status: true,
        commission_pct: true,
        payout_instructions: true,
        pending_balance: true,
        paid_total: true,
        clawed_back_total: true,
        signup_count: true,
        conversion_count: true,
        revenue_generated: true,
        last_activity_at: true,
        created_at: true,
        application: {
          select: {
            primary_channel: true,
            channel_url: true,
            audience_size: true,
            pitch: true,
            status: true,
            rejection_reason: true,
            reviewed_at: true,
          },
        },
      },
    });

    if (!affiliate) {
      throw new UnauthorizedException('Affiliate not found');
    }

    return affiliate;
  }

  private async issueSession(
    affiliateId: string,
    ipAddress?: string,
    deviceId?: string,
  ) {
    const affiliate = await this.prisma.affiliates.findUnique({
      where: { affiliate_id: affiliateId },
      select: {
        affiliate_id: true,
        email: true,
        display_name: true,
        status: true,
        referral_code: true,
      },
    });
    if (!affiliate) {
      throw new UnauthorizedException('Affiliate not found');
    }

    const basePayload: AffiliateTokenPayload = {
      sub: affiliate.affiliate_id,
      email: affiliate.email,
      role: 'affiliate',
    };

    const refreshToken =
      await this.affiliateTokenService.generateRefreshToken(basePayload);

    const sessionId = await this.affiliateSessionService.createSession(
      affiliate.affiliate_id,
      refreshToken,
      ipAddress,
      deviceId,
    );

    const accessToken = await this.affiliateTokenService.generateAccessToken({
      ...basePayload,
      session_id: sessionId,
    });

    return {
      affiliate: {
        affiliate_id: affiliate.affiliate_id,
        email: affiliate.email,
        display_name: affiliate.display_name,
        status: affiliate.status,
        referral_code: affiliate.referral_code,
      },
      accessToken,
      refreshToken,
      sessionId,
    };
  }
}
