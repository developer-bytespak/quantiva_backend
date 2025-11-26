import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../services/auth.service';

@Injectable()
export class TwoFactorGuard implements CanActivate {
  constructor(private authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      throw new UnauthorizedException('User not authenticated');
    }

    // Check if 2FA code is provided in request body
    const twoFactorCode = request.body?.twoFactorCode;
    if (!twoFactorCode) {
      throw new UnauthorizedException('2FA code is required');
    }

    // This guard is used for sensitive operations
    // The actual 2FA validation will be done in the service
    return true;
  }
}

