/**
 * Test harness for index sourcing services.
 *
 * Usage:
 *   npx ts-node scripts/test-index-source.ts <source-name>
 */

import { DowJonesService } from '../src/modules/stocks-market/services/index-sources/dow-jones.service';
import { WikipediaSp500Service } from '../src/modules/stocks-market/services/index-sources/wikipedia-sp500.service';
import { WikipediaSp400Service } from '../src/modules/stocks-market/services/index-sources/wikipedia-sp400.service';
import { NasdaqCompositeService } from '../src/modules/stocks-market/services/index-sources/nasdaq-composite.service';
import { NyseAmexListedService } from '../src/modules/stocks-market/services/index-sources/nyse-amex-listed.service';
import { IndexSourceService } from '../src/modules/stocks-market/services/index-sources/types';

const sources: Record<string, () => IndexSourceService> = {
  'dow-jones': () => new DowJonesService(),
  'wikipedia-sp500': () => new WikipediaSp500Service(),
  'wikipedia-sp400': () => new WikipediaSp400Service(),
  'nasdaq-composite': () => new NasdaqCompositeService(),
  'nyse-amex-listed': () => new NyseAmexListedService(),
};

async function main() {
  const sourceName = process.argv[2];

  if (!sourceName || !sources[sourceName]) {
    console.error('Usage: npx ts-node scripts/test-index-source.ts <source-name>');
    console.error(`Available sources: ${Object.keys(sources).join(', ')}`);
    process.exit(1);
  }

  const service = sources[sourceName]();
  console.log(`\n[${service.indexCode}] Fetching constituents for "${service.displayName}"...`);

  const start = Date.now();
  const result = await service.fetchConstituents();
  const elapsedMs = Date.now() - start;

  console.log(`\n✓ Fetched ${result.symbols.length} symbols in ${elapsedMs}ms`);
  console.log(`  Source: ${result.sourceUrl}`);
  console.log(`  Fetched at: ${result.fetchedAt.toISOString()}`);

  const first10 = result.symbols.slice(0, 10).map((s) => s.symbol).join(', ');
  console.log(`\n  First 10: ${first10}`);

  if (result.symbols.length > 10) {
    const last5 = result.symbols.slice(-5).map((s) => s.symbol).join(', ');
    console.log(`  Last 5:   ${last5}`);
  }

  const withNames = result.symbols.filter((s) => s.name).length;
  if (withNames > 0) {
    console.log(`\n  ${withNames} symbols have names attached`);
    const sample = result.symbols.find((s) => s.name);
    if (sample) {
      console.log(`  Example: ${sample.symbol} -> "${sample.name}"`);
    }
  }

  console.log('');
}

main().catch((err) => {
  console.error('\n✗ Error:', err.message);
  if (err.stack) {
    console.error(err.stack.split('\n').slice(1, 4).join('\n'));
  }
  process.exit(1);
});
