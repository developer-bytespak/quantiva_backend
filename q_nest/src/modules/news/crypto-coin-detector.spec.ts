/**
 * Unit tests for detectCoin().
 *
 * Run directly with ts-node:
 *   npx ts-node -T src/modules/news/crypto-coin-detector.spec.ts
 *
 * (Framework-free so it can be executed without Jest config.)
 */
import { detectCoin } from './crypto-coin-detector';

interface TestCase {
  title: string;
  expected: string | null;
  note?: string;
}

const cases: TestCase[] = [
  // Majors
  { title: 'Bitcoin Hits New All-Time High', expected: 'BTC' },
  { title: 'Ethereum Upgrade Launches Successfully', expected: 'ETH' },
  { title: 'Solana Network Outage Lasts 4 Hours', expected: 'SOL' },
  { title: 'XRP rally surprises markets', expected: 'XRP' },
  { title: 'Cardano unveils roadmap', expected: 'ADA' },
  { title: 'Dogecoin jumps after Musk tweet', expected: 'DOGE' },
  { title: 'Avalanche launches new subnet', expected: 'AVAX' },

  // Ticker-only forms
  { title: 'BTC price rallies past $100k', expected: 'BTC' },
  { title: 'ETH gas fees drop to 2024 lows', expected: 'ETH' },

  // No coin mentioned
  { title: 'Tom Lee: Current Crypto Drop Is a Healthy Reset', expected: null },
  {
    title:
      'An Illinois judge sentenced a Texas man to two decades in prison for orchestrating a $20 million scheme',
    expected: null,
  },
  {
    title: 'Is your crypto exchange SAFU? The four pillars every investor must check',
    expected: null,
  },

  // Priority: Bitcoin wins when both mentioned
  { title: 'Bitcoin vs Ethereum: Which Performs Better in 2026?', expected: 'BTC' },

  // Ambiguous tickers — should NOT match in prose
  {
    title: 'Sun Sets Over Pacific Coast',
    expected: null,
    note: 'SUN rejected — no crypto context, lowercase',
  },
  {
    title: 'Win big with our summer sale',
    expected: null,
    note: 'WIN rejected — no crypto context, lowercase',
  },
  {
    title: 'Key to success is consistency',
    expected: null,
    note: 'KEY rejected — no crypto context, lowercase',
  },

  // Ambiguous tickers — SHOULD match when in ALL CAPS or with crypto context
  { title: 'SUN token rallies 20% this week', expected: 'SUN', note: 'ALL CAPS ticker' },
  { title: 'LINK price pumps on Chainlink news', expected: 'LINK', note: 'ALL CAPS ticker' },

  // Case-insensitive for unambiguous coins
  { title: 'bitcoin hits new high', expected: 'BTC' },
  { title: 'ETHEREUM 2.0 LAUNCHES', expected: 'ETH' },

  // Substring edge cases that SHOULD NOT match
  { title: 'Ethical hackers find bug', expected: null, note: 'ETH must not match ETHICAL' },
  { title: 'Solution found to old problem', expected: null, note: 'SOL must not match SOLUTION' },
];

let passed = 0;
let failed = 0;

for (const tc of cases) {
  const got = detectCoin(tc.title);
  const ok = got === tc.expected;
  if (ok) {
    passed++;
    console.log(`  PASS  "${tc.title}" -> ${got}`);
  } else {
    failed++;
    const noteSuffix = tc.note ? ` (${tc.note})` : '';
    console.log(
      `  FAIL  "${tc.title}" -> got ${JSON.stringify(got)}, expected ${JSON.stringify(tc.expected)}${noteSuffix}`,
    );
  }
}

console.log();
console.log(`${passed}/${passed + failed} passed`);
if (failed > 0) {
  process.exit(1);
}
