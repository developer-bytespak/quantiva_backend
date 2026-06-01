import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';

export interface AffiliateTokenPayload {
  sub: string; // affiliate_id
  email: string;
  role: 'affiliate';
  session_id?: string;
}

@Injectable()
export class AffiliateTokenService {
  constructor(
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  async generateAccessToken(payload: AffiliateTokenPayload): Promise<string> {
    const jwtConfig = this.configService.get('jwt');
    return this.jwtService.signAsync(payload, {
      secret: jwtConfig.affiliateSecret,
      expiresIn: jwtConfig.accessTokenExpiry,
    });
  }

  async generateRefreshToken(payload: AffiliateTokenPayload): Promise<string> {
    const jwtConfig = this.configService.get('jwt');
    return this.jwtService.signAsync(payload, {
      secret: jwtConfig.affiliateSecret,
      expiresIn: jwtConfig.refreshTokenExpiry,
    });
  }

  async hashRefreshToken(token: string): Promise<string> {
    return bcrypt.hash(token, 10);
  }

  async verifyRefreshToken(token: string, hash: string): Promise<boolean> {
    return bcrypt.compare(token, hash);
  }

  async verifyToken(token: string): Promise<AffiliateTokenPayload> {
    try {
      const jwtConfig = this.configService.get('jwt');
      return await this.jwtService.verifyAsync<AffiliateTokenPayload>(token, {
        secret: jwtConfig.affiliateSecret,
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired affiliate token');
    }
  }

  decodeToken(token: string): AffiliateTokenPayload | null {
    try {
      return this.jwtService.decode(token) as AffiliateTokenPayload | null;
    } catch {
      return null;
    }
  }
}
