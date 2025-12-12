import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

@Injectable()
export class StrategyCacheService {
  private readonly logger = new Logger(StrategyCacheService.name);
  private preBuiltStrategiesCache: {
    data: any[];
    timestamp: number;
  } | null = null;
  private strategyCache: Map<string, { data: any; timestamp: number }> =
    new Map();
  private readonly PRE_BUILT_TTL = 60 * 60 * 1000; // 1 hour
  private readonly STRATEGY_TTL = 5 * 60 * 1000; // 5 minutes

  constructor(private prisma: PrismaService) {}

  /**
   * Get pre-built strategies (cached)
   */
  async getPreBuiltStrategies(): Promise<any[]> {
    if (
      this.preBuiltStrategiesCache &&
      Date.now() - this.preBuiltStrategiesCache.timestamp < this.PRE_BUILT_TTL
    ) {
      return this.preBuiltStrategiesCache.data;
    }

    // Fetch from database
    const strategies = await this.prisma.strategies.findMany({
      where: {
        type: 'admin',
        is_active: true,
      },
      orderBy: {
        created_at: 'asc',
      },
    });

    // Update cache
    this.preBuiltStrategiesCache = {
      data: strategies,
      timestamp: Date.now(),
    };

    return strategies;
  }

  /**
   * Get strategy by ID (cached)
   */
  async getStrategyById(strategyId: string): Promise<any | null> {
    const cached = this.strategyCache.get(strategyId);
    if (cached && Date.now() - cached.timestamp < this.STRATEGY_TTL) {
      return cached.data;
    }

    // Fetch from database
    const strategy = await this.prisma.strategies.findUnique({
      where: {
        strategy_id: strategyId,
      },
    });

    if (strategy) {
      this.strategyCache.set(strategyId, {
        data: strategy,
        timestamp: Date.now(),
      });
    }

    return strategy;
  }

  /**
   * Invalidate cache for a strategy
   */
  invalidateStrategy(strategyId: string): void {
    this.strategyCache.delete(strategyId);
    this.preBuiltStrategiesCache = null; // Invalidate pre-built cache too
  }

  /**
   * Invalidate all caches
   */
  invalidateAll(): void {
    this.strategyCache.clear();
    this.preBuiltStrategiesCache = null;
  }

  /**
   * Clean up old cache entries
   */
  cleanup(): void {
    const now = Date.now();
    for (const [key, value] of this.strategyCache.entries()) {
      if (now - value.timestamp >= this.STRATEGY_TTL * 2) {
        this.strategyCache.delete(key);
      }
    }
  }
}

