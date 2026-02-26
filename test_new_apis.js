/**
 * New APIs check: strategy endpoints with admin JWT + POST .../trades/from-signal.
 * Run with server on PORT=3333 (e.g. in q_nest: PORT=3333 npm run start).
 * Requires: temporary POST /admin/auth/seed-test and POST /admin/auth/set-elite-test
 * (or use real admin login + 2 ELITE user tokens and set ADMIN_TOKEN, USER1_TOKEN, USER2_TOKEN below).
 */
const http = require('http');

const BASE = process.env.BASE || 'http://localhost:3333';
let ADMIN_TOKEN = '';
let USER1_TOKEN = '';
let USER2_TOKEN = '';
let POOL_ID = '';

function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (token) opts.headers['Authorization'] = `Bearer ${token}`;
    const r = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

let pass = 0, fail = 0;
function test(name, actual, expected) {
  if (actual === expected) { console.log(`  PASS: ${name} (${actual})`); pass++; }
  else { console.log(`  FAIL: ${name} — expected ${expected}, got ${actual}`); fail++; }
}

async function run() {
  console.log('=== New APIs check (strategy + from-signal) ===\n');

  console.log('--- Setup ---');
  let r = await req('POST', '/admin/auth/seed-test');
  test('Seed admin', r.status, 200);

  r = await req('POST', '/admin/auth/login', { email: 'admin@quantiva.io', password: 'TestAdmin@123' });
  test('Admin login', r.status, 200);
  ADMIN_TOKEN = r.body.accessToken;

  r = await req('POST', '/admin/auth/set-elite-test', { email: 'baqar.abbas1000@gmail.com' });
  test('Set user1 ELITE', r.status, 200);
  USER1_TOKEN = r.body.token;

  r = await req('POST', '/admin/auth/set-elite-test', { email: 'aymi.coding@gmail.com' });
  test('Set user2 ELITE', r.status, 200);
  USER2_TOKEN = r.body.token;

  console.log('\n--- Strategy endpoints with ADMIN JWT ---');
  r = await req('GET', '/strategies/pre-built', null, ADMIN_TOKEN);
  test('GET /strategies/pre-built (admin JWT)', r.status, 200);
  const strategies = Array.isArray(r.body) ? r.body : (r.body.strategies || r.body.data || []);
  const strategyId = strategies[0]?.strategy_id || strategies[0]?.id;
  if (strategyId) {
    console.log(`  First strategy id: ${strategyId}`);
    r = await req('GET', `/strategies/pre-built/${strategyId}/signals?latest_only=true`, null, ADMIN_TOKEN);
    test('GET /strategies/pre-built/:id/signals (admin JWT)', r.status, 200);
    const signals = Array.isArray(r.body) ? r.body : (r.body.signals || r.body.data || r.body);
    const signalList = Array.isArray(signals) ? signals : [];
    console.log(`  Signals count: ${signalList.length}`);
  } else {
    console.log('  No strategies returned, skipping signals test');
  }

  console.log('\n--- Create + fill pool + start ---');
  r = await req('POST', '/admin/pools', {
    name: 'New APIs Test Pool',
    contribution_amount: 100,
    max_members: 2,
    duration_days: 30,
  }, ADMIN_TOKEN);
  test('Create pool', r.status, 201);
  POOL_ID = r.body.pool_id;

  r = await req('PUT', `/admin/pools/${POOL_ID}/publish`, {}, ADMIN_TOKEN);
  test('Publish pool', r.status, 200);

  r = await req('POST', `/api/vc-pools/${POOL_ID}/join`, { payment_method: 'stripe' }, USER1_TOKEN);
  test('User1 join', r.status, 201);
  r = await req('POST', `/api/vc-pools/${POOL_ID}/join`, { payment_method: 'stripe' }, USER2_TOKEN);
  test('User2 join', r.status, 201);

  r = await req('GET', `/admin/pools/${POOL_ID}/payments`, null, ADMIN_TOKEN);
  test('List payments', r.status, 200);
  const payments = r.body.submissions || r.body.payments || [];
  for (let i = 0; i < payments.length; i++) {
    r = await req('PUT', `/admin/pools/${POOL_ID}/payments/${payments[i].submission_id}/approve`, {}, ADMIN_TOKEN);
    test(`Approve payment ${i + 1}`, r.status, 200);
  }

  r = await req('PUT', `/admin/pools/${POOL_ID}/start`, {}, ADMIN_TOKEN);
  test('Start pool', r.status, 200);

  console.log('\n--- POST /admin/pools/:poolId/trades/from-signal ---');
  let signalId = null;
  if (strategyId) {
    r = await req('GET', `/strategies/pre-built/${strategyId}/signals?latest_only=true`, null, ADMIN_TOKEN);
    const signals = Array.isArray(r.body) ? r.body : (r.body.signals || r.body.data || r.body);
    const list = Array.isArray(signals) ? signals : [];
    for (const s of list) {
      if (s.asset?.asset_type !== 'stock' && s.action !== 'HOLD' && s.details?.[0]?.entry_price) {
        signalId = s.signal_id || s.id;
        break;
      }
    }
  }
  if (signalId) {
    r = await req('POST', `/admin/pools/${POOL_ID}/trades/from-signal`, { signal_id: signalId }, ADMIN_TOKEN);
    test('POST .../trades/from-signal (apply signal)', r.status, 201);
    if (r.status === 201) console.log(`  Trade id: ${r.body.trade_id}, asset_pair: ${r.body.asset_pair}`);
  } else {
    console.log('  SKIP: No crypto BUY/SELL signal with details found (run pre-built signals cron to generate)');
    r = await req('POST', `/admin/pools/${POOL_ID}/trades/from-signal`, { signal_id: '00000000-0000-0000-0000-000000000000' }, ADMIN_TOKEN);
    test('POST .../from-signal with invalid id → 404', r.status, 404);
  }

  console.log('\n--- Manual trade still works ---');
  r = await req('POST', `/admin/pools/${POOL_ID}/trades`, {
    asset_pair: 'BTCUSDT',
    action: 'BUY',
    quantity: 0.001,
    entry_price_usdt: 60000,
  }, ADMIN_TOKEN);
  test('POST .../trades (manual)', r.status, 201);

  console.log(`\n=== RESULTS: ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error('FATAL:', e); process.exit(1); });
