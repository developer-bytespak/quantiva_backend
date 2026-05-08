import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
async function main() {
  const c = await p.user_exchange_connections.count();
  const cActive = await p.user_exchange_connections.count({
    where: { status: 'active' as any },
  });
  const o = await p.orders.count();
  const o30 = await p.orders.count({
    where: { created_at: { gte: new Date(Date.now() - 30 * 24 * 3600 * 1000) } },
  });
  console.log('user_exchange_connections total:', c, 'active:', cActive);
  console.log('orders total:', o, 'last 30 days:', o30);

  // Sample: most recent buys per portfolio in last 30 days
  const recentBuys = await p.$queryRaw<{ symbol: string; cnt: bigint }[]>`
    SELECT a.symbol, COUNT(*) AS cnt
    FROM orders o
    JOIN portfolios pf ON pf.portfolio_id = o.portfolio_id
    JOIN strategy_signals s ON s.signal_id = o.signal_id
    JOIN assets a ON a.asset_id = s.asset_id
    WHERE o.side = 'BUY'
      AND o.created_at >= NOW() - INTERVAL '30 days'
    GROUP BY a.symbol
    ORDER BY cnt DESC
    LIMIT 10
  `;
  console.log('Top BUYs (last 30d via signals):', recentBuys);
}
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
