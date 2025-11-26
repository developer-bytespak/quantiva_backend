import { Injectable, UnauthorizedException, CanActivate, ExecutionContext } from '@nestjs/common';

@Injectable()
export class RefreshTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const refreshToken = request?.cookies?.refresh_token;

    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token not found');
    }

    // Attach refresh token to request for use in controller
    (request as any).refreshToken = refreshToken;
    return true;
  }
}

