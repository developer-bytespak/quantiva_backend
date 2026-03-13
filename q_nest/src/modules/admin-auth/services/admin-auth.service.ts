import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AdminTokenService, AdminTokenPayload } from './admin-token.service';
import { AdminSessionService } from './admin-session.service';
import { AdminLoginDto } from '../dto/admin-login.dto';
import { AdminChangePasswordDto } from '../dto/admin-change-password.dto';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AdminAuthService {
  constructor(
    private prisma: PrismaService,
    private adminTokenService: AdminTokenService,
    private adminSessionService: AdminSessionService,
  ) {}

  async login(loginDto: AdminLoginDto, ipAddress?: string, deviceId?: string) {
    const { email, password } = loginDto;

    const admin = await this.prisma.admins.findUnique({ where: { email } });
    if (!admin) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isPasswordValid = await bcrypt.compare(password, admin.password_hash);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const basePayload: AdminTokenPayload = {
      sub: admin.admin_id,
      email: admin.email,
      role: 'admin',
    };

    const refreshToken =
      await this.adminTokenService.generateRefreshToken(basePayload);

    const sessionId = await this.adminSessionService.createSession(
      admin.admin_id,
      refreshToken,
      ipAddress,
      deviceId,
    );

    const accessToken = await this.adminTokenService.generateAccessToken({
      ...basePayload,
      session_id: sessionId,
    });

    return {
      admin: {
        admin_id: admin.admin_id,
        email: admin.email,
        full_name: admin.full_name,
      },
      accessToken,
      refreshToken,
      sessionId,
    };
  }

  async refresh(refreshToken: string) {
    const session =
      await this.adminSessionService.findSessionByRefreshToken(refreshToken);

    if (!session) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const admin = await this.prisma.admins.findUnique({
      where: { admin_id: session.admin_id },
    });
    if (!admin) {
      throw new UnauthorizedException('Admin not found');
    }

    const basePayload: AdminTokenPayload = {
      sub: admin.admin_id,
      email: admin.email,
      role: 'admin',
    };

    const newRefreshToken =
      await this.adminTokenService.generateRefreshToken(basePayload);

    await this.adminSessionService.updateSessionRefreshToken(
      session.session_id,
      newRefreshToken,
    );

    const newExpiresAt = new Date();
    newExpiresAt.setDate(newExpiresAt.getDate() + 7);
    await this.prisma.admin_sessions.update({
      where: { session_id: session.session_id },
      data: { expires_at: newExpiresAt },
    });

    const newAccessToken = await this.adminTokenService.generateAccessToken({
      ...basePayload,
      session_id: session.session_id,
    });

    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    };
  }

  async logout(sessionId: string) {
    await this.adminSessionService.deleteSession(sessionId);
    return { message: 'Admin logged out successfully' };
  }

  async getAdminById(adminId: string) {
    const admin = await this.prisma.admins.findUnique({
      where: { admin_id: adminId },
      select: {
        admin_id: true,
        email: true,
        full_name: true,
        binance_uid: true,
        wallet_address: true,
        payment_network: true,
        default_pool_fee_percent: true,
        default_admin_profit_fee_percent: true,
        default_cancellation_fee_percent: true,
        default_payment_window_minutes: true,
        created_at: true,
      },
    });

    if (!admin) {
      throw new UnauthorizedException('Admin not found');
    }

    return admin;
  }

  async changePassword(adminId: string, dto: AdminChangePasswordDto) {
    const admin = await this.prisma.admins.findUnique({
      where: { admin_id: adminId },
      select: { admin_id: true, password_hash: true },
    });

    if (!admin) {
      throw new UnauthorizedException('Admin not found');
    }

    const isPasswordValid = await bcrypt.compare(
      dto.oldPassword,
      admin.password_hash,
    );
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid current password');
    }

    const newPasswordHash = await bcrypt.hash(dto.newPassword, 10);
    await this.prisma.admins.update({
      where: { admin_id: adminId },
      data: { password_hash: newPasswordHash },
    });

    return { message: 'Password changed successfully' };
  }
}
