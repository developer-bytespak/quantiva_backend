import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface CacheOptions {
  ttl?: number; // Time to live in seconds
}

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

@Injectable()
export class CacheManagerService {
  private readonly logger = new Logger(CacheManagerService.name);
  private readonly cache: Map<string, CacheEntry<any>> = new Map();
  private readonly defaultTTL: number;
  private readonly priceTTL: number;
  private readonly marketCapTTL: number;

  constructor(private configService: ConfigService) {
    // Default TTLs (in seconds)
    this.defaultTTL = 300; // 5 minutes
    this.priceTTL = parseInt(
      this.configService.get<string>('CACHE_TTL_PRICES') || '300',
    ); // 5 min
    this.marketCapTTL = parseInt(
      this.configService.get<string>('CACHE_TTL_MARKET_CAP') || '86400',
    ); // 24 hours

    this.logger.log(
      `Cache Manager initialized - Price TTL: ${this.priceTTL}s, Market Cap TTL: ${this.marketCapTTL}s`,
    );

    // Start cleanup interval (every 5 minutes)
    this.startCleanupInterval();
  }

  /**
   * Get value from cache
   */
  get<T>(key: string): T | null {
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    // Check if expired
    const now = Date.now();
    const age = (now - entry.timestamp) / 1000; // Convert to seconds

    if (age > entry.ttl) {
      this.cache.delete(key);
      this.logger.debug(`Cache expired for key: ${key}`);
      return null;
    }

    this.logger.debug(`Cache hit for key: ${key}`);
    return entry.data as T;
  }

  /**
   * Set value in cache
   */
  set<T>(key: string, value: T, ttl?: number): void {
    const entry: CacheEntry<T> = {
      data: value,
      timestamp: Date.now(),
      ttl: ttl || this.defaultTTL,
    };

    this.cache.set(key, entry);
    this.logger.debug(`Cache set for key: ${key}, TTL: ${entry.ttl}s`);
  }

  /**
   * Set with price TTL (5 minutes)
   */
  setPrice<T>(key: string, value: T): void {
    this.set(key, value, this.priceTTL);
  }

  /**
   * Set with market cap TTL (24 hours)
   */
  setMarketCap<T>(key: string, value: T): void {
    this.set(key, value, this.marketCapTTL);
  }

  /**
   * Invalidate (delete) a specific key
   */
  invalidate(key: string): boolean {
    const deleted = this.cache.delete(key);
    if (deleted) {
      this.logger.debug(`Cache invalidated for key: ${key}`);
    }
    return deleted;
  }

  /**
   * Invalidate all keys matching a pattern
   */
  invalidatePattern(pattern: string): number {
    let count = 0;
    const regex = new RegExp(pattern);

    for (const key of this.cache.keys()) {
      if (regex.test(key)) {
        this.cache.delete(key);
        count++;
      }
    }

    this.logger.log(`Invalidated ${count} cache entries matching: ${pattern}`);
    return count;
  }

  /**
   * Clear entire cache
   */
  clear(): void {
    const size = this.cache.size;
    this.cache.clear();
    this.logger.log(`Cache cleared - ${size} entries removed`);
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    size: number;
    keys: string[];
    expired: number;
  } {
    const now = Date.now();
    let expired = 0;

    for (const [key, entry] of this.cache.entries()) {
      const age = (now - entry.timestamp) / 1000;
      if (age > entry.ttl) {
        expired++;
      }
    }

    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
      expired,
    };
  }

  /**
   * Check if key exists and is not expired
   */
  has(key: string): boolean {
    return this.get(key) !== null;
  }

  /**
   * Get remaining TTL for a key (in seconds)
   */
  getRemainingTTL(key: string): number | null {
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    const now = Date.now();
    const age = (now - entry.timestamp) / 1000;
    const remaining = entry.ttl - age;

    return remaining > 0 ? remaining : 0;
  }

  /**
   * Start cleanup interval to remove expired entries
   */
  private startCleanupInterval(): void {
    const cleanupInterval = 5 * 60 * 1000; // 5 minutes

    setInterval(() => {
      this.cleanup();
    }, cleanupInterval);

    this.logger.log(
      `Cache cleanup interval started (every ${cleanupInterval / 1000}s)`,
    );
  }

  /**
   * Clean up expired entries
   */
  private cleanup(): void {
    const now = Date.now();
    let removed = 0;

    for (const [key, entry] of this.cache.entries()) {
      const age = (now - entry.timestamp) / 1000;
      if (age > entry.ttl) {
        this.cache.delete(key);
        removed++;
      }
    }

    if (removed > 0) {
      this.logger.log(
        `Cache cleanup completed - Removed ${removed} expired entries`,
      );
    }
  }

  /**
   * Generate cache key for market data
   */
  static generateMarketDataKey(
    symbols: string[],
    limit?: number,
  ): string {
    if (symbols.length === 0) {
      return `market:all:${limit || 'all'}`;
    }
    const sortedSymbols = symbols.sort().join(',');
    return `market:${sortedSymbols}:${limit || 'all'}`;
  }

  /**
   * Generate cache key for stock quote
   */
  static generateQuoteKey(symbol: string): string {
    return `quote:${symbol}`;
  }

  /**
   * Generate cache key for health check
   */
  static generateHealthKey(): string {
    return 'health:check';
  }
}
