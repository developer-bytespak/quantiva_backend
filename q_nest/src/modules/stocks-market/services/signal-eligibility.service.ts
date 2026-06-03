import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Computes `signal_eligible` boolean for every stock daily.
 *
 * Eligibility rules (Decision 1 — Smart, v1):
 *   - Latest market_cap ≥ $100M           (skip micro-caps)
 *   - 30-day avg dollar volume ≥ $1M      (skip illiquid)
 *
 * Deferred to v2 (chicken-and-egg with signal generation):
 *   - News article count ≥ 3 in last 30 days
 *   - Foreign ADR English-coverage check
 *
 * The stock signals cron filters `WHERE signal_eligible = true` before
 * picking stocks to process, dramatically reducing wasted compute on
 * junk-tail stocks at Option B scale.
 */
@Injectable()
export class SignalEligibilityService {
  private readonly logger = new Logger(SignalEligibilityService.name);
  private static readonly MARKET_CAP_FLOOR = 100_000_000;       // $100M
  private static readonly DOLLAR_VOLUME_FLOOR = 1_000_000;      // $1M / day

  constructor(private prisma: PrismaService) {}

  /** Daily 5 AM UTC — recompute signal_eligible for the entire universe. */
  @Cron('0 5 * * *', { name: 'signal-eligibility', timeZone: 'UTC' })
  async runDailyCron() {
    try {
      const summary = await this.recomputeEligibility();
      this.logger.log(
        `Signal eligibility recompute: ${summary.eligible} eligible, ${summary.ineligible} ineligible (out of ${summary.totalConsidered} stocks)`,
      );
    } catch (err: any) {
      this.logger.error(`Signal eligibility cron failed: ${err.message}`, err.stack);
    }
  }

  /**
   * Recompute signal_eligible for every active stock and return a summary.
   * Idempotent — running multiple times produces the same result.
   *
   * Volume check strictness controlled by env var OPTION_B_STRICT_VOLUME_CHECK:
   *   - false (default): NULL volume passes (most new stocks have NULL until Alpaca data accumulates)
   *   - true: NULL volume fails (use after 30+ days of Alpaca data is available)
   */
  async recomputeEligibility(): Promise<{
    totalConsidered: number;
    eligible: number;
    ineligible: number;
    failedMarketCap: number;
    failedVolume: number;
  }> {
    const strictVolume = process.env.OPTION_B_STRICT_VOLUME_CHECK === 'true';

    // Single round-trip: compute eligibility for every active stock and
    // bulk-update assets.signal_eligible in one statement.
    const updated = await this.prisma.$executeRaw`
      WITH latest_market AS (
        SELECT DISTINCT ON (asset_id)
          asset_id, market_cap, price_usd
        FROM market_rankings
        ORDER BY asset_id, rank_timestamp DESC
      ),
      avg_volume_30d AS (
        SELECT
          asset_id,
          AVG(volume_24h * price_usd) AS avg_dollar_volume
        FROM market_rankings
        WHERE rank_timestamp > NOW() - INTERVAL '30 days'
          AND volume_24h > 0
          AND price_usd > 0
        GROUP BY asset_id
      ),
      eligibility AS (
        SELECT
          a.asset_id,
          (COALESCE(lm.market_cap, 0) >= ${SignalEligibilityService.MARKET_CAP_FLOOR}::numeric
           AND (
             -- soft mode (default): NULL volume passes
             (NOT ${strictVolume}::boolean AND (av.avg_dollar_volume IS NULL OR av.avg_dollar_volume >= ${SignalEligibilityService.DOLLAR_VOLUME_FLOOR}::numeric))
             OR
             -- strict mode: NULL volume fails
             (${strictVolume}::boolean AND COALESCE(av.avg_dollar_volume, 0) >= ${SignalEligibilityService.DOLLAR_VOLUME_FLOOR}::numeric)
           )
          ) AS is_eligible
        FROM assets a
        LEFT JOIN latest_market lm ON lm.asset_id = a.asset_id
        LEFT JOIN avg_volume_30d av ON av.asset_id = a.asset_id
        WHERE a.asset_type = 'stock' AND a.is_active = true
      )
      UPDATE assets a
      SET signal_eligible = e.is_eligible
      FROM eligibility e
      WHERE a.asset_id = e.asset_id
        AND a.signal_eligible IS DISTINCT FROM e.is_eligible
    `;

    // Counts after the update.
    const counts = await this.prisma.$queryRaw<Array<{
      total: bigint;
      eligible: bigint;
      ineligible: bigint;
      failed_cap: bigint;
      failed_vol: bigint;
    }>>`
      WITH latest_market AS (
        SELECT DISTINCT ON (asset_id) asset_id, market_cap, price_usd
        FROM market_rankings ORDER BY asset_id, rank_timestamp DESC
      ),
      avg_volume_30d AS (
        SELECT asset_id, AVG(volume_24h * price_usd) AS avg_dollar_volume
        FROM market_rankings
        WHERE rank_timestamp > NOW() - INTERVAL '30 days'
          AND volume_24h > 0 AND price_usd > 0
        GROUP BY asset_id
      )
      SELECT
        COUNT(*)::bigint AS total,
        COUNT(*) FILTER (WHERE a.signal_eligible)::bigint AS eligible,
        COUNT(*) FILTER (WHERE NOT a.signal_eligible)::bigint AS ineligible,
        COUNT(*) FILTER (WHERE COALESCE(lm.market_cap, 0) < ${SignalEligibilityService.MARKET_CAP_FLOOR}::numeric)::bigint AS failed_cap,
        COUNT(*) FILTER (WHERE COALESCE(av.avg_dollar_volume, 0) < ${SignalEligibilityService.DOLLAR_VOLUME_FLOOR}::numeric)::bigint AS failed_vol
      FROM assets a
      LEFT JOIN latest_market lm ON lm.asset_id = a.asset_id
      LEFT JOIN avg_volume_30d av ON av.asset_id = a.asset_id
      WHERE a.asset_type = 'stock' AND a.is_active = true
    `;

    const row = counts[0];
    this.logger.log(`Rows actually updated: ${updated}`);

    return {
      totalConsidered: Number(row.total),
      eligible: Number(row.eligible),
      ineligible: Number(row.ineligible),
      failedMarketCap: Number(row.failed_cap),
      failedVolume: Number(row.failed_vol),
    };
  }
}
