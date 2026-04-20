import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';

export interface TokenPayload {
  sub: string; // user_id
  email: string;
  username: string;
  session_id?: string; // Optional for backward compatibility, but should be included for new tokens
  isAdmin?: boolean;
  isSuperAdmin?: boolean;
}

@Injectable()
export class TokenService {
  constructor(
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  async generateAccessToken(payload: TokenPayload): Promise<string> {
    const jwtConfig = this.configService.get('jwt');
    return this.jwtService.signAsync(payload, {
      secret: jwtConfig.secret,
      expiresIn: jwtConfig.accessTokenExpiry,
    });
  }

  async generateRefreshToken(payload: TokenPayload): Promise<string> {
    const jwtConfig = this.configService.get('jwt');
    return this.jwtService.signAsync(payload, {
      secret: jwtConfig.secret,
      expiresIn: jwtConfig.refreshTokenExpiry,
    });
  }

  async hashRefreshToken(token: string): Promise<string> {
    return bcrypt.hash(token, 10);
  }

  async verifyRefreshToken(token: string, hash: string): Promise<boolean> {
    return bcrypt.compare(token, hash);
  }

  async verifyToken(token: string): Promise<TokenPayload> {
    try {
      const jwtConfig = this.configService.get('jwt');
      const payload = await this.jwtService.verifyAsync<TokenPayload>(token, {
        secret: jwtConfig.secret,
      });
      return payload;
    } catch (error) {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  async generatePasswordResetToken(userId: string): Promise<string> {
    const jwtConfig = this.configService.get('jwt');
    return this.jwtService.signAsync(
      { sub: userId, purpose: 'password_reset' },
      { secret: jwtConfig.secret, expiresIn: '10m' },
    );
  }

  async verifyPasswordResetToken(token: string): Promise<string> {
    try {
      const jwtConfig = this.configService.get('jwt');
      const payload = await this.jwtService.verifyAsync<{ sub: string; purpose: string }>(token, {
        secret: jwtConfig.secret,
      });
      if (payload.purpose !== 'password_reset') {
        throw new UnauthorizedException('Invalid reset token');
      }
      return payload.sub;
    } catch (error) {
      throw new UnauthorizedException('Invalid or expired reset token');
    }
  }

  decodeToken(token: string): TokenPayload | null {
    try {
      const payload = this.jwtService.decode(token) as TokenPayload;
      return payload || null;
    } catch (error) {
      return null;
    }
  }
}

