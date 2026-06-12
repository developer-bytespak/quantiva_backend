/* Step 0 of reset-and-regenerate, standalone: wipe options_signals_ai and
 * let the DEPLOYED hourly cron regenerate (next tick, top of the hour).
 * Used when the local env can't reach the production Python engine.
 * Run: npx ts-node scripts/wipe-options-signals-only.ts
 */
import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  const before = await prisma.options_signals_ai.count();
  const result = await prisma.options_signals_ai.deleteMany({});
  console.log(`Deleted ${result.count} rows (was ${before}).`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
