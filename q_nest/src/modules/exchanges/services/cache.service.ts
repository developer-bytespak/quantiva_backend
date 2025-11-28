import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface CacheEntry {
  value: any;
  expiresAt: number;
}

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly defaultTtl: number;

  constructor(private configService: ConfigService) {
    // Default TTL: 8 seconds (configurable via environment)
    this.defaultTtl = parseInt(
      this.configService.get<string>('BINANCE_CACHE_TTL', '8000'),
      10,
    );
    this.logger.log(`Cache service initialized with TTL: ${this.defaultTtl}ms`);
  }

  /**
   * Gets a cached value if it exists and hasn't expired
   */
  getCached(key: string): any | null {
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    // Check if expired
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    return entry.value;
  }

  /**
   * Sets a value in cache with TTL
   */
  setCached(key: string, value: any, ttl?: number): void {
    const expiresAt = Date.now() + (ttl || this.defaultTtl);
    this.cache.set(key, {
      value,
      expiresAt,
    });
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
    this.logger.debug('Cache cleared');
  }

  /**
   * Gets cache statistics
   */
  getStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }
}

