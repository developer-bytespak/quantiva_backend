import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';
import { NasdaqCompositeService } from './index-sources/nasdaq-composite.service';
import { NyseAmexListedService } from './index-sources/nyse-amex-listed.service';

/**
 * Daily check for delisted stocks.
 *
 * Strategy:
 *   1. Pull current nasdaqlisted.txt + otherlisted.txt (the two authoritative
 *      live listing sources nasdaqtrader.com publishes)
 *   2. Build a set of currently-listed symbols
 *   3. Any active stock in our DB whose symbol is NOT in either set has been
 *      delisted — mark it is_active = false
 *
 * Safety: only deactivates stocks that:
 *   - Don't appear in either listing file (so we have explicit evidence of delisting)
 *   - Aren't members of S&P 500 / Dow / S&P 400 (those use other authoritative sources;
 *     we don't want a transient nasdaqtrader.com hiccup to wipe well-known indexes)
 *
 * Runs daily at 6 AM UTC, after the SignalEligibility cron (5 AM).
 */
@Injectable()
export class DelistedStocksService {
  private readonly logger = new Logger(DelistedStocksService.name);
  // Indexes whose members we don't auto-deactivate — they have authoritative sources
  // (Wikipedia / hardcoded) that aren't tied to nasdaqtrader.com.
  private static readonly PROTECTED_INDEX_CODES = ['SP500', 'DOW', 'SP_MIDCAP_400'];

  // Source sourcing services are stateless plain classes — instantiate once at construction.
  private readonly nasdaqComposite = new NasdaqCompositeService();
  private readonly nyseAmexListed = new NyseAmexListedService();

  constructor(private prisma: PrismaService) {}

  /** Daily 6 AM UTC. */
  @Cron('0 6 * * *', { name: 'delisted-stocks-check', timeZone: 'UTC' })
  async runDailyCron() {
    try {
      const summary = await this.detectAndMarkDelisted();
      this.logger.log(
        `Delisted check: ${summary.deactivated} stocks deactivated (${summary.protected} protected, ${summary.totalListedSymbols} active listings checked)`,
      );
    } catch (err: any) {
      this.logger.error(`Delisted stocks cron failed: ${err.message}`, err.stack);
    }
  }

  /**
   * Detect and mark currently-delisted stocks. Returns a summary.
   */
  async detectAndMarkDelisted(): Promise<{
    deactivated: number;
    protected: number;
    totalListedSymbols: number;
  }> {
    // 1. Fetch both authoritative listing sources in parallel
    const [nasdaqResult, nyseAmexResult] = await Promise.all([
      this.nasdaqComposite.fetchConstituents(),
      this.nyseAmexListed.fetchConstituents(),
    ]);

    const listedSymbols = new Set<string>();
    for (const s of nasdaqResult.symbols) listedSymbols.add(s.symbol.toUpperCase());
    for (const s of nyseAmexResult.symbols) listedSymbols.add(s.symbol.toUpperCase());

    if (listedSymbols.size < 4_000) {
      this.logger.warn(
        `Delisted check aborted: only ${listedSymbols.size} listed symbols fetched (expected 5,000+) — fetch likely partial, refusing to deactivate`,
      );
      return { deactivated: 0, protected: 0, totalListedSymbols: listedSymbols.size };
    }

    // 2. Get all active stocks from DB
    const activeStocks = await this.prisma.assets.findMany({
      where: { asset_type: 'stock', is_active: true },
      select: { asset_id: true, symbol: true },
    });

    // 3. Find candidates — active stocks not in either listing file
    const candidates = activeStocks.filter(
      (a) => a.symbol && !listedSymbols.has(a.symbol.toUpperCase()),
    );

    if (candidates.length === 0) {
      return { deactivated: 0, protected: 0, totalListedSymbols: listedSymbols.size };
    }

    // 4. Protect candidates that belong to authoritative-source indexes (SP500, etc.)
    const candidateIds = candidates.map((c) => c.asset_id);
    const protectedRows = await this.prisma.index_membership.findMany({
      where: {
        asset_id: { in: candidateIds },
        index: { code: { in: DelistedStocksService.PROTECTED_INDEX_CODES } },
      },
      select: { asset_id: true },
      distinct: ['asset_id'],
    });
    const protectedIds = new Set(protectedRows.map((r) => r.asset_id));

    const toDeactivate = candidates.filter((c) => !protectedIds.has(c.asset_id));

    if (toDeactivate.length === 0) {
      return { deactivated: 0, protected: protectedIds.size, totalListedSymbols: listedSymbols.size };
    }

    // 5. Deactivate
    const now = new Date();
    await this.prisma.assets.updateMany({
      where: { asset_id: { in: toDeactivate.map((c) => c.asset_id) } },
      data: { is_active: false, last_seen_at: now },
    });

    return {
      deactivated: toDeactivate.length,
      protected: protectedIds.size,
      totalListedSymbols: listedSymbols.size,
    };
  }
}
