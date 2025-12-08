import { Injectable, ForbiddenException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';
import { TokenService } from './token.service';

type UserTier = 'FREE' | 'PRO' | 'ELITE' | 'INSTITUTIONAL';

const TIER_SESSION_LIMITS: Record<UserTier, number> = {
  FREE: 50,
  PRO: 5,
  ELITE: 10,
  INSTITUTIONAL: 25,
};

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

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
    // Clean up expired sessions for this user first
    await this.cleanupExpiredSessionsForUser(userId);
    
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
    // Clean up expired sessions before checking limit
    await this.cleanupExpiredSessionsForUser(userId);
    
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
    // Use updateMany to avoid throwing error if session doesn't exist
    const result = await this.prisma.user_sessions.updateMany({
      where: { 
        session_id: sessionId,
        revoked: false, // Only revoke if not already revoked
      },
      data: { revoked: true },
    });
    
    // Optionally log if session was not found (but don't throw error)
    if (result.count === 0) {
      console.warn(`Session ${sessionId} not found or already revoked`);
    }
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    // Actually delete the session from the database
    const result = await this.prisma.user_sessions.deleteMany({
      where: { session_id: sessionId },
    });
    
    if (result.count === 0) {
      console.warn(`Session ${sessionId} not found for deletion`);
      return false;
    }
    
    return true;
  }

  async revokeSessionByRefreshToken(refreshToken: string): Promise<boolean> {
    const session = await this.findSessionByRefreshToken(refreshToken);
    if (session) {
      await this.revokeSession(session.session_id);
      return true;
    }
    return false;
  }

  async findSessionByRefreshTokenAndUser(
    refreshToken: string,
    userId: string,
  ): Promise<{ session_id: string; user_id: string } | null> {
    // First, get all active sessions for this user to narrow down the search
    const now = new Date();
    const userSessions = await this.prisma.user_sessions.findMany({
      where: {
        user_id: userId,
        revoked: false,
        expires_at: {
          gt: now,
        },
        refresh_token_hash: {
          not: null,
        },
      },
    });

    // Check each session's refresh token hash
    for (const session of userSessions) {
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

  async revokeCurrentUserSession(
    userId: string,
    refreshToken?: string,
  ): Promise<void> {
    // First try to find and revoke the session by refresh token (filtered by user_id for efficiency)
    if (refreshToken) {
      const session = await this.findSessionByRefreshTokenAndUser(refreshToken, userId);
      if (session) {
        await this.revokeSession(session.session_id);
        return;
      }
    }

    // Fallback: revoke the most recent active session for this user
    // This handles cases where refresh token might be missing or invalid
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

  async revokeAllUserSessions(userId: string): Promise<void> {
    const now = new Date();
    await this.prisma.user_sessions.updateMany({
      where: {
        user_id: userId,
        revoked: false,
        expires_at: {
          gt: now,
        },
      },
      data: {
        revoked: true,
      },
    });
  }

  async findSessionByRefreshToken(
    refreshToken: string,
  ): Promise<{ session_id: string; user_id: string } | null> {
    // First, verify the JWT token is valid (not expired)
    let tokenPayload;
    try {
      tokenPayload = await this.tokenService.verifyToken(refreshToken);
    } catch (error) {
      // Token is invalid or expired, clean up any expired sessions
      await this.cleanupExpiredSessions();
      return null;
    }

    // Clean up expired sessions before searching
    await this.cleanupExpiredSessions();

    const sessions = await this.prisma.user_sessions.findMany({
      where: {
        revoked: false,
        expires_at: {
          gt: new Date(),
        },
        refresh_token_hash: {
          not: null,
        },
        user_id: tokenPayload.sub, // Only search for sessions belonging to this user
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

  async cleanupExpiredSessionsForUser(userId: string): Promise<void> {
    await this.prisma.user_sessions.deleteMany({
      where: {
        user_id: userId,
        expires_at: {
          lt: new Date(),
        },
      },
    });
  }

  async cleanupExpiredAndRevokedSessions(): Promise<void> {
    const now = new Date();
    await this.prisma.user_sessions.deleteMany({
      where: {
        OR: [
          {
            expires_at: {
              lt: now,
            },
          },
          {
            revoked: true,
            expires_at: {
              lt: now,
            },
          },
        ],
      },
    });
  }

  /**
   * Scheduled job to clean up expired sessions every hour
   * This ensures expired sessions are removed from the database
   */
  @Cron(CronExpression.EVERY_HOUR)
  async scheduledCleanupExpiredSessions(): Promise<void> {
    this.logger.log('Running scheduled cleanup of expired sessions');
    try {
      await this.cleanupExpiredSessions();
      this.logger.log('Cleaned up expired sessions');
    } catch (error: any) {
      this.logger.error(`Error cleaning up expired sessions: ${error.message}`);
    }
  }
}

