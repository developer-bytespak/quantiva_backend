/**
 * One-shot: replicate what `snapshotSocialMetricsBulk()` does in
 * news-cronjob.service.ts — fetch the bulk coin metrics from Python
 * (which hits LunarCrush) and insert per-asset rows into `trending_assets`
 * with `galaxy_score` populated. Unblocks the crypto signals cron.
 *
 * Usage:
 *   npx ts-node -T prisma/scripts/run-social-bulk-snapshot.ts
 *
 * Reads from env (via q_nest/.env when invoked with ts-node):
 *   - DATABASE_URL
 *   - PYTHON_API_URL  (defaults to http://localhost:8000)
 *   - INTERNAL_API_KEY
 */
import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load q_nest/.env so DATABASE_URL + INTERNAL_API_KEY are available
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://localhost:8000';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

async function main(): Promise<void> {
  if (!INTERNAL_API_KEY) {
    console.error('INTERNAL_API_KEY missing from env');
    process.exit(1);
  }

  console.log(`Calling Python bulk social endpoint at ${PYTHON_API_URL}...`);
  const started = Date.now();
  let metricsMap: Record<string, any> = {};
  let reportedCount = 0;

  try {
    const response = await axios.post<{
      count: number;
      fetched_at: string;
      metrics?: Record<string, any>;
    }>(
      `${PYTHON_API_URL}/api/v1/market/social-bulk`,
      { include_metrics: true },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Api-Key': INTERNAL_API_KEY,
        },
        timeout: 120000,
      },
    );
    metricsMap = response.data?.metrics || {};
    reportedCount = response.data?.count ?? 0;
    console.log(
      `Python returned ${reportedCount} coins (metrics map has ${Object.keys(metricsMap).length} symbols) in ${Math.round((Date.now() - started) / 1000)}s`,
    );
  } catch (err: any) {
    const status = err?.response?.status;
    const body = err?.response?.data;
    console.error(`Python call failed: status=${status ?? 'NONE'}`);
    if (body) console.error('  body:', JSON.stringify(body).slice(0, 400));
    else if (err?.message) console.error('  message:', err.message);
    process.exit(1);
  }

  const symbols = Object.keys(metricsMap);
  if (symbols.length === 0) {
    console.error('Empty metrics map — nothing to write');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    // Match against active crypto assets only, mirroring the cron
    const assets = await prisma.assets.findMany({
      where: {
        asset_type: 'crypto',
        is_active: true,
        symbol: { in: symbols },
      },
      select: { asset_id: true, symbol: true },
    });
    console.log(`Matched ${assets.length} active crypto assets against ${symbols.length} LunarCrush symbols`);

    const pollTimestamp = new Date();
    let written = 0;
    let errors = 0;
    let withGalaxy = 0;

    for (const asset of assets) {
      if (!asset.symbol) continue;
      const m = metricsMap[asset.symbol.toUpperCase()];
      if (!m) continue;

      try {
        await prisma.trending_assets.create({
          data: {
            poll_timestamp: new Date(pollTimestamp.getTime() + written),
            asset_id: asset.asset_id,
            galaxy_score: m.galaxy_score ?? null,
            alt_rank: m.alt_rank ?? null,
            social_score: m.social_score ?? null,
            market_volume: m.volume_24h ?? null,
            price_usd: m.price ?? null,
            price_change_24h: m.price_change_24h ?? null,
            volume_24h: m.volume_24h ?? null,
            market_cap: m.market_cap ?? null,
          },
        });
        if (m.galaxy_score != null) withGalaxy++;
        written++;
      } catch (err: any) {
        errors++;
      }
    }

    console.log();
    console.log('=== Snapshot summary ===');
    console.log(`  bulk coins from LunarCrush : ${reportedCount}`);
    console.log(`  matched assets in DB       : ${assets.length}`);
    console.log(`  rows written               : ${written}`);
    console.log(`  rows with galaxy_score     : ${withGalaxy}`);
    console.log(`  errors                     : ${errors}`);
    console.log();
    console.log('trending_assets should now contain fresh galaxy_score rows.');
    console.log('Next generatePreBuiltSignals cron run (every 10 min) should produce signals.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
