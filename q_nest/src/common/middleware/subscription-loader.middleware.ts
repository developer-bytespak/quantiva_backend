// src/common/middleware/subscription-loader.middleware.ts
import { Injectable, NestMiddleware } from '@nestjs/common';
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
      } else if (req.cookies?.access_token) {
        token = req.cookies.access_token;
      } else {
        return next();
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'default') as JwtPayload;
      const userId = decoded?.sub || decoded?.user_id || decoded?.id;

      if (!userId) {
        return next();
      }

      (req as any).userId = userId;

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

      req.subscriptionUser = {
        user_id: userId,
        subscription_id: subscription?.subscription_id || null,
        tier: subscription?.tier || 'FREE',
        billing_period: subscription?.billing_period || null,
        subscription: subscription || null,
      };

      next();
    } catch (error) {
      next();
    }
  }
}