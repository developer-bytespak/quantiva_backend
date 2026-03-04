import { Injectable, UnauthorizedException, CanActivate, ExecutionContext } from '@nestjs/common';

/**
 * Extracts refresh token from cookie (same-origin) or request body (cross-origin fallback).
 * When frontend and backend are on different origins, cookies may not be sent,
 * so the client can send { refreshToken: "..." } in the body so refresh still works.
 */
@Injectable()
export class RefreshTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const fromCookie = request?.cookies?.refresh_token;
    const fromBody =
      request?.body &&
      typeof request.body === 'object' &&
      typeof (request.body as { refreshToken?: string }).refreshToken === 'string'
        ? (request.body as { refreshToken: string }).refreshToken.trim()
        : '';
    const refreshToken = fromBody || fromCookie;

    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token not found');
    }

    (request as any).refreshToken = refreshToken;
    return true;
  }
}

