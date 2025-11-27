import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import sgMail from '@sendgrid/mail';
import * as speakeasy from 'speakeasy';

@Injectable()
export class TwoFactorService {
  private readonly logger = new Logger(TwoFactorService.name);

  constructor(private prisma: PrismaService) {
    // Initialize SendGrid with API key
    const apiKey = process.env.SENDGRID_API_KEY;
    
    if (!apiKey) {
      this.logger.error('SENDGRID_API_KEY is not set in environment variables');
      throw new Error('SENDGRID_API_KEY is required for email service');
    }

    sgMail.setApiKey(apiKey);
    this.logger.log('SendGrid API initialized successfully');
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
      const fromEmail = process.env.SENDGRID_FROM_EMAIL || process.env.SMTP_FROM_EMAIL;
      
      if (!fromEmail) {
        throw new Error('SENDGRID_FROM_EMAIL or SMTP_FROM_EMAIL is not set in environment variables');
      }

      this.logger.log(`Sending 2FA code to ${email} from ${fromEmail}`);

      const msg = {
        to: email,
        from: {
          email: fromEmail,
          name: 'Quantiva',
        },
        subject: 'Your Quantiva 2FA Code',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="background: linear-gradient(135deg, #fc4f02 0%, #fda300 100%); padding: 30px; border-radius: 10px 10px 0 0;">
              <h1 style="color: white; margin: 0; text-align: center;">Quantiva</h1>
            </div>
            <div style="background: #ffffff; padding: 30px; border-radius: 0 0 10px 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
              <h2 style="color: #333; margin-top: 0;">Your Two-Factor Authentication Code</h2>
              <p style="color: #666; font-size: 16px;">Your verification code is:</p>
              <div style="background-color: #f4f4f4; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 5px; margin: 20px 0; border-radius: 8px; border: 2px dashed #fc4f02;">
                ${code}
              </div>
              <p style="color: #666; font-size: 14px;">This code will expire in 10 minutes.</p>
              <p style="color: #999; font-size: 12px; margin-top: 30px;">If you didn't request this code, please ignore this email.</p>
            </div>
          </div>
        `,
      };

      const [response] = await sgMail.send(msg);

      this.logger.log(`2FA email sent successfully`, {
        email,
        messageId: response.headers['x-message-id'],
        statusCode: response.statusCode,
        from: fromEmail,
      });
    } catch (error: any) {
      this.logger.error(`Failed to send 2FA code email`, {
        email,
        error: error?.message || String(error),
        response: error?.response?.body,
        stack: error instanceof Error ? error.stack : undefined,
      });
      
      throw new BadRequestException(
        `Failed to send 2FA code email: ${error?.message || 'Unknown error'}`,
      );
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

