import { Injectable, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { TokenService } from './token.service';

type UserTier = 'FREE' | 'PRO' | 'ELITE' | 'INSTITUTIONAL';

const TIER_SESSION_LIMITS: Record<UserTier, number> = {
  FREE: 2,
  PRO: 5,
  ELITE: 10,
  INSTITUTIONAL: 25,
};

@Injectable()
export class SessionService {
  constructor(
    private prisma: PrismaService,
    private tokenService: TokenService,
    private configService: ConfigService,
  ) {}

  async getUserTier(userId: string): Promise<UserTier> {
    const activeSubscription = await this.prisma.user_subscriptions.findFirst({
      where: {
        user_id: userId,
        status: 'active',
        expires_at: {
          gt: new Date(),
        },
      },
      include: {
        plan: true,
      },
    });

    if (!activeSubscription) {
      return 'FREE';
    }

    const planName = activeSubscription.plan.name.toUpperCase() as UserTier;
    return TIER_SESSION_LIMITS[planName] ? planName : 'FREE';
  }

  async getActiveSessionCount(userId: string): Promise<number> {
    const now = new Date();
    return this.prisma.user_sessions.count({
      where: {
        user_id: userId,
        revoked: false,
        expires_at: {
          gt: now,
        },
      },
    });
  }

  async checkSessionLimit(userId: string): Promise<void> {
    const tier = await this.getUserTier(userId);
    const activeCount = await this.getActiveSessionCount(userId);
    const limit = TIER_SESSION_LIMITS[tier];

    if (activeCount >= limit) {
      throw new ForbiddenException(
        `Session limit reached. Your ${tier} tier allows ${limit} concurrent sessions.`,
      );
    }
  }

  async createSession(
    userId: string,
    refreshToken: string,
    ipAddress?: string,
    deviceId?: string,
  ): Promise<string> {
    await this.checkSessionLimit(userId);

    const refreshTokenHash = await this.tokenService.hashRefreshToken(
      refreshToken,
    );
    const jwtConfig = this.configService.get('jwt');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7); // 7 days for refresh token

    const session = await this.prisma.user_sessions.create({
      data: {
        user_id: userId,
        refresh_token_hash: refreshTokenHash,
        ip_address: ipAddress,
        device_id: deviceId,
        expires_at: expiresAt,
      },
    });

    return session.session_id;
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.prisma.user_sessions.update({
      where: { session_id: sessionId },
      data: { revoked: true },
    });
  }

  async revokeSessionByRefreshToken(refreshToken: string): Promise<boolean> {
    const session = await this.findSessionByRefreshToken(refreshToken);
    if (session) {
      await this.revokeSession(session.session_id);
      return true;
    }
    return false;
  }

  async revokeCurrentUserSession(
    userId: string,
    refreshToken?: string,
  ): Promise<void> {
    // First try to revoke by refresh token if provided
    if (refreshToken) {
      const revoked = await this.revokeSessionByRefreshToken(refreshToken);
      if (revoked) {
        return;
      }
    }

    // Fallback: revoke the most recent active session for this user
    const now = new Date();
    const activeSession = await this.prisma.user_sessions.findFirst({
      where: {
        user_id: userId,
        revoked: false,
        expires_at: {
          gt: now,
        },
      },
      orderBy: {
        issued_at: 'desc',
      },
    });

    if (activeSession) {
      await this.revokeSession(activeSession.session_id);
    }
  }

  async findSessionByRefreshToken(
    refreshToken: string,
  ): Promise<{ session_id: string; user_id: string } | null> {
    const sessions = await this.prisma.user_sessions.findMany({
      where: {
        revoked: false,
        expires_at: {
          gt: new Date(),
        },
        refresh_token_hash: {
          not: null,
        },
      },
    });

    for (const session of sessions) {
      if (session.refresh_token_hash) {
        const isValid = await this.tokenService.verifyRefreshToken(
          refreshToken,
          session.refresh_token_hash,
        );
        if (isValid) {
          return {
            session_id: session.session_id,
            user_id: session.user_id,
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
    const newHash = await this.tokenService.hashRefreshToken(newRefreshToken);
    await this.prisma.user_sessions.update({
      where: { session_id: sessionId },
      data: { refresh_token_hash: newHash },
    });
  }

  async cleanupExpiredSessions(): Promise<void> {
    await this.prisma.user_sessions.deleteMany({
      where: {
        expires_at: {
          lt: new Date(),
        },
      },
    });
  }
}

