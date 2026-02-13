// src/common/guards/subscription.guard.ts
import { Injectable, CanActivate, ExecutionContext, Logger } from '@nestjs/common';
import { FeatureAccessService } from '../feature-access.service';

@Injectable()
export class SubscriptionGuard implements CanActivate {
  private logger = new Logger(SubscriptionGuard.name);

  constructor(private readonly featureAccessService: FeatureAccessService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    try {
      if (!request.user || !request.user.sub) {
        return true; // Let auth handle
      }

      const userId = request.user.sub;
      const subscription =
        await this.featureAccessService.getActiveSubscription(userId);

      // Attach to request
      request.subscription = subscription;
      request.tier = subscription?.tier || 'FREE';

      return true;
    } catch (error) {
      this.logger.error(`Subscription guard error: ${error.message}`);
      return false;
    }
  }
}