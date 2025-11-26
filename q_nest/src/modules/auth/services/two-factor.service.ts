import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { Resend } from 'resend';
import * as speakeasy from 'speakeasy';

@Injectable()
export class TwoFactorService {
  private resend: Resend;

  constructor(private prisma: PrismaService) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      throw new Error('RESEND_API_KEY is not set in environment variables');
    }
    this.resend = new Resend(apiKey);
  }

  generateTOTPSecret(): string {
    return speakeasy.generateSecret({
      name: 'Quantiva',
      length: 32,
    }).base32;
  }

  async generateCode(userId: string, purpose: string): Promise<string> {
    // Generate 6-digit code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + 10); // 10 minutes expiry

    await this.prisma.two_factor_codes.create({
      data: {
        user_id: userId,
        code,
        expires_at: expiresAt,
        purpose,
      },
    });

    return code;
  }

  async sendCodeByEmail(email: string, code: string): Promise<void> {
    try {
      await this.resend.emails.send({
        from: 'noreply@quantiva.com', // Update with your verified domain
        to: email,
        subject: 'Your Quantiva 2FA Code',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Your Two-Factor Authentication Code</h2>
            <p>Your verification code is:</p>
            <div style="background-color: #f4f4f4; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 5px; margin: 20px 0;">
              ${code}
            </div>
            <p>This code will expire in 10 minutes.</p>
            <p>If you didn't request this code, please ignore this email.</p>
          </div>
        `,
      });
    } catch (error) {
      throw new BadRequestException('Failed to send 2FA code email');
    }
  }

  async validateCode(
    userId: string,
    code: string,
    purpose: string,
  ): Promise<boolean> {
    const twoFactorCode = await this.prisma.two_factor_codes.findFirst({
      where: {
        user_id: userId,
        code,
        purpose,
        used: false,
        expires_at: {
          gt: new Date(),
        },
      },
    });

    if (!twoFactorCode) {
      return false;
    }

    // Mark code as used
    await this.prisma.two_factor_codes.update({
      where: { code_id: twoFactorCode.code_id },
      data: { used: true },
    });

    return true;
  }

  async validateTOTP(secret: string, token: string): Promise<boolean> {
    return speakeasy.totp.verify({
      secret,
      encoding: 'base32',
      token,
      window: 2, // Allow 2 time steps (60 seconds) of tolerance
    });
  }

  async cleanupExpiredCodes(): Promise<void> {
    await this.prisma.two_factor_codes.deleteMany({
      where: {
        expires_at: {
          lt: new Date(),
        },
      },
    });
  }
}

