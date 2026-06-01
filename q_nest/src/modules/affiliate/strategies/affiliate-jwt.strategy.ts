import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { PrismaService } from '../../../prisma/prisma.service';
import { AffiliateTokenPayload } from '../services/affiliate-token.service';

@Injectable()
export class AffiliateJwtStrategy extends PassportStrategy(
  Strategy,
  'affiliate-jwt',
) {
  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {
    const jwtConfig = configService.get('jwt');
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (request: Request) => request?.cookies?.affiliate_access_token,
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
      secretOrKey: jwtConfig.affiliateSecret,
    });
  }

  async validate(payload: AffiliateTokenPayload) {
    if (!payload || !payload.sub || payload.role !== 'affiliate') {
      throw new UnauthorizedException('Invalid affiliate token');
    }

    const affiliate = await this.prisma.affiliates.findUnique({
      where: { affiliate_id: payload.sub },
      select: { affiliate_id: true, status: true },
    });
    if (!affiliate) {
      throw new UnauthorizedException('Affiliate not found');
    }

    if (payload.session_id) {
      const session = await this.prisma.affiliate_sessions.findFirst({
        where: {
          session_id: payload.session_id,
          affiliate_id: payload.sub,
          revoked: false,
          expires_at: { gt: new Date() },
        },
      });
      if (!session) {
        throw new UnauthorizedException(
          'Affiliate session expired or revoked',
        );
      }
    }

    return {
      ...payload,
      status: affiliate.status,
    };
  }
}
