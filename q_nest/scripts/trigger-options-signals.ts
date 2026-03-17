/**
 * One-shot script to manually trigger OptionsSignalService.generateSignals()
 * Run: npx ts-node scripts/trigger-options-signals.ts
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { OptionsIvService } from '../src/modules/options/services/options-iv.service';
import { OptionsSignalService } from '../src/modules/options/services/options-signal.service';

async function main() {
  console.log('Bootstrapping app…');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['log', 'error', 'warn'] });

  const ivSvc = app.get(OptionsIvService);
  const signalSvc = app.get(OptionsSignalService);

  console.log('\n=== Step 1: Snapshot IV (populates options_iv_history) ===\n');
  await ivSvc.snapshotIv();

  console.log('\n=== Step 2: Generate AI signals (reads IV, calls Python, persists to DB) ===\n');
  await signalSvc.generateSignals();

  console.log('\n=== Done. Check options_iv_history and options_signals_ai tables in DB. ===');

  await app.close();
}

main().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
