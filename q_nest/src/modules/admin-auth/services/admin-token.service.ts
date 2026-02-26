import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';

export interface AdminTokenPayload {
  sub: string; // admin_id
  email: string;
  role: 'admin';
  session_id?: string;
}

@Injectable()
export class AdminTokenService {
  constructor(
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  async generateAccessToken(payload: AdminTokenPayload): Promise<string> {
    const jwtConfig = this.configService.get('jwt');
    return this.jwtService.signAsync(payload, {
      secret: jwtConfig.secret,
      expiresIn: jwtConfig.accessTokenExpiry,
    });
  }

  async generateRefreshToken(payload: AdminTokenPayload): Promise<string> {
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

  async verifyToken(token: string): Promise<AdminTokenPayload> {
    try {
      const jwtConfig = this.configService.get('jwt');
      return await this.jwtService.verifyAsync<AdminTokenPayload>(token, {
        secret: jwtConfig.secret,
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired admin token');
    }
  }

  decodeToken(token: string): AdminTokenPayload | null {
    try {
      return this.jwtService.decode(token) as AdminTokenPayload | null;
    } catch {
      return null;
    }
  }
}
