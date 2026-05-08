/**
 * Throwaway diagnostic: prints recent activity in `trending_news` so we can
 * confirm the existing news cron is alive before relying on the new warmer.
 *
 * Run: cd quantiva_backend/q_nest && npx tsx scripts/check-news-cron.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const now = new Date();

  const [latest, last24h, last2h, last30m, byAssetType, mostRecent5] = await Promise.all([
    prisma.trending_news.findFirst({
      orderBy: { poll_timestamp: 'desc' },
      select: { poll_timestamp: true, source: true, asset: { select: { symbol: true, asset_type: true } } },
    }),
    prisma.trending_news.count({
      where: { poll_timestamp: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
    }),
    prisma.trending_news.count({
      where: { poll_timestamp: { gte: new Date(now.getTime() - 2 * 60 * 60 * 1000) } },
    }),
    prisma.trending_news.count({
      where: { poll_timestamp: { gte: new Date(now.getTime() - 30 * 60 * 1000) } },
    }),
    prisma.$queryRaw<{ asset_type: string | null; count: bigint }[]>`
      SELECT a.asset_type AS asset_type, COUNT(*) AS count
      FROM trending_news tn
      JOIN assets a ON a.asset_id = tn.asset_id
      WHERE tn.poll_timestamp >= NOW() - INTERVAL '24 hours'
      GROUP BY a.asset_type
      ORDER BY count DESC
    `,
    prisma.trending_news.findMany({
      orderBy: { poll_timestamp: 'desc' },
      take: 5,
      select: {
        poll_timestamp: true,
        heading: true,
        source: true,
        asset: { select: { symbol: true, asset_type: true } },
      },
    }),
  ]);

  console.log('=== trending_news activity ===');
  console.log('Now (UTC):', now.toISOString());
  console.log();

  if (!latest) {
    console.log('Table is EMPTY — no news rows at all.');
  } else {
    const ageMin = Math.floor((now.getTime() - latest.poll_timestamp.getTime()) / 60000);
    console.log(
      `Most recent row: ${latest.poll_timestamp.toISOString()}  (${ageMin} min ago)`,
      `  symbol=${latest.asset?.symbol}  type=${latest.asset?.asset_type}  source=${latest.source}`,
    );
  }

  console.log();
  console.log(`Rows inserted in last 30 min: ${last30m}`);
  console.log(`Rows inserted in last 2  hr: ${last2h}`);
  console.log(`Rows inserted in last 24 hr: ${last24h}`);

  console.log();
  console.log('By asset_type (last 24h):');
  for (const r of byAssetType) {
    console.log(`  ${r.asset_type ?? '(null)'}: ${r.count.toString()}`);
  }

  console.log();
  console.log('5 most recent news items:');
  for (const r of mostRecent5) {
    console.log(
      `  ${r.poll_timestamp.toISOString()}  [${r.asset?.symbol}/${r.asset?.asset_type}]  ${r.source}  ${(r.heading ?? '').slice(0, 60)}`,
    );
  }

  console.log();
  console.log('Per-symbol row counts (last 24h, top 15):');
  const perSymbol = await prisma.$queryRaw<{ symbol: string; asset_type: string; count: bigint }[]>`
    SELECT a.symbol AS symbol, a.asset_type AS asset_type, COUNT(*) AS count
    FROM trending_news tn
    JOIN assets a ON a.asset_id = tn.asset_id
    WHERE tn.poll_timestamp >= NOW() - INTERVAL '24 hours'
    GROUP BY a.symbol, a.asset_type
    ORDER BY count DESC
    LIMIT 15
  `;
  for (const r of perSymbol) {
    console.log(`  ${r.symbol.padEnd(10)} ${(r.asset_type ?? '').padEnd(8)} ${r.count.toString()}`);
  }

  console.log();
  console.log('Sanity: would `getRecentNewsFromDB("BTC")` find anything?');
  const btcAsset = await prisma.assets.findFirst({
    where: { symbol: 'BTC', asset_type: 'crypto' },
    select: { asset_id: true },
  });
  if (!btcAsset) {
    console.log('  No BTC asset row exists — endpoint would return empty.');
  } else {
    const btcCount = await prisma.trending_news.count({
      where: {
        asset_id: btcAsset.asset_id,
        poll_timestamp: { gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) },
        article_url: { not: '' },
        heading: { not: '' },
      },
    });
    console.log(`  BTC asset exists. Rows in last 7 days for BTC: ${btcCount}`);
  }

  const aaplAsset = await prisma.assets.findFirst({
    where: { symbol: 'AAPL', asset_type: 'stock' },
    select: { asset_id: true },
  });
  if (!aaplAsset) {
    console.log('  No AAPL asset row exists — endpoint would return empty.');
  } else {
    const aaplCount = await prisma.trending_news.count({
      where: {
        asset_id: aaplAsset.asset_id,
        poll_timestamp: { gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) },
      },
    });
    console.log(`  AAPL asset exists. Rows in last 7 days for AAPL: ${aaplCount}`);
  }
}

async function diagnoseWarmer() {
  console.log();
  console.log('=== warmer diagnostic ===');

  const totalPositions = await prisma.portfolio_positions.count();
  const positivePositions = await prisma.portfolio_positions.count({
    where: { quantity: { gt: 0 } },
  });
  console.log(`portfolio_positions total rows: ${totalPositions}`);
  console.log(`portfolio_positions with quantity > 0: ${positivePositions}`);

  const cryptoHeld = await prisma.$queryRaw<{ symbol: string; holders: bigint }[]>`
    SELECT a.symbol, COUNT(DISTINCT p.user_id) AS holders
    FROM portfolio_positions pp
    JOIN portfolios p ON p.portfolio_id = pp.portfolio_id
    JOIN assets a ON a.asset_id = pp.asset_id
    WHERE pp.quantity > 0 AND a.asset_type = 'crypto'
    GROUP BY a.symbol
    ORDER BY holders DESC
    LIMIT 20
  `;
  const stockHeld = await prisma.$queryRaw<{ symbol: string; holders: bigint }[]>`
    SELECT a.symbol, COUNT(DISTINCT p.user_id) AS holders
    FROM portfolio_positions pp
    JOIN portfolios p ON p.portfolio_id = pp.portfolio_id
    JOIN assets a ON a.asset_id = pp.asset_id
    WHERE pp.quantity > 0 AND a.asset_type = 'stock'
    GROUP BY a.symbol
    ORDER BY holders DESC
    LIMIT 20
  `;
  console.log(`Distinct held crypto symbols (in portfolio_positions): ${cryptoHeld.length}`);
  for (const r of cryptoHeld) console.log(`  ${r.symbol.padEnd(10)} holders=${r.holders}`);
  console.log(`Distinct held stock symbols (in portfolio_positions): ${stockHeld.length}`);
  for (const r of stockHeld) console.log(`  ${r.symbol.padEnd(10)} holders=${r.holders}`);

  console.log();
  console.log('=== specific symbols user clicked ===');
  for (const sym of ['BCH', 'MO']) {
    const asset = await prisma.assets.findFirst({
      where: { symbol: sym },
      select: { asset_id: true, asset_type: true, last_seen_at: true },
    });
    if (!asset) {
      console.log(`  ${sym}: no assets row exists`);
    } else {
      const cnt = await prisma.trending_news.count({
        where: { asset_id: asset.asset_id },
      });
      const lastRow = await prisma.trending_news.findFirst({
        where: { asset_id: asset.asset_id },
        orderBy: { poll_timestamp: 'desc' },
        select: { poll_timestamp: true },
      });
      console.log(
        `  ${sym} (type=${asset.asset_type}): trending_news rows=${cnt}` +
          (lastRow ? `, latest=${lastRow.poll_timestamp.toISOString()}` : ''),
      );
    }
  }

  console.log();
  console.log('=== rows written in last 4 hours, grouped by asset symbol ===');
  const last4h = await prisma.$queryRaw<{ symbol: string; asset_type: string; count: bigint }[]>`
    SELECT a.symbol, a.asset_type, COUNT(*) AS count
    FROM trending_news tn
    JOIN assets a ON a.asset_id = tn.asset_id
    WHERE tn.poll_timestamp >= NOW() - INTERVAL '4 hours'
    GROUP BY a.symbol, a.asset_type
    ORDER BY count DESC
  `;
  if (last4h.length === 0) console.log('  (none)');
  for (const r of last4h) {
    console.log(`  ${r.symbol.padEnd(12)} ${(r.asset_type ?? '').padEnd(8)} ${r.count.toString()}`);
  }
}

main()
  .then(() => diagnoseWarmer())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('check-news-cron failed:', err);
    process.exit(1);
  });
