// src/common/guards/tier-access.guard.ts
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FeatureAccessService } from '../feature-access.service';
import { ALLOWED_TIERS_KEY } from '../decorators/allow-tier.decorator';

@Injectable()
export class TierAccessGuard implements CanActivate {
  private logger = new Logger(TierAccessGuard.name);

  constructor(
    private reflector: Reflector,
    private featureAccessService: FeatureAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const allowedTiers = this.reflector.get<string[]>(
      ALLOWED_TIERS_KEY,
      context.getHandler(),
    );

    if (!allowedTiers || allowedTiers.length === 0) {
      return true; // No restriction
    }

    const request = context.switchToHttp().getRequest();

    if (!request.user || !request.user.sub) {
      throw new ForbiddenException('Authentication required');
    }

    const userId = request.user.sub;
    const userTier = await this.featureAccessService.getUserTier(userId);

    this.logger.debug(
      `Tier check: User ${userId} has ${userTier}, allowed: ${allowedTiers}`,
    );

    if (!allowedTiers.includes(userTier)) {
      throw new ForbiddenException(
        `This feature requires one of: ${allowedTiers.join(', ')}. You have ${userTier}.`,
      );
    }

    return true;
  }
}