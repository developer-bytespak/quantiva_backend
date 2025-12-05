import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { TokenService, TokenPayload } from './token.service';
import { SessionService } from './session.service';
import { TwoFactorService } from './two-factor.service';
import { RateLimitService } from './rate-limit.service';
import * as bcrypt from 'bcrypt';
import { RegisterDto } from '../dto/register.dto';
import { LoginDto } from '../dto/login.dto';
import { Verify2FADto } from '../dto/verify-2fa.dto';
import { ChangePasswordDto } from '../dto/change-password.dto';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private tokenService: TokenService,
    private sessionService: SessionService,
    private twoFactorService: TwoFactorService,
    private rateLimitService: RateLimitService,
  ) {}

  async register(registerDto: RegisterDto) {
    const { email, username, password } = registerDto;

    // Check if user already exists
    const existingUser = await this.prisma.users.findFirst({
      where: {
        OR: [{ email }, { username }],
      },
    });

    if (existingUser) {
      if (existingUser.email === email) {
        throw new ConflictException('Email already registered');
      }
      if (existingUser.username === username) {
        throw new ConflictException('Username already taken');
      }
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Generate TOTP secret for 2FA
    const twoFactorSecret = this.twoFactorService.generateTOTPSecret();

    // Create user
    const user = await this.prisma.users.create({
      data: {
        email,
        username,
        password_hash: passwordHash,
        two_factor_enabled: true,
        two_factor_secret: twoFactorSecret,
      },
    });

    return {
      user: {
        user_id: user.user_id,
        email: user.email,
        username: user.username,
        email_verified: user.email_verified,
        kyc_status: user.kyc_status,
      },
      message: 'User registered successfully. 2FA is enabled.',
    };
  }

  async login(loginDto: LoginDto, ipAddress?: string) {
    const { emailOrUsername, password } = loginDto;

    // Check rate limit
    if (ipAddress) {
      this.rateLimitService.checkRateLimit(ipAddress);
    }

    // Find user by email or username
    const user = await this.prisma.users.findFirst({
      where: {
        OR: [{ email: emailOrUsername }, { username: emailOrUsername }],
      },
    });

    if (!user || !user.password_hash) {
      if (ipAddress) {
        this.rateLimitService.recordFailedAttempt(ipAddress);
      }
      throw new UnauthorizedException('Invalid credentials');
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      if (ipAddress) {
        this.rateLimitService.recordFailedAttempt(ipAddress);
      }
      throw new UnauthorizedException('Invalid credentials');
    }

    // Generate and send 2FA code
    const code = await this.twoFactorService.generateCode(user.user_id, 'login');
    await this.twoFactorService.sendCodeByEmail(user.email, code);

    // Record successful attempt (clears rate limit)
    if (ipAddress) {
      this.rateLimitService.recordSuccessfulAttempt(ipAddress);
    }

    return {
      requires2FA: true,
      message: '2FA code sent to your email',
    };
  }

  async verify2FA(
    verify2FADto: Verify2FADto,
    ipAddress?: string,
    deviceId?: string,
  ) {
    const { emailOrUsername, code } = verify2FADto;

    // Find user
    const user = await this.prisma.users.findFirst({
      where: {
        OR: [{ email: emailOrUsername }, { username: emailOrUsername }],
      },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Validate 2FA code
    const isValid = await this.twoFactorService.validateCode(
      user.user_id,
      code,
      'login',
    );

    if (!isValid) {
      throw new UnauthorizedException('Invalid 2FA code');
    }

    // Create session first to get session_id
    const refreshToken = await this.tokenService.generateRefreshToken({
      sub: user.user_id,
      email: user.email,
      username: user.username,
    });
    
    const sessionId = await this.sessionService.createSession(
      user.user_id,
      refreshToken,
      ipAddress,
      deviceId,
    );

    // Generate tokens with session_id included
    const payload: TokenPayload = {
      sub: user.user_id,
      email: user.email,
      username: user.username,
      session_id: sessionId,
    };

    const accessToken = await this.tokenService.generateAccessToken(payload);

    return {
      user: {
        user_id: user.user_id,
        email: user.email,
        username: user.username,
        email_verified: user.email_verified,
        kyc_status: user.kyc_status,
      },
      accessToken,
      refreshToken,
      sessionId,
    };
  }

  async refresh(refreshToken: string) {
    // Find session by refresh token
    const session = await this.sessionService.findSessionByRefreshToken(
      refreshToken,
    );

    if (!session) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Get user
    const user = await this.prisma.users.findUnique({
      where: { user_id: session.user_id },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    // Generate new tokens with session_id included
    const newRefreshToken = await this.tokenService.generateRefreshToken({
      sub: user.user_id,
      email: user.email,
      username: user.username,
    });

    // Update session with new refresh token (rotation)
    await this.sessionService.updateSessionRefreshToken(
      session.session_id,
      newRefreshToken,
    );

    // Generate access token with session_id
    const payload: TokenPayload = {
      sub: user.user_id,
      email: user.email,
      username: user.username,
      session_id: session.session_id,
    };

    const newAccessToken = await this.tokenService.generateAccessToken(payload);

    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    };
  }

  async logout(sessionId: string) {
    await this.sessionService.revokeSession(sessionId);
    return { message: 'Logged out successfully' };
  }

  async requestPasswordChangeCode(userId: string) {
    // Get user
    const user = await this.prisma.users.findUnique({
      where: { user_id: userId },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    // Generate and send 2FA code
    const code = await this.twoFactorService.generateCode(
      userId,
      'password_change',
    );
    await this.twoFactorService.sendCodeByEmail(user.email, code);

    return {
      message: '2FA code sent to your email',
    };
  }

  async changePassword(userId: string, changePasswordDto: ChangePasswordDto) {
    const { oldPassword, newPassword, twoFactorCode } = changePasswordDto;

    // Get user
    const user = await this.prisma.users.findUnique({
      where: { user_id: userId },
    });

    if (!user || !user.password_hash) {
      throw new UnauthorizedException('User not found');
    }

    // Verify old password
    const isPasswordValid = await bcrypt.compare(
      oldPassword,
      user.password_hash,
    );
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid current password');
    }

    // Verify 2FA code
    const isValid = await this.twoFactorService.validateCode(
      userId,
      twoFactorCode,
      'password_change',
    );

    if (!isValid) {
      throw new UnauthorizedException('Invalid 2FA code');
    }

    // Hash new password
    const newPasswordHash = await bcrypt.hash(newPassword, 10);

    // Update password
    await this.prisma.users.update({
      where: { user_id: userId },
      data: { password_hash: newPasswordHash },
    });

    return { message: 'Password changed successfully' };
  }

  async getUserById(userId: string) {
    const user = await this.prisma.users.findUnique({
      where: { user_id: userId },
      select: {
        user_id: true,
        email: true,
        username: true,
        email_verified: true,
        kyc_status: true,
        created_at: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    return user;
  }
}

