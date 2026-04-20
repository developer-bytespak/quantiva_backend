/**
 * One-shot: lower take-profit percentages on the 4 pre-built STOCK strategies
 * already in the database. The TypeScript config has been updated to match,
 * but `seedPreBuiltStrategies()` only CREATEs new rows — existing rows need
 * this explicit UPDATE to pick up the new values.
 *
 * Idempotent: re-running is a no-op once values are already correct.
 *
 * Usage (from q_nest root):
 *   npx ts-node -T prisma/scripts/update-stock-tp-values.ts
 */
import { PrismaClient } from '@prisma/client';

// Keep in sync with pre-built-strategies.ts (source of truth).
// Only take_profit_value is being changed in this migration; stop_loss_value
// stays the same as it was already in a reasonable swing-trade range.
const STOCK_TP_UPDATES: Array<{
  name: string;
  take_profit_value: number;
  old_value: number; // for logging context
}> = [
  { name: 'Conservative Growth (Stocks)', take_profit_value: 10.0, old_value: 15.0 },
  { name: 'Tech Momentum (Stocks)',       take_profit_value: 12.0, old_value: 20.0 },
  { name: 'Value Investing (Stocks)',     take_profit_value: 12.0, old_value: 18.0 },
  { name: 'Dividend Income (Stocks)',     take_profit_value: 8.0,  old_value: 12.0 },
];

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    console.log('Updating stock pre-built strategy take_profit_value...\n');
    let updated = 0;
    let alreadyCorrect = 0;
    let missing = 0;

    for (const row of STOCK_TP_UPDATES) {
      const existing = await prisma.strategies.findFirst({
        where: { name: row.name, type: 'admin', asset_type: 'stock' },
        select: { strategy_id: true, take_profit_value: true, stop_loss_value: true },
      });
      if (!existing) {
        console.log(`  ${row.name.padEnd(32)} NOT FOUND — skipping`);
        missing++;
        continue;
      }
      const currentTp = Number(existing.take_profit_value ?? 0);
      if (Math.abs(currentTp - row.take_profit_value) < 0.001) {
        console.log(
          `  ${row.name.padEnd(32)} already ${row.take_profit_value}% — no change`,
        );
        alreadyCorrect++;
        continue;
      }
      await prisma.strategies.update({
        where: { strategy_id: existing.strategy_id },
        data: { take_profit_value: row.take_profit_value },
      });
      console.log(
        `  ${row.name.padEnd(32)} ${currentTp}% -> ${row.take_profit_value}%  (SL stays ${Number(existing.stop_loss_value ?? 0)}%)`,
      );
      updated++;
    }

    console.log();
    console.log('=== Summary ===');
    console.log(`  updated         : ${updated}`);
    console.log(`  already correct : ${alreadyCorrect}`);
    console.log(`  missing in DB   : ${missing}`);

    if (missing > 0) {
      console.log();
      console.log(
        'NOTE: missing strategies will be inserted with the new TP value on the next\n' +
          'application startup via seedPreBuiltStrategies(). No further action needed.',
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
