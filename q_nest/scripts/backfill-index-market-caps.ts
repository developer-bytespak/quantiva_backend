/**
 * Backfill market caps for index members, then recompute signal eligibility.
 *
 * WHY THIS EXISTS
 *   Signal eligibility (SignalEligibilityService) marks a stock ineligible when
 *   its latest market_cap is NULL/0, because `COALESCE(market_cap,0) >= $100M`
 *   fails. The stock-signals cron only processes `signal_eligible = true` stocks.
 *
 *   FMP's daily rotation (200 stocks/day on the free tier) takes ~33 days to
 *   cover the full 6,700-stock universe, so most non-S&P-500 stocks sit with a
 *   NULL cap and never become eligible. That's why Option-B strategies whose
 *   universe is outside the S&P 500 — e.g. "Mid-Cap Growth" (SP_MIDCAP_400) —
 *   produce zero signals: their members are all ineligible.
 *
 *   This script fetches market caps from FMP for a *targeted* set (index
 *   members missing a cap) instead of waiting for the slow rotation, writes
 *   them into market_rankings, and recomputes eligibility so those members flip
 *   to signal_eligible = true on the spot.
 *
 * WHAT IT DOES
 *   1. Select target symbols: members of the given index code(s) (default
 *      SP_MIDCAP_400) whose latest market_rankings.market_cap is NULL or <= 0.
 *   2. Fetch profiles (incl. marketCap) from FMP in batches.
 *   3. Update the latest market_rankings row per asset in place with the cap
 *      (preserving its price/volume so the price-feed gate still passes).
 *   4. Recompute signal_eligible for the whole universe.
 *
 * SAFETY
 *   - Idempotent: re-running only refreshes caps; no duplicate rows.
 *   - --dry-run: prints what it would do, no DB writes, no FMP calls.
 *   - Only UPDATEs existing latest rows (or INSERTs a cap-only row when none
 *     exists). No DELETEs.
 *
 * USAGE
 *   npx ts-node scripts/backfill-index-market-caps.ts --dry-run
 *   npx ts-node scripts/backfill-index-market-caps.ts                       # SP_MIDCAP_400, missing caps, limit 250
 *   npx ts-node scripts/backfill-index-market-caps.ts --index=SP_MIDCAP_400,RUSSELL_2000
 *   npx ts-node scripts/backfill-index-market-caps.ts --all --limit=200     # whole universe (free-tier friendly chunk)
 *   npx ts-node scripts/backfill-index-market-caps.ts --include-existing    # also refresh stocks that already have a cap
 *   npx ts-node scripts/backfill-index-market-caps.ts --no-recompute        # skip the eligibility recompute
 */

// NB: we intentionally do NOT bootstrap AppModule here. AppModule transitively
// imports services (auth, pdf, index-source scrapers) that require optional
// packages which aren't always installed locally, so a full NestFactory boot
// can fail at module load. These three collaborators have trivial dependencies,
// so we construct them directly: PrismaClient, FmpService (needs only a config
// getter), and SignalEligibilityService (needs only a Prisma handle).
import { PrismaClient } from '@prisma/client';
import { FmpService } from '../src/modules/stocks-market/services/fmp.service';
import { SignalEligibilityService } from '../src/modules/stocks-market/services/signal-eligibility.service';

type PrismaService = PrismaClient;

function getFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const DRY_RUN = hasFlag('dry-run');
const ALL = hasFlag('all');
const INCLUDE_EXISTING = hasFlag('include-existing');
const RECOMPUTE = !hasFlag('no-recompute');
const LIMIT = Number(getFlag('limit') ?? '250');
const INDEX_CODES = (getFlag('index') ?? 'SP_MIDCAP_400')
  .split(',')
  .map((c) => c.trim().toUpperCase())
  .filter(Boolean);

interface TargetRow {
  asset_id: string;
  symbol: string;
}

async function selectTargets(prisma: PrismaService): Promise<TargetRow[]> {
  // Latest cap per asset; a stock is "missing" if NULL or <= 0 (unless --include-existing).
  const capFilter = INCLUDE_EXISTING
    ? `TRUE`
    : `(lm.market_cap IS NULL OR lm.market_cap <= 0)`;

  if (ALL) {
    return (await prisma.$queryRawUnsafe(`
      WITH latest_market AS (
        SELECT DISTINCT ON (asset_id) asset_id, market_cap
        FROM market_rankings ORDER BY asset_id, rank_timestamp DESC
      )
      SELECT a.asset_id, a.symbol
      FROM assets a
      LEFT JOIN latest_market lm ON lm.asset_id = a.asset_id
      WHERE a.asset_type = 'stock' AND a.is_active = true
        AND a.symbol IS NOT NULL
        AND ${capFilter}
      ORDER BY a.market_cap_rank ASC NULLS LAST
      LIMIT ${LIMIT}
    `)) as TargetRow[];
  }

  return (await prisma.$queryRawUnsafe(`
    WITH latest_market AS (
      SELECT DISTINCT ON (asset_id) asset_id, market_cap
      FROM market_rankings ORDER BY asset_id, rank_timestamp DESC
    )
    SELECT a.asset_id, a.symbol
    FROM assets a
    JOIN index_membership im ON im.asset_id = a.asset_id
    JOIN indexes i ON i.index_id = im.index_id
    LEFT JOIN latest_market lm ON lm.asset_id = a.asset_id
    WHERE a.asset_type = 'stock' AND a.is_active = true
      AND a.symbol IS NOT NULL
      AND i.code = ANY (ARRAY[${INDEX_CODES.map((c) => `'${c.replace(/'/g, "''")}'`).join(',')}])
      AND ${capFilter}
    GROUP BY a.asset_id, a.symbol, a.market_cap_rank
    ORDER BY a.market_cap_rank ASC NULLS LAST
    LIMIT ${LIMIT}
  `)) as TargetRow[];
}

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log(DRY_RUN
    ? '║  DRY RUN — no FMP calls, no database changes  ║'
    : '║  REAL RUN — FMP fetch + database writes       ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`Scope: ${ALL ? 'ALL active stocks' : `index members of [${INDEX_CODES.join(', ')}]`}`);
  console.log(`Filter: ${INCLUDE_EXISTING ? 'all targets (incl. ones with a cap)' : 'only missing/zero caps'} · limit ${LIMIT}`);
  console.log(`Recompute eligibility afterwards: ${RECOMPUTE ? 'yes' : 'no'}\n`);

  const prisma = new PrismaClient();
  // FmpService only reads FMP_API_KEY via ConfigService#get — a thin env shim suffices.
  const fmp = new FmpService({ get: (k: string) => process.env[k] } as any);
  // SignalEligibilityService only uses prisma.$executeRaw / $queryRaw, both on PrismaClient.
  const eligibility = new SignalEligibilityService(prisma as any);

  try {
    console.log('[1/4] Selecting target symbols...');
    const targets = await selectTargets(prisma);
    console.log(`      ${targets.length} symbols selected`);
    if (targets.length === 0) {
      console.log('      Nothing to backfill. Done.');
      return;
    }

    const assetIdBySymbol = new Map<string, string>();
    for (const t of targets) assetIdBySymbol.set(t.symbol, t.asset_id);
    const symbols = targets.map((t) => t.symbol);

    if (DRY_RUN) {
      console.log(`\n[DRY] Would fetch FMP profiles for ${symbols.length} symbols:`);
      console.log('      ' + symbols.slice(0, 40).join(', ') + (symbols.length > 40 ? ` … (+${symbols.length - 40} more)` : ''));
      console.log('\n[DRY] Would update latest market_rankings row per asset with the fetched cap.');
      console.log(`[DRY] Would ${RECOMPUTE ? '' : 'NOT '}recompute signal eligibility.`);
      console.log('\nDRY RUN COMPLETE — no changes made.');
      return;
    }

    console.log(`\n[2/4] Fetching market caps from FMP for ${symbols.length} symbols...`);
    const quotes = await fmp.getBatchProfiles(symbols);
    console.log(`      Retrieved ${quotes.size}/${symbols.length} profiles from FMP`);

    console.log('\n[3/4] Writing caps into market_rankings (latest row per asset)...');
    const now = new Date();
    let updated = 0;
    let created = 0;
    let skippedNoCap = 0;

    for (const symbol of symbols) {
      const quote = quotes.get(symbol);
      const cap = quote ? Number(quote.marketCap) : 0;
      if (!quote || !cap || cap <= 0) {
        skippedNoCap++;
        continue;
      }

      const assetId = assetIdBySymbol.get(symbol)!;
      const latest = await prisma.market_rankings.findFirst({
        where: { asset_id: assetId },
        orderBy: { rank_timestamp: 'desc' },
        select: { rank_timestamp: true },
      });

      if (latest) {
        // Update in place — preserves the row's existing price_usd/volume so the
        // price-feed gate in getStocksToProcess still passes.
        await prisma.market_rankings.update({
          where: {
            rank_timestamp_asset_id: { rank_timestamp: latest.rank_timestamp, asset_id: assetId },
          },
          data: { market_cap: cap },
        });
        updated++;
      } else {
        // No ranking row at all yet — create a cap-only row. Price will be
        // filled by the next Alpaca market-data sync.
        await prisma.market_rankings.create({
          data: { rank_timestamp: now, asset_id: assetId, rank: 0, market_cap: cap },
        });
        created++;
      }
    }

    console.log(`      ✓ ${updated} updated, ${created} created, ${skippedNoCap} skipped (no cap from FMP)`);

    if (RECOMPUTE) {
      console.log('\n[4/4] Recomputing signal eligibility for the universe...');
      const summary = await eligibility.recomputeEligibility();
      console.log(`      ✓ ${summary.eligible} eligible / ${summary.ineligible} ineligible (of ${summary.totalConsidered})`);
      console.log(`        failed market-cap floor: ${summary.failedMarketCap} · failed volume floor: ${summary.failedVolume}`);
    } else {
      console.log('\n[4/4] Skipped eligibility recompute (--no-recompute). Run the daily cron or rerun without the flag.');
    }

    console.log('\n========================================');
    console.log('  BACKFILL COMPLETE');
    console.log('========================================');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('\n✗ FATAL ERROR:', err?.message);
  console.error(err?.stack);
  process.exit(1);
});
