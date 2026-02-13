import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface CacheEntry {
  value: any;
  expiresAt: number;
  createdAt: number;
}

/**
 * Enhanced in-memory cache service with:
 * - Atomic getOrSet() to prevent cache stampede
 * - Batch setMultiple() for multi-key operations
 * - Configurable TTLs per cache type
 * - Hit/miss statistics tracking
 * - In-flight request deduplication
 */
@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlightRequests = new Map<string, Promise<any>>();
  private readonly defaultTtl: number;

  // Configurable TTLs per cache type (milliseconds)
  private readonly ttlConfig: Record<string, number>;

  // Statistics
  private hits = 0;
  private misses = 0;

  constructor(private configService: ConfigService) {
    // Default TTL: 30 seconds (configurable via environment)
    this.defaultTtl = parseInt(
      this.configService.get<string>('BINANCE_CACHE_TTL', '30000'),
      10,
    );

    // Per-type TTL configuration
    this.ttlConfig = {
      'coin-detail': parseInt(this.configService.get<string>('CACHE_COIN_DETAIL_TTL', '600000'), 10),   // 10 min
      'candle': parseInt(this.configService.get<string>('CACHE_CANDLE_TTL', '300000'), 10),              // 5 min
      'connection': parseInt(this.configService.get<string>('CACHE_CONNECTION_TTL', '3600000'), 10),     // 1 hr
      'market-data': parseInt(this.configService.get<string>('CACHE_MARKET_DATA_TTL', '600000'), 10),    // 10 min
      'coingecko': parseInt(this.configService.get<string>('CACHE_COINGECKO_TTL', '600000'), 10),        // 10 min
      'orderbook': parseInt(this.configService.get<string>('CACHE_ORDERBOOK_TTL', '30000'), 10),         // 30 sec
      'trades': parseInt(this.configService.get<string>('CACHE_TRADES_TTL', '30000'), 10),               // 30 sec
    };

    this.logger.log(`Cache service initialized with default TTL: ${this.defaultTtl}ms`);
  }

  /**
   * Get TTL for a specific cache type.
   * Falls back to defaultTtl if type not configured.
   */
  getTtlForType(type: string): number {
    return this.ttlConfig[type] || this.defaultTtl;
  }

  /**
   * Gets a cached value if it exists and hasn't expired
   */
  getCached(key: string): any | null {
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      return null;
    }

    // Check if expired
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    this.hits++;
    return entry.value;
  }

  /**
   * Sets a value in cache with TTL
   */
  setCached(key: string, value: any, ttl?: number): void {
    const now = Date.now();
    this.cache.set(key, {
      value,
      expiresAt: now + (ttl || this.defaultTtl),
      createdAt: now,
    });
  }

  /**
   * Atomic get-or-set operation that prevents cache stampede.
   * If key exists in cache, returns cached value.
   * If key is missing, calls fetchFn ONCE even with concurrent requests
   * for the same key (in-flight deduplication).
   */
  async getOrSet<T>(key: string, fetchFn: () => Promise<T>, ttl?: number): Promise<T> {
    // 1. Check cache
    const cached = this.getCached(key);
    if (cached !== null) return cached as T;

    // 2. Check if another request is already in-flight for this key
    const inFlight = this.inFlightRequests.get(key);
    if (inFlight) {
      this.logger.debug(`Cache stampede prevented for key: ${key}`);
      return inFlight as Promise<T>;
    }

    // 3. Execute fetch, cache result, and track in-flight
    const fetchPromise = fetchFn()
      .then((result) => {
        this.setCached(key, result, ttl);
        this.inFlightRequests.delete(key);
        return result;
      })
      .catch((error) => {
        this.inFlightRequests.delete(key);
        throw error;
      });

    this.inFlightRequests.set(key, fetchPromise);
    return fetchPromise;
  }

  /**
   * Set multiple cache entries at once (batch operation).
   * Useful for caching multi-interval candle data in one call.
   */
  setMultiple(entries: Array<{ key: string; value: any; ttl?: number }>): void {
    const now = Date.now();
    for (const entry of entries) {
      this.cache.set(entry.key, {
        value: entry.value,
        expiresAt: now + (entry.ttl || this.defaultTtl),
        createdAt: now,
      });
    }
  }

  /**
   * Invalidates all cache entries for a connection
   */
  invalidate(connectionId: string): void {
    const keysToDelete: string[] = [];
    
    for (const key of this.cache.keys()) {
      if (key.includes(connectionId)) {
        keysToDelete.push(key);
      }
    }

    keysToDelete.forEach((key) => this.cache.delete(key));
    this.logger.debug(`Invalidated ${keysToDelete.length} cache entries for connection ${connectionId}`);
  }

  /**
   * Clears all cache entries
   */
  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
    this.logger.debug('Cache cleared');
  }

  /**
   * Gets basic cache statistics (backward compatible)
   */
  getStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }

  /**
   * Gets detailed cache statistics with hit/miss ratio
   */
  getDetailedStats(): {
    size: number;
    hits: number;
    misses: number;
    hitRate: string;
    inFlightRequests: number;
    keys: string[];
  } {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? `${((this.hits / total) * 100).toFixed(1)}%` : '0%',
      inFlightRequests: this.inFlightRequests.size,
      keys: Array.from(this.cache.keys()),
    };
  }
}

