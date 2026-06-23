/**
 * Derive Russell 1000 / 2000 / Midcap index membership from market caps.
 *
 * WHY THIS EXISTS
 *   The Russell indexes are *derived* (indexes.is_derived = true) — FTSE Russell
 *   ranks the US equity universe by market cap and slices it. We have no direct
 *   constituents feed, so populate-option-b-universe.ts only seeds the Russell
 *   index metadata rows and never fills index_membership. reconstitution-alert.
 *   service.ts tells operators to "re-run scripts/derive-russell-membership.ts"
 *   on rebalance days — but that script never existed. Result: RUSSELL_2000 has
 *   zero members, so "Russell 2000 Small-Cap Momentum" can never fire (the
 *   stock-signals cron skips every stock that isn't a member of the strategy's
 *   target index).
 *
 *   This is that missing script.
 *
 * DERIVATION (standard FTSE Russell slicing, by descending market cap)
 *   - Russell 1000  = ranks    1 .. 1000   (largest 1000)
 *   - Russell Midcap = ranks  201 .. 1000   (smallest 800 of the Russell 1000)
 *   - Russell 2000  = ranks 1001 .. 3000   (next 2000 after the top 1000)
 *
 *   Coverage depends entirely on how many stocks currently have a market cap in
 *   market_rankings. If fewer than ~3000 stocks have caps, Russell 2000 will be
 *   partial/empty — run backfill-index-market-caps.ts --all first (or upgrade
 *   FMP) to populate caps across the universe.
 *
 * SAFETY
 *   - Idempotent reconstitution: deletes existing membership rows for the three
 *     derived indexes, then re-inserts from the current ranking. Other indexes
 *     (SP500, DOW, SP_MIDCAP_400, …) are untouched.
 *   - --dry-run: prints the slices and boundaries, no DB writes.
 *
 * USAGE
 *   npx ts-node scripts/derive-russell-membership.ts --dry-run
 *   npx ts-node scripts/derive-russell-membership.ts
 */

import { PrismaClient } from '@prisma/client';

const DRY_RUN = process.argv.includes('--dry-run');
const prisma = new PrismaClient();

const MAX_SYMBOL_LEN = 10; // index_membership.symbol is VarChar(10)

// FTSE Russell slice boundaries (1-based, inclusive).
const R1000_END = 1000;
const MIDCAP_START = 201; // Russell Midcap = R1000 minus the Russell Top 200
const R2000_START = 1001;
const R2000_END = 3000;

interface RankedStock {
  asset_id: string;
  symbol: string;
  market_cap: string; // numeric comes back as string from $queryRaw
}

function fmtCap(cap: string): string {
  const n = Number(cap);
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  return `$${n.toFixed(0)}`;
}

async function getIndexId(code: string): Promise<string> {
  const row = await prisma.indexes.findUnique({ where: { code }, select: { index_id: true } });
  if (!row) {
    throw new Error(`Index "${code}" not found in indexes table. Run populate-option-b-universe.ts first.`);
  }
  return row.index_id;
}

async function replaceMembership(code: string, members: RankedStock[]): Promise<number> {
  const indexId = await getIndexId(code);

  const rows = members
    .filter((m) => m.symbol && m.symbol.length <= MAX_SYMBOL_LEN)
    .map((m) => ({ index_id: indexId, asset_id: m.asset_id, symbol: m.symbol }));

  if (DRY_RUN) {
    const dropped = members.length - rows.length;
    console.log(
      `       [DRY] ${code.padEnd(15)} would set ${rows.length} members` +
        (dropped > 0 ? ` (${dropped} skipped: symbol > ${MAX_SYMBOL_LEN} chars)` : ''),
    );
    return rows.length;
  }

  // Reconstitution: clear and re-insert in one transaction so the index is
  // never observed half-populated.
  await prisma.$transaction([
    prisma.index_membership.deleteMany({ where: { index_id: indexId } }),
    prisma.index_membership.createMany({ data: rows, skipDuplicates: true }),
    prisma.indexes.update({ where: { index_id: indexId }, data: { last_refreshed: new Date() } }),
  ]);

  console.log(`       ${code.padEnd(15)} ✓ ${rows.length} members`);
  return rows.length;
}

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log(DRY_RUN
    ? '║  DRY RUN — no database changes will be made   ║'
    : '║  REAL RUN — Russell membership will be rebuilt ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  console.log('[1/2] Ranking active stocks by latest market cap...');
  const ranked = await prisma.$queryRaw<RankedStock[]>`
    WITH latest_market AS (
      SELECT DISTINCT ON (asset_id) asset_id, market_cap
      FROM market_rankings
      ORDER BY asset_id, rank_timestamp DESC
    )
    SELECT a.asset_id, a.symbol, lm.market_cap::text AS market_cap
    FROM assets a
    JOIN latest_market lm ON lm.asset_id = a.asset_id
    WHERE a.asset_type = 'stock'
      AND a.is_active = true
      AND a.symbol IS NOT NULL
      AND lm.market_cap IS NOT NULL
      AND lm.market_cap > 0
    ORDER BY lm.market_cap DESC
  `;

  console.log(`      ${ranked.length} stocks have a usable market cap\n`);

  if (ranked.length < R1000_END) {
    console.log(`      ⚠ Only ${ranked.length} stocks have caps (< ${R1000_END}).`);
    console.log('      ⚠ Russell 2000 will be EMPTY and Russell 1000 partial until more');
    console.log('      ⚠ caps are populated. Run: npx ts-node scripts/backfill-index-market-caps.ts --all\n');
  } else if (ranked.length < R2000_END) {
    console.log(`      ⚠ Only ${ranked.length} stocks have caps (< ${R2000_END}).`);
    console.log('      ⚠ Russell 2000 will be PARTIAL until caps cover the small-cap tail.');
    console.log('      ⚠ Run: npx ts-node scripts/backfill-index-market-caps.ts --all\n');
  }

  // Slices (array indices are 0-based; rank N → index N-1).
  const r1000 = ranked.slice(0, R1000_END);
  const midcap = ranked.slice(MIDCAP_START - 1, R1000_END);
  const r2000 = ranked.slice(R2000_START - 1, R2000_END);

  // Report boundaries so the slicing is auditable.
  if (r1000.length > 0) {
    console.log(`      Russell 1000:   ${fmtCap(r1000[0].market_cap)} (top) → ${fmtCap(r1000[r1000.length - 1].market_cap)} (#${r1000.length})`);
  }
  if (r2000.length > 0) {
    console.log(`      Russell 2000:   ${fmtCap(r2000[0].market_cap)} (#${R2000_START}) → ${fmtCap(r2000[r2000.length - 1].market_cap)} (#${R2000_START - 1 + r2000.length})`);
  }
  console.log('');

  console.log('[2/2] Writing membership...');
  await replaceMembership('RUSSELL_1000', r1000);
  await replaceMembership('RUSSELL_MIDCAP', midcap);
  await replaceMembership('RUSSELL_2000', r2000);

  console.log('\n========================================');
  console.log(DRY_RUN ? '  DRY RUN COMPLETE — no changes made' : '  RUSSELL DERIVATION COMPLETE');
  console.log('========================================\n');
}

main()
  .catch((err) => {
    console.error('\n✗ FATAL ERROR:', err?.message);
    console.error(err?.stack);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
