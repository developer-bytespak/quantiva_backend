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

    // Admin JWT (from AdminOrUserJwtGuard) bypasses tier check
    if (request.user.role === 'admin') {
      return true;
    }

    const userId = request.user.sub;
    const userTier = await this.featureAccessService.getUserTier(userId);

    this.logger.debug(
      `Tier check: User ${userId} has ${userTier}, allowed: ${allowedTiers}`,
    );

    // ELITE_PLUS is a superset of ELITE — if ELITE is allowed, ELITE_PLUS is too
    const effectiveAllowed = allowedTiers.includes('ELITE')
      ? [...allowedTiers, 'ELITE_PLUS']
      : allowedTiers;

    if (!effectiveAllowed.includes(userTier)) {
      const requiredPlans = allowedTiers.map(formatPlanName);
      const requiredText =
        requiredPlans.length === 1
          ? `the ${requiredPlans[0]} subscription plan`
          : `one of these subscription plans: ${requiredPlans.join(', ')}`;

      throw new ForbiddenException(
        `This feature requires ${requiredText}. You're currently on the ${formatPlanName(userTier)} subscription plan. Please upgrade to continue.`,
      );
    }

    return true;
  }
}

/**
 * Converts a raw tier identifier (e.g. "ELITE_PLUS") into a human-friendly
 * subscription plan name (e.g. "Elite Plus").
 */
function formatPlanName(tier: string): string {
  return tier
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}