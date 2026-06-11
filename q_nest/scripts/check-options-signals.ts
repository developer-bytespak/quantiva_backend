/* Inspect freshly generated AI options signals (post-deploy verification).
 * Run: npx ts-node scripts/check-options-signals.ts
 */
import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  const total = await prisma.options_signals_ai.count();
  console.log(`TOTAL=${total}`);
  if (total === 0) {
    await prisma.$disconnect();
    return;
  }
  const byVenue = await prisma.options_signals_ai.groupBy({
    by: ['venue'],
    _count: true,
  });
  for (const v of byVenue) console.log(`VENUE ${v.venue}: ${v._count}`);

  const alpaca = await prisma.options_signals_ai.findMany({
    where: { venue: 'ALPACA' },
    orderBy: { created_at: 'desc' },
    take: 30,
    select: {
      underlying: true,
      strategy: true,
      direction: true,
      score: true,
      confidence: true,
      iv_rank: true,
      spot_price: true,
      max_profit: true,
      max_loss: true,
      risk_reward: true,
      reasoning: true,
      created_at: true,
    },
  });
  for (const s of alpaca) {
    const reasoning = (s.reasoning ?? '').slice(0, 160).replace(/\n/g, ' ');
    console.log(
      `${s.underlying.padEnd(5)} ${s.strategy.padEnd(18)} ${s.direction.padEnd(8)} ` +
        `score=${s.score} conf=${s.confidence} spot=${s.spot_price} ` +
        `maxP=${s.max_profit} maxL=${s.max_loss} rr=${s.risk_reward}`,
    );
    console.log(`      ${reasoning}`);
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
