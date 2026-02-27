import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';

@Injectable()
export class AdminOrUserJwtGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private jwtService: JwtService,
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractToken(request);
    if (!token) {
      throw new UnauthorizedException('Authentication required');
    }

    const jwtConfig = this.configService.get('jwt');
    let payload: { sub?: string; role?: string; [k: string]: any };
    try {
      payload = await this.jwtService.verifyAsync(token, {
        secret: jwtConfig.secret,
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    if (!payload?.sub) {
      throw new UnauthorizedException('Invalid token payload');
    }

    if (payload.role === 'admin') {
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
    }

    request.user = payload;
    return true;
  }

  private extractToken(request: Request): string | null {
    const authHeader = request.headers?.authorization as string | undefined;
    if (authHeader?.startsWith('Bearer ')) {
      return authHeader.slice(7);
    }
    const cookies = request?.cookies;
    if (cookies?.admin_access_token) return cookies.admin_access_token;
    if (cookies?.access_token) return cookies.access_token;
    return null;
  }
}
