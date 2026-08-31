/**
 * One-off backfill: repopulate market_cap for all active stocks via FMP
 * /stable/batch-quote, then refresh today's market_rankings rows.
 *
 * Why: the nightly sync was broken Aug 13-18 2026 (60s transaction timeout)
 * and the 7-day rankings cleanup eroded cached caps to ~134 of ~6,300 stocks.
 * Signal eligibility needs market_cap >= $100M, and the normal FMP rotation
 * only refreshes 200 stocks/day — this script restores all caps in one run.
 *
 * Usage (from quantiva_backend/q_nest):
 *   node scripts/backfill-stock-market-caps.js            # live run
 *   node scripts/backfill-stock-market-caps.js --dry-run  # fetch + report only
 *
 * Reads DATABASE_URL and FMP_API_KEY from .env in the current directory.
 * Idempotent: safe to re-run; it upserts the latest rank_timestamp per asset.
 */
const fs = require('fs');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');

const env = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8');
const get = (k) => {
  const m = env.match(new RegExp(`^${k}="?([^"\\r\\n]+)"?`, 'm'));
  return m ? m[1] : null;
};
process.env.DATABASE_URL = get('DATABASE_URL');
const FMP_KEY = get('FMP_API_KEY');
if (!process.env.DATABASE_URL || !FMP_KEY) {
  console.error('Missing DATABASE_URL or FMP_API_KEY in .env');
  process.exit(1);
}

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const BATCH = 100; // symbols per batch-quote call (keeps URLs comfortably short)
const PAUSE_MS = 250; // between FMP calls, stays well under rate limits

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchBatchQuotes(symbols) {
  const url = `https://financialmodelingprep.com/stable/batch-quote?symbols=${encodeURIComponent(symbols.join(','))}&apikey=${FMP_KEY}`;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`FMP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    } catch (e) {
      lastErr = e;
      await sleep(1500 * attempt);
    }
  }
  throw lastErr;
}

async function main() {
  const stocks = await prisma.assets.findMany({
    where: { asset_type: 'stock', is_active: true },
    select: { asset_id: true, symbol: true },
  });
  console.log(`Active stocks: ${stocks.length}${DRY_RUN ? ' (DRY RUN)' : ''}`);
  const idBySymbol = new Map(stocks.map((s) => [s.symbol.toUpperCase(), s.asset_id]));

  // 1. Fetch caps from FMP in batches
  const caps = new Map(); // asset_id -> { marketCap, price }
  const symbols = stocks.map((s) => s.symbol);
  let fetched = 0;
  for (let i = 0; i < symbols.length; i += BATCH) {
    const chunk = symbols.slice(i, i + BATCH);
    try {
      const quotes = await fetchBatchQuotes(chunk);
      for (const q of quotes) {
        const id = idBySymbol.get(String(q.symbol || '').toUpperCase());
        if (id && q.marketCap != null && q.marketCap > 0) {
          caps.set(id, { marketCap: q.marketCap, price: q.price ?? null });
        }
      }
      fetched += quotes.length;
    } catch (e) {
      console.warn(`Batch ${i}-${i + chunk.length} failed: ${e.message}`);
    }
    if ((i / BATCH) % 10 === 0) {
      console.log(`  progress: ${Math.min(i + BATCH, symbols.length)}/${symbols.length} requested, ${caps.size} caps collected`);
    }
    await sleep(PAUSE_MS);
  }
  console.log(`FMP returned ${fetched} quotes; ${caps.size} usable market caps`);
  if (DRY_RUN) {
    const over100m = [...caps.values()].filter((c) => c.marketCap >= 100_000_000).length;
    console.log(`Would update ${caps.size} stocks (${over100m} with cap >= $100M). Dry run: no writes.`);
    return;
  }

  // 2. Write caps onto each asset's LATEST ranking row (chunked raw updates).
  //    If the asset has no ranking row at all, insert one stamped now.
  const entries = [...caps.entries()];
  let updated = 0;
  let inserted = 0;
  const now = new Date();
  for (let i = 0; i < entries.length; i += 200) {
    const chunk = entries.slice(i, i + 200);
    await Promise.all(
      chunk.map(async ([assetId, { marketCap, price }]) => {
        const res = await prisma.$executeRaw`
          UPDATE market_rankings mr SET market_cap = ${marketCap}
          WHERE mr.asset_id = ${assetId}::uuid
            AND mr.rank_timestamp = (
              SELECT MAX(rank_timestamp) FROM market_rankings WHERE asset_id = ${assetId}::uuid
            )`;
        if (res > 0) {
          updated += res;
        } else {
          await prisma.market_rankings.create({
            data: {
              rank_timestamp: now,
              asset_id: assetId,
              rank: 0,
              market_cap: marketCap,
              price_usd: price,
            },
          });
          inserted++;
        }
      }),
    );
    if ((i / 200) % 5 === 0) console.log(`  wrote ${Math.min(i + 200, entries.length)}/${entries.length}`);
  }
  console.log(`Done. Rankings updated: ${updated}, inserted: ${inserted}`);

  const check = await prisma.$queryRaw`
    SELECT COUNT(DISTINCT mr.asset_id) AS n
    FROM market_rankings mr JOIN assets a ON a.asset_id = mr.asset_id
    WHERE a.asset_type = 'stock' AND mr.market_cap >= 100000000`;
  console.log(`Stocks now with cap >= $100M in rankings: ${Number(check[0].n)}`);
}

main()
  .catch((e) => {
    console.error('FATAL:', e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
