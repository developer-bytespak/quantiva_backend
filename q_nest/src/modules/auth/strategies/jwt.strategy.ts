import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { TokenPayload } from '../services/token.service';
import { SessionService } from '../services/session.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    private sessionService: SessionService,
  ) {
    const jwtConfig = configService.get('jwt');
    super({
      // Accept JWT from either http-only cookie (access_token) OR Authorization header (Bearer)
      jwtFromRequest: ExtractJwt.fromExtractors([
        (request: Request) => {
          return request?.cookies?.access_token;
        },
        (request: Request) => {
          const authHeader = request?.headers?.authorization as string | undefined;
          if (!authHeader) return null;
          if (authHeader.startsWith('Bearer ')) {
            return authHeader.slice(7);
          }
          return null;
        },
      ]),
      ignoreExpiration: false,
      secretOrKey: jwtConfig.secret,
    });
  }

  async validate(payload: TokenPayload) {
    if (!payload || !payload.sub) {
      throw new UnauthorizedException('Invalid token payload');
    }

    // Enforce server-side session existence so evicted sessions (e.g. oldest
    // session dropped when a new device logs in past the tier limit) cannot
    // keep using their still-unexpired access token.
    if (payload.session_id) {
      const session = await this.sessionService.findSessionById(payload.session_id);
      if (!session || session.revoked || session.expires_at <= new Date()) {
        throw new UnauthorizedException('Session revoked or expired');
      }
    }

    return {
      ...payload,
      isAdmin: payload.isAdmin ?? false,
      isSuperAdmin: payload.isSuperAdmin ?? false,
    };
  }
}
