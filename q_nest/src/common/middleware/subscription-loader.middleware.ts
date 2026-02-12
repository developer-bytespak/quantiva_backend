// src/common/middleware/subscription-loader.middleware.ts
import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { FeatureAccessService } from '../feature-access.service';

declare global {
  namespace Express {
    interface Request {
      subscription?: any;
      tier?: string;
    }
  }
}

@Injectable()
export class SubscriptionLoaderMiddleware implements NestMiddleware {
  private logger = new Logger(SubscriptionLoaderMiddleware.name);

  constructor(private readonly featureAccessService: FeatureAccessService) {}

  async use(req: Request, res: Response, next: NextFunction) {
    try {
      // Only process if user is authenticated
      const user = req.user as any;
      if (!user || !user.sub) {
        return next();
      }

      const userId = user.sub;

      // Load subscription
      const subscription =
        await this.featureAccessService.getActiveSubscription(userId);
      
      // Attach to request
      req.subscription = subscription;

      // Attach tier info
      if (subscription) {
        req.tier = subscription.tier;
      } else {
        req.tier = 'FREE';
      }

      this.logger.debug(
        `[${req.method} ${req.path}] User ${userId} - Tier: ${req.tier}`,
      );
    } catch (error) {
      this.logger.error(
        `Error loading subscription for user: ${error.message}`,
      );
      // Don't fail request, just log
    }

    next();
  }
}