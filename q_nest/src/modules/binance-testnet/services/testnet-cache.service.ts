import { Injectable, Logger } from '@nestjs/common';

interface CacheEntry {
  data: any;
  timestamp: number;
  ttl: number;
}

@Injectable()
export class TestnetCacheService {
  private readonly logger = new Logger(TestnetCacheService.name);
  private cache: Map<string, CacheEntry> = new Map();
  private readonly defaultTTL = 5000; // 5 seconds

  /**
   * Sets a value in cache
   */
  set(key: string, data: any, ttl: number = this.defaultTTL): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl,
    });
    this.logger.debug(`Cache set: ${key} (TTL: ${ttl}ms)`);
  }

  /**
   * Gets a value from cache if it exists and hasn't expired
   */
  get(key: string): any {
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    const isExpired = Date.now() - entry.timestamp > entry.ttl;

    if (isExpired) {
      this.cache.delete(key);
      this.logger.debug(`Cache expired: ${key}`);
      return null;
    }

    this.logger.debug(`Cache hit: ${key}`);
    return entry.data;
  }

  /**
   * Deletes a value from cache
   */
  delete(key: string): boolean {
    const deleted = this.cache.delete(key);
    if (deleted) {
      this.logger.debug(`Cache deleted: ${key}`);
    }
    return deleted;
  }

  /**
   * Clears all cache entries
   */
  clear(): void {
    this.cache.clear();
    this.logger.debug('Cache cleared');
  }

  /**
   * Invalidates cache by pattern
   */
  invalidatePattern(pattern: string): void {
    let count = 0;
    for (const key of this.cache.keys()) {
      if (key.includes(pattern)) {
        this.cache.delete(key);
        count++;
      }
    }
    this.logger.debug(`Cache invalidated by pattern: ${pattern} (${count} entries)`);
  }
}
