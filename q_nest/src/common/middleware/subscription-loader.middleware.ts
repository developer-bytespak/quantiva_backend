// src/common/middleware/subscription-loader.middleware.ts
import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import jwt, { JwtPayload } from 'jsonwebtoken';

declare global {
  namespace Express {
    interface Request {
      subscriptionUser?: {
        user_id?: string;
        subscription_id?: string;
        tier?: string;
        billing_period?: string;
        subscription?: any;
      };
    }
  }
}

@Injectable()
export class SubscriptionLoaderMiddleware implements NestMiddleware {
  private logger = new Logger(SubscriptionLoaderMiddleware.name);

  constructor(
    private readonly prisma: PrismaService,
  ) {}

   async use(req: Request, res: Response, next: NextFunction) {
    try {
      // 1. Authorization header se token nikalo, warna cookie fallback use karo
      const authHeader = req.headers.authorization as string | undefined;
      let token: string | undefined;

      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
        this.logger.debug('Using token from Authorization header');
      } else if (req.cookies?.access_token) {
        token = req.cookies.access_token;
        this.logger.debug('Using token from access_token cookie');
      } else {
        this.logger.debug('No Authorization header or access_token cookie found');
        return next();
      }
      
      // 3. Token verify karo
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'default') as JwtPayload;
      const userId = decoded?.sub || decoded?.user_id || decoded?.id;

      if (!userId) {
        this.logger.warn('No user_id found in JWT token');
        return next();
      }

      // console.log(`User ID: ${userId}`);
      (req as any).userId = userId;
      console.log(`User ID middleware: ${userId}`);

      this.logger.debug(`Loading subscription for user: ${userId}`);

      // 4. Database se subscription data nikalo
      const subscription = await this.prisma.user_subscriptions.findFirst({
        where: {
          user_id: userId,
          status: 'active'
        },
        include: {
          plan: {
            include: {
              plan_features: true,
            },
          },
        },
      });

      this.logger.debug(`Subscription data loaded: ${subscription ? 'Found active subscription' : 'No active subscription'}`);

      // 5. req.subscriptionUser mein inject karo
      req.subscriptionUser = {
        user_id: userId,
        subscription_id: subscription?.subscription_id || null,
        tier: subscription?.tier || 'FREE',
        billing_period: subscription?.billing_period || null,
        subscription: subscription || null,
      };

      this.logger.debug(`Subscription loaded - Tier: ${req.subscriptionUser.tier}, Has Subscription: ${!!subscription}`);
      next();
    } catch (error) {
      // Token invalid ho to sirf next karo
      this.logger.error(`Middleware error: ${error.message}`);
      next();
    }
  }
}