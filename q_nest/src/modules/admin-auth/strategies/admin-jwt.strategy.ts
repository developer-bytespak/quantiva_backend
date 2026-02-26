import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { PrismaService } from '../../../prisma/prisma.service';
import { AdminTokenPayload } from '../services/admin-token.service';

@Injectable()
export class AdminJwtStrategy extends PassportStrategy(Strategy, 'admin-jwt') {
  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {
    const jwtConfig = configService.get('jwt');
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (request: Request) => request?.cookies?.admin_access_token,
        (request: Request) => {
          const authHeader = request?.headers?.authorization as
            | string
            | undefined;
          if (!authHeader) return null;
          if (authHeader.startsWith('Bearer ')) return authHeader.slice(7);
          return null;
        },
      ]),
      ignoreExpiration: false,
      secretOrKey: jwtConfig.secret,
    });
  }

  async validate(payload: AdminTokenPayload) {
    if (!payload || !payload.sub || payload.role !== 'admin') {
      throw new UnauthorizedException('Invalid admin token');
    }

    const admin = await this.prisma.admins.findUnique({
      where: { admin_id: payload.sub },
    });
    if (!admin) {
      throw new UnauthorizedException('Admin not found');
    }

    if (payload.session_id) {
      const session = await this.prisma.admin_sessions.findFirst({
        where: {
          session_id: payload.session_id,
          admin_id: payload.sub,
          revoked: false,
          expires_at: { gt: new Date() },
        },
      });
      if (!session) {
        throw new UnauthorizedException('Admin session expired or revoked');
      }
    }

    return payload;
  }
}
