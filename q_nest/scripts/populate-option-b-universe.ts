/**
 * Populate the Option B stock universe.
 *
 * Steps:
 *   1. Seed `indexes` table with 8 index metadata rows (idempotent)
 *   2. Fetch all 5 working sources in parallel
 *   3. Dedupe symbols across sources
 *   4. Insert new assets (skip existing — preserves S&P 500 data)
 *   5. Insert index_membership rows (skip duplicates)
 *   6. Set primary_index_code on assets where NULL, in priority order
 *   7. Set exchange on assets where NULL
 *   8. Print summary
 *
 * Safety:
 *   - Idempotent: running twice is safe (existing rows untouched)
 *   - --dry-run flag: prints what would happen without DB writes
 *   - Only INSERTs + conditional UPDATEs (WHERE field IS NULL). No DELETEs.
 *
 * Usage:
 *   npx ts-node scripts/populate-option-b-universe.ts --dry-run
 *   npx ts-node scripts/populate-option-b-universe.ts
 */

import { PrismaClient } from '@prisma/client';
import { DowJonesService } from '../src/modules/stocks-market/services/index-sources/dow-jones.service';
import { WikipediaSp500Service } from '../src/modules/stocks-market/services/index-sources/wikipedia-sp500.service';
import { WikipediaSp400Service } from '../src/modules/stocks-market/services/index-sources/wikipedia-sp400.service';
import { NasdaqCompositeService } from '../src/modules/stocks-market/services/index-sources/nasdaq-composite.service';
import { NyseAmexListedService } from '../src/modules/stocks-market/services/index-sources/nyse-amex-listed.service';
import { IndexSourceService, IndexConstituent } from '../src/modules/stocks-market/services/index-sources/types';

const DRY_RUN = process.argv.includes('--dry-run');
const prisma = new PrismaClient();

interface IndexSeed {
  code: string;
  display_name: string;
  provider: string;
  reconstitution_cadence: string;
  source_url: string | null;
  is_derived: boolean;
}

const INDEX_SEEDS: IndexSeed[] = [
  {
    code: 'SP500',
    display_name: 'S&P 500',
    provider: 'S&P DJI',
    reconstitution_cadence: 'QUARTERLY',
    source_url: 'https://en.wikipedia.org/wiki/List_of_S%26P_500_companies',
    is_derived: false,
  },
  {
    code: 'DOW',
    display_name: 'Dow Jones Industrial Average',
    provider: 'S&P DJI',
    reconstitution_cadence: 'IRREGULAR',
    source_url: null,
    is_derived: false,
  },
  {
    code: 'SP_MIDCAP_400',
    display_name: 'S&P MidCap 400',
    provider: 'S&P DJI',
    reconstitution_cadence: 'QUARTERLY',
    source_url: 'https://en.wikipedia.org/wiki/List_of_S%26P_400_companies',
    is_derived: false,
  },
  {
    code: 'NASDAQ_COMPOSITE',
    display_name: 'Nasdaq Composite',
    provider: 'Nasdaq Inc.',
    reconstitution_cadence: 'CONTINUOUS',
    source_url: 'https://www.nasdaqtrader.com/dynamic/symdir/nasdaqlisted.txt',
    is_derived: false,
  },
  {
    code: 'NYSE_AMEX',
    display_name: 'NYSE / AMEX / NYSE ARCA Listed',
    provider: 'NYSE',
    reconstitution_cadence: 'CONTINUOUS',
    source_url: 'https://www.nasdaqtrader.com/dynamic/symdir/otherlisted.txt',
    is_derived: false,
  },
  {
    code: 'RUSSELL_1000',
    display_name: 'Russell 1000',
    provider: 'FTSE Russell',
    reconstitution_cadence: 'SEMI_ANNUAL',
    source_url: null,
    is_derived: true,
  },
  {
    code: 'RUSSELL_2000',
    display_name: 'Russell 2000',
    provider: 'FTSE Russell',
    reconstitution_cadence: 'SEMI_ANNUAL',
    source_url: null,
    is_derived: true,
  },
  {
    code: 'RUSSELL_MIDCAP',
    display_name: 'Russell Midcap',
    provider: 'FTSE Russell',
    reconstitution_cadence: 'SEMI_ANNUAL',
    source_url: null,
    is_derived: true,
  },
];

const PRIMARY_INDEX_PRIORITY = ['SP500', 'DOW', 'SP_MIDCAP_400', 'NASDAQ_COMPOSITE', 'NYSE_AMEX'];

function tag(prefix: string) {
  return DRY_RUN ? `[DRY] ${prefix}` : prefix;
}

async function seedIndexes(): Promise<Map<string, string>> {
  console.log(`\n${tag('[1/7]')} Seeding indexes table...`);
  const indexIdByCode = new Map<string, string>();
  let inserted = 0;
  let existing = 0;

  for (const seed of INDEX_SEEDS) {
    const existingRow = await prisma.indexes.findUnique({ where: { code: seed.code } });
    if (existingRow) {
      indexIdByCode.set(seed.code, existingRow.index_id);
      existing++;
      continue;
    }

    if (DRY_RUN) {
      indexIdByCode.set(seed.code, '(would-be-uuid)');
      inserted++;
      continue;
    }

    const created = await prisma.indexes.create({
      data: {
        code: seed.code,
        display_name: seed.display_name,
        provider: seed.provider,
        reconstitution_cadence: seed.reconstitution_cadence,
        source_url: seed.source_url,
        is_derived: seed.is_derived,
      },
    });
    indexIdByCode.set(seed.code, created.index_id);
    inserted++;
  }

  console.log(`       ✓ ${inserted} inserted, ${existing} already existed`);
  return indexIdByCode;
}

interface FetchedSource {
  code: string;
  symbols: IndexConstituent[];
}

async function fetchAllSources(): Promise<FetchedSource[]> {
  console.log(`\n${tag('[2/7]')} Fetching all 5 sources in parallel...`);
  const fetchStart = Date.now();

  const services: { code: string; service: IndexSourceService }[] = [
    { code: 'DOW', service: new DowJonesService() },
    { code: 'SP500', service: new WikipediaSp500Service() },
    { code: 'SP_MIDCAP_400', service: new WikipediaSp400Service() },
    { code: 'NASDAQ_COMPOSITE', service: new NasdaqCompositeService() },
    { code: 'NYSE_AMEX', service: new NyseAmexListedService() },
  ];

  const results = await Promise.all(
    services.map(async ({ code, service }) => {
      const r = await service.fetchConstituents();
      console.log(`       ✓ ${code.padEnd(20)} ${r.symbols.length} symbols`);
      return { code, symbols: r.symbols };
    }),
  );

  console.log(`       Done in ${((Date.now() - fetchStart) / 1000).toFixed(1)}s`);
  return results;
}

interface UniqueAsset {
  symbol: string;
  name: string | null;
  exchange: string | null;
}

const MAX_SYMBOL_LEN = 10;
const MAX_NAME_LEN = 200;

function buildUniqueAssetMap(sources: FetchedSource[]): Map<string, UniqueAsset> {
  console.log(`\n${tag('[3/7]')} Deduplicating across sources...`);
  const bySymbol = new Map<string, UniqueAsset>();
  let droppedLongSymbols = 0;
  let truncatedNames = 0;

  for (const { code, symbols } of sources) {
    const exchange = code === 'NASDAQ_COMPOSITE' ? 'NASDAQ' : code === 'NYSE_AMEX' ? 'NYSE' : null;

    for (const s of symbols) {
      if (s.symbol.length > MAX_SYMBOL_LEN) {
        droppedLongSymbols++;
        continue;
      }

      let name = s.name ?? null;
      if (name && name.length > MAX_NAME_LEN) {
        name = name.slice(0, MAX_NAME_LEN);
        truncatedNames++;
      }

      const existing = bySymbol.get(s.symbol);
      if (!existing) {
        bySymbol.set(s.symbol, {
          symbol: s.symbol,
          name,
          exchange,
        });
      } else {
        if (!existing.name && name) existing.name = name;
        if (!existing.exchange && exchange) existing.exchange = exchange;
      }
    }
  }

  console.log(`       ✓ ${bySymbol.size} unique symbols across ${sources.length} sources`);
  if (droppedLongSymbols > 0) {
    console.log(`       ⚠ Dropped ${droppedLongSymbols} symbols longer than ${MAX_SYMBOL_LEN} chars (preferred classes / rights / warrants)`);
  }
  if (truncatedNames > 0) {
    console.log(`       ⚠ Truncated ${truncatedNames} names to ${MAX_NAME_LEN} chars`);
  }
  return bySymbol;
}

async function insertNewAssets(uniqueAssets: Map<string, UniqueAsset>): Promise<{ inserted: number; existing: number }> {
  console.log(`\n${tag('[4/7]')} Inserting new assets (skipping existing)...`);

  const allSymbols = Array.from(uniqueAssets.keys());

  const existingRows = await prisma.assets.findMany({
    where: { symbol: { in: allSymbols }, asset_type: 'stock' },
    select: { symbol: true },
  });
  const existingSymbols = new Set(existingRows.map((r) => r.symbol).filter((s): s is string => !!s));

  const toInsert = Array.from(uniqueAssets.values()).filter((a) => !existingSymbols.has(a.symbol));

  console.log(`       Already in DB: ${existingSymbols.size} stocks`);
  console.log(`       New to insert: ${toInsert.length} stocks`);

  if (DRY_RUN) {
    console.log(`       ✓ Would insert ${toInsert.length} new assets`);
    return { inserted: toInsert.length, existing: existingSymbols.size };
  }

  if (toInsert.length === 0) {
    return { inserted: 0, existing: existingSymbols.size };
  }

  const result = await prisma.assets.createMany({
    data: toInsert.map((a) => ({
      symbol: a.symbol,
      name: a.name ?? undefined,
      asset_type: 'stock',
      is_active: true,
      exchange: a.exchange ?? undefined,
      first_seen_at: new Date(),
      last_seen_at: new Date(),
    })),
    skipDuplicates: true,
  });

  console.log(`       ✓ ${result.count} new assets inserted`);
  return { inserted: result.count, existing: existingSymbols.size };
}

async function insertMemberships(
  sources: FetchedSource[],
  indexIdByCode: Map<string, string>,
): Promise<number> {
  console.log(`\n${tag('[5/7]')} Inserting index_membership rows...`);

  if (DRY_RUN) {
    let totalRows = 0;
    for (const { code, symbols } of sources) {
      console.log(`       ${code.padEnd(20)} would insert up to ${symbols.length} memberships`);
      totalRows += symbols.length;
    }
    console.log(`       ✓ Would insert ~${totalRows} membership rows`);
    return totalRows;
  }

  const allSymbols = Array.from(new Set(sources.flatMap((s) => s.symbols.map((x) => x.symbol))));
  const assetRows = await prisma.assets.findMany({
    where: { symbol: { in: allSymbols }, asset_type: 'stock' },
    select: { asset_id: true, symbol: true },
  });
  const assetIdBySymbol = new Map<string, string>();
  for (const r of assetRows) {
    if (r.symbol) assetIdBySymbol.set(r.symbol, r.asset_id);
  }

  let totalInserted = 0;
  for (const { code, symbols } of sources) {
    const indexId = indexIdByCode.get(code);
    if (!indexId) {
      console.log(`       ⚠ Skipping ${code} — index_id not found`);
      continue;
    }

    const rows = symbols
      .map((s) => {
        const assetId = assetIdBySymbol.get(s.symbol);
        if (!assetId) return null;
        return {
          index_id: indexId,
          asset_id: assetId,
          symbol: s.symbol,
          weight: s.weight ?? undefined,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    if (rows.length === 0) continue;

    const result = await prisma.index_membership.createMany({
      data: rows,
      skipDuplicates: true,
    });
    console.log(`       ${code.padEnd(20)} ✓ ${result.count} memberships (${symbols.length} symbols, ${rows.length} matched)`);
    totalInserted += result.count;
  }

  return totalInserted;
}

async function setPrimaryIndexCode(): Promise<void> {
  console.log(`\n${tag('[6/7]')} Setting primary_index_code on assets where NULL...`);

  for (const code of PRIMARY_INDEX_PRIORITY) {
    if (DRY_RUN) {
      const count = await prisma.assets.count({
        where: {
          primary_index_code: null,
          asset_type: 'stock',
          index_memberships: { some: { index: { code } } },
        },
      });
      console.log(`       ${code.padEnd(20)} would tag ${count} assets`);
      continue;
    }

    const updated = await prisma.$executeRaw`
      UPDATE assets
      SET primary_index_code = ${code}
      WHERE primary_index_code IS NULL
        AND asset_type = 'stock'
        AND asset_id IN (
          SELECT im.asset_id
          FROM index_membership im
          JOIN indexes i ON i.index_id = im.index_id
          WHERE i.code = ${code}
        )
    `;
    console.log(`       ${code.padEnd(20)} ✓ ${updated} assets tagged`);
  }
}

async function setExchange(): Promise<void> {
  console.log(`\n${tag('[7/7]')} Setting exchange on assets where NULL...`);

  const exchangeMap: { code: string; exchange: string }[] = [
    { code: 'NASDAQ_COMPOSITE', exchange: 'NASDAQ' },
    { code: 'NYSE_AMEX', exchange: 'NYSE' },
  ];

  for (const { code, exchange } of exchangeMap) {
    if (DRY_RUN) {
      const count = await prisma.assets.count({
        where: {
          exchange: null,
          asset_type: 'stock',
          index_memberships: { some: { index: { code } } },
        },
      });
      console.log(`       ${exchange.padEnd(20)} would tag ${count} assets`);
      continue;
    }

    const updated = await prisma.$executeRaw`
      UPDATE assets
      SET exchange = ${exchange}
      WHERE exchange IS NULL
        AND asset_type = 'stock'
        AND asset_id IN (
          SELECT im.asset_id
          FROM index_membership im
          JOIN indexes i ON i.index_id = im.index_id
          WHERE i.code = ${code}
        )
    `;
    console.log(`       ${exchange.padEnd(20)} ✓ ${updated} assets tagged`);
  }
}

async function printSummary(): Promise<void> {
  console.log('\n========================================');
  if (DRY_RUN) {
    console.log('  DRY RUN COMPLETE — no DB changes made');
    console.log('========================================\n');
    return;
  }

  const totalStocks = await prisma.assets.count({ where: { asset_type: 'stock' } });
  const totalMemberships = await prisma.index_membership.count();
  const byIndex = await prisma.$queryRaw<{ code: string; count: bigint }[]>`
    SELECT i.code, COUNT(im.asset_id)::bigint AS count
    FROM indexes i
    LEFT JOIN index_membership im ON im.index_id = i.index_id
    GROUP BY i.code
    ORDER BY count DESC
  `;

  console.log(`  Total stocks in DB:        ${totalStocks}`);
  console.log(`  Total membership rows:     ${totalMemberships}`);
  console.log('  ----------------------------------------');
  for (const row of byIndex) {
    console.log(`  ${row.code.padEnd(20)} ${row.count} stocks`);
  }
  console.log('========================================\n');
}

async function main() {
  const banner = DRY_RUN
    ? '╔══════════════════════════════════════════════╗\n║  DRY RUN — no database changes will be made  ║\n╚══════════════════════════════════════════════╝'
    : '╔══════════════════════════════════════════════╗\n║  REAL RUN — database will be modified         ║\n╚══════════════════════════════════════════════╝';
  console.log(banner);

  const startTime = Date.now();

  const indexIdByCode = await seedIndexes();
  const sources = await fetchAllSources();
  const uniqueAssets = buildUniqueAssetMap(sources);
  await insertNewAssets(uniqueAssets);
  await insertMemberships(sources, indexIdByCode);
  await setPrimaryIndexCode();
  await setExchange();
  await printSummary();

  console.log(`Total time: ${((Date.now() - startTime) / 1000).toFixed(1)}s\n`);
}

main()
  .catch((err) => {
    console.error('\n✗ FATAL ERROR:', err.message);
    console.error(err.stack);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
