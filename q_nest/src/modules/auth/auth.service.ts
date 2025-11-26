import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService) {}

  async validateUser(email: string, password: string) {
    const user = await this.prisma.users.findUnique({
      where: { email },
    });

    if (user && user.password_hash) {
      // TODO: Implement password verification
      return user;
    }
    return null;
  }

  async createSession(userId: string, expiresAt: Date) {
    return this.prisma.user_sessions.create({
      data: {
        user_id: userId,
        expires_at: expiresAt,
      },
    });
  }

  async revokeSession(sessionId: string) {
    return this.prisma.user_sessions.update({
      where: { session_id: sessionId },
      data: { revoked: true },
    });
  }

  async findSession(sessionId: string) {
    return this.prisma.user_sessions.findUnique({
      where: { session_id: sessionId },
      include: { user: true },
    });
  }
}

