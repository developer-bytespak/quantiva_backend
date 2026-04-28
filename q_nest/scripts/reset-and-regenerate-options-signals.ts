/**
 * One-shot: WIPE all rows from options_signals_ai, then re-run the same
 * cronjob the platform uses every 2h to regenerate fresh signals.
 *
 * Run: npx ts-node scripts/reset-and-regenerate-options-signals.ts
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { OptionsIvService } from '../src/modules/options/services/options-iv.service';
import { OptionsSignalService } from '../src/modules/options/services/options-signal.service';

async function main() {
  console.log('Bootstrapping app…');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'error', 'warn'],
  });

  const prisma = app.get(PrismaService);
  const ivSvc = app.get(OptionsIvService);
  const signalSvc = app.get(OptionsSignalService);

  console.log('\n=== Step 0: Delete ALL existing AI options signals ===\n');
  const before = await prisma.options_signals_ai.count();
  const result = await prisma.options_signals_ai.deleteMany({});
  console.log(`Deleted ${result.count} rows (was ${before}).`);

  console.log('\n=== Step 1: Snapshot IV (populates options_iv_history) ===\n');
  await ivSvc.snapshotIv();

  console.log('\n=== Step 2: Generate AI signals (cronjob path) ===\n');
  await signalSvc.generateSignals();

  const after = await prisma.options_signals_ai.count();
  console.log(`\n=== Done. options_signals_ai now has ${after} rows. ===`);

  await app.close();
}

main().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
