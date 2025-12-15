import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { TokenPayload } from '../services/token.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private configService: ConfigService) {
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
    return payload;
  }
}

