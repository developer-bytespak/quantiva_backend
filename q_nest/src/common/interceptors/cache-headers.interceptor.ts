import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap } from 'rxjs';
import { Response } from 'express';

/**
 * Metadata key for cache control configuration
 */
export const CACHE_CONTROL_KEY = 'cache_control';

/**
 * Decorator to set Cache-Control headers on specific routes.
 *
 * @example
 * @CacheControl({ maxAge: 300, staleWhileRevalidate: 60, public: true })
 * @Get('connections/:connectionId/coin/:symbol')
 * async getCoinDetail() { ... }
 */
export const CacheControl = (options: CacheControlOptions) =>
  SetMetadata(CACHE_CONTROL_KEY, options);

export interface CacheControlOptions {
  /** Max-age in seconds */
  maxAge?: number;
  /** Stale-while-revalidate in seconds */
  staleWhileRevalidate?: number;
  /** Whether the response is publicly cacheable */
  public?: boolean;
  /** Whether the response must not be cached */
  noCache?: boolean;
  /** Whether the response must not be stored */
  noStore?: boolean;
}

/**
 * Interceptor that adds HTTP Cache-Control headers to responses
 * based on @CacheControl() decorator metadata.
 *
 * Usage:
 * 1. Apply globally in module or controller level
 * 2. Decorate endpoints with @CacheControl({ maxAge: 300 })
 *
 * If no @CacheControl() decorator is present, no header is added.
 */
@Injectable()
export class CacheHeadersInterceptor implements NestInterceptor {
  constructor(private reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const options = this.reflector.get<CacheControlOptions>(
      CACHE_CONTROL_KEY,
      context.getHandler(),
    );

    if (!options) {
      return next.handle();
    }

    return next.handle().pipe(
      tap(() => {
        const response = context.switchToHttp().getResponse<Response>();
        const header = this.buildCacheControlHeader(options);
        if (header) {
          response.setHeader('Cache-Control', header);
        }
      }),
    );
  }

  private buildCacheControlHeader(options: CacheControlOptions): string {
    const parts: string[] = [];

    if (options.noStore) {
      return 'no-store';
    }

    if (options.noCache) {
      parts.push('no-cache');
    }

    if (options.public) {
      parts.push('public');
    } else {
      parts.push('private');
    }

    if (options.maxAge !== undefined) {
      parts.push(`max-age=${options.maxAge}`);
    }

    if (options.staleWhileRevalidate !== undefined) {
      parts.push(`stale-while-revalidate=${options.staleWhileRevalidate}`);
    }

    return parts.join(', ');
  }
}
