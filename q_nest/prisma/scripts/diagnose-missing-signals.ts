/**
 * One-shot diagnostic: why are there no BUY signals for pre-built
 * strategies on the Top Trades page? Runs the three checks from the
 * conversation in one shot.
 *
 * Usage (from q_nest root):
 *   npx ts-node -T prisma/scripts/diagnose-missing-signals.ts
 *
 * Reads DATABASE_URL from the environment (q_nest/.env when run via ts-node).
 */
import { PrismaClient } from '@prisma/client';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    // ---------- CHECK 1: Is any signal being written at all? ----------
    console.log('=== CHECK 1: signal volume by action in last 24h (pre-built only) ===');
    const byAction = await prisma.$queryRaw<Array<{ action: string; n: bigint }>>`
      SELECT action::text AS action, COUNT(*)::bigint AS n
      FROM strategy_signals
      WHERE user_id IS NULL
        AND timestamp > NOW() - INTERVAL '24 hours'
      GROUP BY action
      ORDER BY n DESC;
    `;
    if (byAction.length === 0) {
      console.log('  (no rows in last 24h)');
    } else {
      for (const r of byAction) {
        console.log(`  ${r.action.padEnd(6)} : ${Number(r.n).toLocaleString()}`);
      }
    }
    console.log();

    // Latest signal timestamp, per strategy name
    console.log('=== CHECK 1b: latest signal per pre-built strategy (user_id=null) ===');
    const perStrategy = await prisma.$queryRaw<
      Array<{ name: string; latest: Date | null; n_last_24h: bigint; buys_last_24h: bigint }>
    >`
      SELECT
        s.name::text                                       AS name,
        MAX(sig.timestamp)                                 AS latest,
        COUNT(*) FILTER (WHERE sig.timestamp > NOW() - INTERVAL '24 hours')::bigint AS n_last_24h,
        COUNT(*) FILTER (WHERE sig.timestamp > NOW() - INTERVAL '24 hours' AND sig.action = 'BUY')::bigint AS buys_last_24h
      FROM strategies s
      LEFT JOIN strategy_signals sig
        ON sig.strategy_id = s.strategy_id
        AND sig.user_id IS NULL
      WHERE s.type = 'admin' AND s.asset_type = 'crypto'
      GROUP BY s.strategy_id, s.name
      ORDER BY s.name;
    `;
    for (const r of perStrategy) {
      const latestStr = r.latest ? r.latest.toISOString() : '(never)';
      console.log(
        `  ${r.name.padEnd(22)} latest=${latestStr}  24h_total=${Number(r.n_last_24h)}  24h_BUYs=${Number(r.buys_last_24h)}`,
      );
    }
    console.log();

    // ---------- CHECK 2: Is trending_assets fresh with galaxy_score? ----------
    console.log('=== CHECK 2: trending_assets freshness ===');
    const trendingStats = await prisma.$queryRaw<
      Array<{ latest: Date | null; with_galaxy_12h: bigint; total_12h: bigint; distinct_assets_12h: bigint }>
    >`
      SELECT
        MAX(poll_timestamp)                                                    AS latest,
        COUNT(*) FILTER (WHERE galaxy_score IS NOT NULL AND poll_timestamp > NOW() - INTERVAL '12 hours')::bigint AS with_galaxy_12h,
        COUNT(*) FILTER (WHERE poll_timestamp > NOW() - INTERVAL '12 hours')::bigint AS total_12h,
        COUNT(DISTINCT asset_id) FILTER (WHERE poll_timestamp > NOW() - INTERVAL '12 hours')::bigint AS distinct_assets_12h
      FROM trending_assets;
    `;
    const t = trendingStats[0];
    console.log(`  latest poll_timestamp        : ${t.latest?.toISOString() ?? '(no rows)'}`);
    console.log(`  rows in last 12h (total)     : ${Number(t.total_12h).toLocaleString()}`);
    console.log(`  rows with galaxy_score (12h) : ${Number(t.with_galaxy_12h).toLocaleString()}`);
    console.log(`  distinct assets (12h)        : ${Number(t.distinct_assets_12h).toLocaleString()}`);
    console.log();

    // ---------- CHECK 3: does getTopTrendingAssets actually return rows? ----------
    console.log('=== CHECK 3: simulate getTopTrendingAssets(50) WHERE clause ===');
    const trendingCandidates = await prisma.$queryRaw<
      Array<{ n: bigint }>
    >`
      SELECT COUNT(DISTINCT ta.asset_id)::bigint AS n
      FROM trending_assets ta
      JOIN assets a ON a.asset_id = ta.asset_id
      WHERE ta.galaxy_score IS NOT NULL
        AND ta.alt_rank IS NOT NULL
        AND ta.alt_rank < 300
        AND ta.price_usd IS NOT NULL
        AND ta.market_volume > 10000000
        AND a.asset_type = 'crypto'
        AND a.symbol NOT IN ('USDT','USDC','DAI','WBETH','STETH','WBTC','BUSD','TUSD','USDD','FDUSD','LUSD','FRAX');
    `;
    console.log(
      `  candidates the cron would pick from : ${Number(trendingCandidates[0].n).toLocaleString()}`,
    );
    console.log();

    // ---------- CHECK 4: fusion score distribution on recent signals ----------
    console.log('=== CHECK 4: final_score distribution on recent pre-built signals ===');
    const scoreStats = await prisma.$queryRaw<
      Array<{
        n: bigint;
        above_0_3: bigint;
        above_0_2: bigint;
        above_0_1: bigint;
        above_0: bigint;
        mean: number | null;
        max: number | null;
        min: number | null;
      }>
    >`
      SELECT
        COUNT(*)::bigint                                             AS n,
        COUNT(*) FILTER (WHERE final_score > 0.3)::bigint            AS above_0_3,
        COUNT(*) FILTER (WHERE final_score > 0.2)::bigint            AS above_0_2,
        COUNT(*) FILTER (WHERE final_score > 0.1)::bigint            AS above_0_1,
        COUNT(*) FILTER (WHERE final_score > 0)::bigint              AS above_0,
        AVG(final_score)::float8                                     AS mean,
        MAX(final_score)::float8                                     AS max,
        MIN(final_score)::float8                                     AS min
      FROM strategy_signals
      WHERE user_id IS NULL
        AND timestamp > NOW() - INTERVAL '24 hours';
    `;
    const s = scoreStats[0];
    console.log(`  rows scored (24h)            : ${Number(s.n)}`);
    if (Number(s.n) > 0) {
      console.log(`  final_score above 0.3 (BUY)  : ${Number(s.above_0_3)}`);
      console.log(`  final_score above 0.2        : ${Number(s.above_0_2)}`);
      console.log(`  final_score above 0.1        : ${Number(s.above_0_1)}`);
      console.log(`  final_score above 0          : ${Number(s.above_0)}`);
      console.log(`  mean / min / max             : ${s.mean?.toFixed(3)} / ${s.min?.toFixed(3)} / ${s.max?.toFixed(3)}`);
    }
    console.log();

    console.log('=== END ===');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Diagnostic failed:', err);
  process.exit(1);
});
