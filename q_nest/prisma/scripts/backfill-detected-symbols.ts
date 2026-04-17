/**
 * One-shot backfill: recompute `metadata.detected_symbol` on recent
 * general-feed `trending_news` rows.
 *
 * Usage (from q_nest root):
 *   npx ts-node -T prisma/scripts/backfill-detected-symbols.ts
 *
 * What it does:
 *   1. Finds all general-feed `trending_news` rows whose poll_timestamp is
 *      within the last N days (default 2).
 *   2. Runs the title through `detectCoin()` and computes a new
 *      detected_symbol (ticker or "CRYPTO" fallback).
 *   3. Merges it into the row's metadata JSON — all other metadata keys are
 *      preserved.
 *   4. Skips rows whose detected_symbol is already correct (idempotent, safe
 *      to re-run).
 *   5. Prints a per-symbol histogram at the end.
 *
 * Environment:
 *   Requires DATABASE_URL to be set (same one NestJS uses). When run on
 *   Render via `render run`, this inherits the service's env.
 */
import { PrismaClient } from '@prisma/client';
import { detectCoin } from '../../src/modules/news/crypto-coin-detector';

const DAYS_BACK = Number(process.env.BACKFILL_DAYS ?? '2');

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const cutoff = new Date(Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000);
    console.log(
      `Scanning general-feed trending_news rows since ${cutoff.toISOString()} (last ${DAYS_BACK} days)...`,
    );

    // Fetch candidates. We filter in-app on metadata.general_feed rather than
    // trying to express JSON-path filters in Prisma (the shape is portable
    // across pg versions and keeps the query simple).
    const rows = await prisma.trending_news.findMany({
      where: {
        poll_timestamp: { gte: cutoff },
      },
      select: {
        poll_timestamp: true,
        asset_id: true,
        heading: true,
        metadata: true,
      },
    });

    let scanned = 0;
    let updated = 0;
    let unchanged = 0;
    let skippedNotGeneral = 0;
    let skippedNoTitle = 0;
    const histogram = new Map<string, number>();

    for (const row of rows) {
      scanned++;

      const meta = (row.metadata ?? {}) as Record<string, any>;
      if (meta.general_feed !== true) {
        skippedNotGeneral++;
        continue;
      }

      const title = (row.heading || '').trim();
      if (!title) {
        skippedNoTitle++;
        continue;
      }

      const next = detectCoin(title) ?? 'CRYPTO';
      histogram.set(next, (histogram.get(next) ?? 0) + 1);

      if (meta.detected_symbol === next) {
        unchanged++;
        continue;
      }

      await prisma.trending_news.update({
        where: {
          poll_timestamp_asset_id: {
            poll_timestamp: row.poll_timestamp,
            asset_id: row.asset_id,
          },
        },
        data: {
          metadata: {
            ...meta,
            detected_symbol: next,
          },
        },
      });
      updated++;
    }

    console.log();
    console.log('=== Backfill summary ===');
    console.log(`  scanned                : ${scanned}`);
    console.log(`  updated                : ${updated}`);
    console.log(`  already correct        : ${unchanged}`);
    console.log(`  skipped (not general)  : ${skippedNotGeneral}`);
    console.log(`  skipped (no title)     : ${skippedNoTitle}`);
    console.log();
    console.log('=== Detected-symbol distribution ===');
    const sortedHist = Array.from(histogram.entries()).sort((a, b) => b[1] - a[1]);
    for (const [sym, n] of sortedHist) {
      console.log(`  ${sym.padEnd(8)} ${n}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
