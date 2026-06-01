import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';
import { AffiliateTokenService } from './affiliate-token.service';

@Injectable()
export class AffiliateSessionService {
  private readonly logger = new Logger(AffiliateSessionService.name);

  constructor(
    private prisma: PrismaService,
    private affiliateTokenService: AffiliateTokenService,
  ) {}

  async createSession(
    affiliateId: string,
    refreshToken: string,
    ipAddress?: string,
    deviceId?: string,
  ): Promise<string> {
    const refreshTokenHash =
      await this.affiliateTokenService.hashRefreshToken(refreshToken);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    const session = await this.prisma.affiliate_sessions.create({
      data: {
        affiliate_id: affiliateId,
        refresh_token_hash: refreshTokenHash,
        ip_address: ipAddress,
        device_id: deviceId,
        expires_at: expiresAt,
      },
    });

    return session.session_id;
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.prisma.affiliate_sessions.updateMany({
      where: { session_id: sessionId, revoked: false },
      data: { revoked: true },
    });
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const result = await this.prisma.affiliate_sessions.deleteMany({
      where: { session_id: sessionId },
    });
    return result.count > 0;
  }

  async findSessionByRefreshToken(
    refreshToken: string,
  ): Promise<{ session_id: string; affiliate_id: string } | null> {
    let tokenPayload;
    try {
      tokenPayload = await this.affiliateTokenService.verifyToken(refreshToken);
    } catch {
      return null;
    }

    if (tokenPayload.role !== 'affiliate') return null;

    const sessions = await this.prisma.affiliate_sessions.findMany({
      where: {
        affiliate_id: tokenPayload.sub,
        revoked: false,
        expires_at: { gt: new Date() },
        refresh_token_hash: { not: null },
      },
    });

    for (const session of sessions) {
      if (session.refresh_token_hash) {
        const isValid = await this.affiliateTokenService.verifyRefreshToken(
          refreshToken,
          session.refresh_token_hash,
        );
        if (isValid) {
          return {
            session_id: session.session_id,
            affiliate_id: session.affiliate_id,
          };
        }
      }
    }

    return null;
  }

  async updateSessionRefreshToken(
    sessionId: string,
    newRefreshToken: string,
  ): Promise<void> {
    const newHash =
      await this.affiliateTokenService.hashRefreshToken(newRefreshToken);
    await this.prisma.affiliate_sessions.update({
      where: { session_id: sessionId },
      data: { refresh_token_hash: newHash },
    });
  }

  async revokeAllAffiliateSessions(affiliateId: string): Promise<void> {
    await this.prisma.affiliate_sessions.updateMany({
      where: {
        affiliate_id: affiliateId,
        revoked: false,
        expires_at: { gt: new Date() },
      },
      data: { revoked: true },
    });
  }

  @Cron(CronExpression.EVERY_HOUR)
  async cleanupExpiredSessions(): Promise<void> {
    this.logger.log('Cleaning up expired affiliate sessions');
    try {
      await this.prisma.affiliate_sessions.deleteMany({
        where: { expires_at: { lt: new Date() } },
      });
    } catch (error: any) {
      this.logger.error(
        `Error cleaning up affiliate sessions: ${error.message}`,
      );
    }
  }
}
