import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

const PURPOSE = 'onboarding_unsubscribe';

interface UnsubscribePayload {
  sub: string;
  purpose: typeof PURPOSE;
}

@Injectable()
export class UnsubscribeTokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async sign(userId: string): Promise<string> {
    const jwtConfig = this.config.get<{ secret: string }>('jwt');
    return this.jwt.signAsync(
      { sub: userId, purpose: PURPOSE },
      { secret: jwtConfig!.secret, expiresIn: '60d' },
    );
  }

  async verify(token: string): Promise<string> {
    try {
      const jwtConfig = this.config.get<{ secret: string }>('jwt');
      const payload = await this.jwt.verifyAsync<UnsubscribePayload>(token, {
        secret: jwtConfig!.secret,
      });
      if (payload.purpose !== PURPOSE) {
        throw new UnauthorizedException('Invalid unsubscribe token');
      }
      return payload.sub;
    } catch {
      throw new UnauthorizedException('Invalid or expired unsubscribe token');
    }
  }

  buildUrl(userId: string, token: string): string {
    const frontend = process.env.FRONTEND_URL || 'http://localhost:3000';
    return `${frontend}/unsubscribe?token=${encodeURIComponent(token)}`;
  }
}
