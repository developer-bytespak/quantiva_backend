import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';
import { AdminTokenService } from './admin-token.service';

@Injectable()
export class AdminSessionService {
  private readonly logger = new Logger(AdminSessionService.name);

  constructor(
    private prisma: PrismaService,
    private adminTokenService: AdminTokenService,
    private configService: ConfigService,
  ) {}

  async createSession(
    adminId: string,
    refreshToken: string,
    ipAddress?: string,
    deviceId?: string,
  ): Promise<string> {
    const refreshTokenHash =
      await this.adminTokenService.hashRefreshToken(refreshToken);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    const session = await this.prisma.admin_sessions.create({
      data: {
        admin_id: adminId,
        refresh_token_hash: refreshTokenHash,
        ip_address: ipAddress,
        device_id: deviceId,
        expires_at: expiresAt,
      },
    });

    return session.session_id;
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.prisma.admin_sessions.updateMany({
      where: { session_id: sessionId, revoked: false },
      data: { revoked: true },
    });
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const result = await this.prisma.admin_sessions.deleteMany({
      where: { session_id: sessionId },
    });
    return result.count > 0;
  }

  async findSessionByRefreshToken(
    refreshToken: string,
  ): Promise<{ session_id: string; admin_id: string } | null> {
    let tokenPayload;
    try {
      tokenPayload = await this.adminTokenService.verifyToken(refreshToken);
    } catch {
      return null;
    }

    if (tokenPayload.role !== 'admin') return null;

    const sessions = await this.prisma.admin_sessions.findMany({
      where: {
        admin_id: tokenPayload.sub,
        revoked: false,
        expires_at: { gt: new Date() },
        refresh_token_hash: { not: null },
      },
    });

    for (const session of sessions) {
      if (session.refresh_token_hash) {
        const isValid = await this.adminTokenService.verifyRefreshToken(
          refreshToken,
          session.refresh_token_hash,
        );
        if (isValid) {
          return {
            session_id: session.session_id,
            admin_id: session.admin_id,
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
      await this.adminTokenService.hashRefreshToken(newRefreshToken);
    await this.prisma.admin_sessions.update({
      where: { session_id: sessionId },
      data: { refresh_token_hash: newHash },
    });
  }

  async revokeAllAdminSessions(adminId: string): Promise<void> {
    await this.prisma.admin_sessions.updateMany({
      where: {
        admin_id: adminId,
        revoked: false,
        expires_at: { gt: new Date() },
      },
      data: { revoked: true },
    });
  }

  @Cron(CronExpression.EVERY_HOUR)
  async cleanupExpiredSessions(): Promise<void> {
    this.logger.log('Cleaning up expired admin sessions');
    try {
      await this.prisma.admin_sessions.deleteMany({
        where: { expires_at: { lt: new Date() } },
      });
    } catch (error: any) {
      this.logger.error(
        `Error cleaning up admin sessions: ${error.message}`,
      );
    }
  }
}
