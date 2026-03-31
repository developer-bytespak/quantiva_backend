// src/common/middleware/subscription-loader.middleware.ts
import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { Cron } from '@nestjs/schedule';

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

interface CacheEntry {
  data: {
    user_id?: string;
    subscription_id?: string;
    tier?: string;
    billing_period?: string;
    subscription?: any;
  };
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

@Injectable()
export class SubscriptionLoaderMiddleware implements NestMiddleware {
  private readonly logger = new Logger(SubscriptionLoaderMiddleware.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly prisma: PrismaService,
  ) {}

  async use(req: Request, res: Response, next: NextFunction) {
    try {
      // 1. Extract token from Authorization header or cookie
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

      // 2. Check cache first — skip DB if cached and not expired
      const cached = this.cache.get(userId);
      if (cached && Date.now() < cached.expiresAt) {
        req.subscriptionUser = cached.data;
        return next();
      }

      // 3. Cache miss — query database
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

      const userData = {
        user_id: userId,
        subscription_id: subscription?.subscription_id || null,
        tier: subscription?.tier || 'FREE',
        billing_period: subscription?.billing_period || null,
        subscription: subscription || null,
      };

      // 4. Store in cache with TTL
      this.cache.set(userId, {
        data: userData,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });

      req.subscriptionUser = userData;
      next();
    } catch (error) {
      next();
    }
  }

  /**
   * Clear cached subscription for a specific user.
   * Call this when a user's subscription changes (upgrade, downgrade, cancel).
   */
  clearUserCache(userId: string): void {
    this.cache.delete(userId);
  }

  /**
   * Hourly cleanup of expired cache entries to prevent memory growth.
   */
  @Cron('0 * * * *')
  cleanupExpiredCache(): void {
    const now = Date.now();
    let evicted = 0;
    for (const [key, entry] of this.cache) {
      if (now >= entry.expiresAt) {
        this.cache.delete(key);
        evicted++;
      }
    }
    if (evicted > 0) {
      this.logger.log(`Subscription cache cleanup: evicted ${evicted} expired entries, ${this.cache.size} remaining`);
    }
  }
}
