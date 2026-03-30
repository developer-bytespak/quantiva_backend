/**
 * Shared pagination utilities for all services.
 *
 * Usage in service:
 *   const { take, skip } = parsePagination(page, limit);
 *   const [data, total] = await this.prisma.$transaction([
 *     this.prisma.model.findMany({ take, skip, ... }),
 *     this.prisma.model.count({ where }),
 *   ]);
 *   return paginate(data, total, page, limit);
 *
 * Usage in controller:
 *   @Query('page') page?: string,
 *   @Query('limit') limit?: string,
 *   ...
 *   return this.service.findAll(toNum(page), toNum(limit));
 */

export interface PaginatedResponse<T> {
  data: T[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * Parse and clamp page/limit values into safe take/skip for Prisma.
 */
export function parsePagination(
  page?: number,
  limit?: number,
): { take: number; skip: number; page: number; limit: number } {
  const p = Math.max(page || DEFAULT_PAGE, 1);
  const l = Math.min(Math.max(limit || DEFAULT_LIMIT, 1), MAX_LIMIT);
  return { take: l, skip: (p - 1) * l, page: p, limit: l };
}

/**
 * Wrap a data array + total count into a standardised paginated response.
 */
export function paginate<T>(
  data: T[],
  total: number,
  page?: number,
  limit?: number,
): PaginatedResponse<T> {
  const p = Math.max(page || DEFAULT_PAGE, 1);
  const l = Math.min(Math.max(limit || DEFAULT_LIMIT, 1), MAX_LIMIT);
  return {
    data,
    meta: {
      total,
      page: p,
      limit: l,
      totalPages: Math.ceil(total / l) || 1,
    },
  };
}
