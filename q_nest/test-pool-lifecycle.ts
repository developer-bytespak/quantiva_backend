/**
 * VC Pool Complete Lifecycle Test
 * ================================
 * Flow:
 *   1. Admin creates pool (max 2 members)
 *   2. Admin publishes pool → open
 *   3. User1 joins → pays → admin approves
 *   4. User2 joins → pays → admin approves → pool auto-transitions to "full"
 *   5. Admin starts pool → "active"
 *   6. User1 tries to exit → BLOCKED (pool is active)
 *   7. Admin tries to delete pool → BLOCKED (not draft)
 *   8. Admin completes pool → creates payout records
 *   9. Admin marks payout for User1 as paid
 *  10. Admin marks payout for User2 as paid
 *  11. Verify pool is completed and all payouts done
 */

import * as http from 'http';
import * as jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const BASE_URL = 'http://localhost:3000';
const prisma = new PrismaClient();
const JWT_SECRET = 'your-super-secret-jwt-key-change-this-in-production-min-32-chars';

const ts = Date.now();

// Test users
const USER1 = { email: `lifecycle_u1_${ts}@test.com`, username: `lifecycle_u1_${ts}`, password: 'TestPass123!' };
const USER2 = { email: `lifecycle_u2_${ts}@test.com`, username: `lifecycle_u2_${ts}`, password: 'TestPass123!' };
const ADMIN = { email: `lifecycle_admin_${ts}@admin.com`, password: 'AdminPass123!' };

interface Ctx {
  user1Id: string; user1Token: string;
  user2Id: string; user2Token: string;
  adminId: string; adminToken: string;
  poolId: string;
  user1SubmissionId: string; user2SubmissionId: string;
  user1MemberId: string; user2MemberId: string;
}
const ctx: Partial<Ctx> = {};

let passed = 0;
let failed = 0;

// ── HTTP Helper ──

function makeRequest(method: string, path: string, body?: any, token?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL + path);
    const options = {
      method,
      hostname: url.hostname,
      port: 3000,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        ...(token && { Authorization: `Bearer ${token}` }),
      },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, body: parsed });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── Test Step Helper ──

async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error: any) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    → ${error.message || JSON.stringify(error)}`);
    throw error; // stop on failure
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

// ── Setup ──

async function setup() {
  console.log('\n  ── SETUP ──');

  // Register User1
  await step('Register User1', async () => {
    const res = await makeRequest('POST', '/auth/register', {
      email: USER1.email, username: USER1.username, password: USER1.password,
    });
    ctx.user1Id = res.body.user?.user_id;
    assert(!!ctx.user1Id, 'User1 ID missing');

    await prisma.users.update({
      where: { user_id: ctx.user1Id },
      data: { two_factor_enabled: false, current_tier: 'ELITE', kyc_status: 'approved' },
    });
    ctx.user1Token = jwt.sign(
      { sub: ctx.user1Id, email: USER1.email, username: USER1.username, current_tier: 'ELITE' },
      JWT_SECRET, { expiresIn: '45m' },
    );
  });

  // Register User2
  await step('Register User2', async () => {
    const res = await makeRequest('POST', '/auth/register', {
      email: USER2.email, username: USER2.username, password: USER2.password,
    });
    ctx.user2Id = res.body.user?.user_id;
    assert(!!ctx.user2Id, 'User2 ID missing');

    await prisma.users.update({
      where: { user_id: ctx.user2Id },
      data: { two_factor_enabled: false, current_tier: 'ELITE', kyc_status: 'approved' },
    });
    ctx.user2Token = jwt.sign(
      { sub: ctx.user2Id, email: USER2.email, username: USER2.username, current_tier: 'ELITE' },
      JWT_SECRET, { expiresIn: '45m' },
    );
  });

  // Create Admin
  await step('Create Admin', async () => {
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(ADMIN.password, salt);
    const admin = await prisma.admins.create({
      data: { email: ADMIN.email, password_hash: hash, full_name: 'Test Admin' },
    });
    ctx.adminId = admin.admin_id;
    await prisma.admins.update({
      where: { admin_id: ctx.adminId },
      data: { wallet_address: '0x' + '2'.repeat(40), binance_uid: 'test_binance_uid' },
    });
    ctx.adminToken = jwt.sign(
      { sub: ctx.adminId, email: ADMIN.email, role: 'admin' },
      JWT_SECRET, { expiresIn: '45m' },
    );
  });
}

// ── Test Steps ──

async function testCreateAndPublishPool() {
  console.log('\n  ── PHASE 1: Create & Publish Pool (max 2 members) ──');

  await step('Admin creates pool', async () => {
    const res = await makeRequest('POST', '/admin/pools', {
      name: `Lifecycle Test Pool ${ts}`,
      contribution_amount: 500,
      max_members: 2,
      duration_days: 30,
      pool_fee_percent: 5,
      admin_profit_fee_percent: 10,
      cancellation_fee_percent: 5,
      payment_window_minutes: 60,
    }, ctx.adminToken);
    assert(res.status < 300, `Create failed: ${JSON.stringify(res.body)}`);
    ctx.poolId = res.body.pool_id;
    assert(!!ctx.poolId, 'Pool ID missing');
  });

  await step('Admin publishes pool → open', async () => {
    const res = await makeRequest('PUT', `/admin/pools/${ctx.poolId}/publish`, {}, ctx.adminToken);
    assert(res.status < 300, `Publish failed: ${JSON.stringify(res.body)}`);
  });
}

async function testUser1Joins() {
  console.log('\n  ── PHASE 2: User1 Joins Pool ──');

  await step('User1 joins pool', async () => {
    const res = await makeRequest('POST', `/api/vc-pools/${ctx.poolId}/join`, {
      payment_method: 'binance',
      user_wallet_address: '0x' + 'a'.repeat(40),
    }, ctx.user1Token);
    assert(res.status < 300, `Join failed: ${JSON.stringify(res.body)}`);
    ctx.user1SubmissionId = res.body.submission_id;
    ctx.user1MemberId = res.body.member_id;
    assert(!!ctx.user1SubmissionId, 'User1 submission_id missing');
    assert(!!ctx.user1MemberId, 'User1 member_id missing');
  });

  await step('User1 submits TX', async () => {
    const hash = '0x' + Math.random().toString(16).substring(2).padEnd(64, '0');
    const res = await makeRequest('POST', `/api/vc-pools/${ctx.poolId}/submit-binance-tx`, {
      tx_hash: hash,
      binance_tx_id: `u1_tx_${ts}`,
      binance_tx_timestamp: new Date().toISOString(),
    }, ctx.user1Token);
    assert(res.status < 300, `TX submit failed: ${JSON.stringify(res.body)}`);
  });

  await step('Admin approves User1 payment', async () => {
    const res = await makeRequest('PUT', `/admin/pools/${ctx.poolId}/payments/${ctx.user1SubmissionId}/approve`, {
      admin_notes: 'User1 verified',
    }, ctx.adminToken);
    assert(res.status < 300, `Approve failed: ${JSON.stringify(res.body)}`);
  });

  await step('Verify pool is still "open" (1/2 members)', async () => {
    const pool = await prisma.vc_pools.findUnique({ where: { pool_id: ctx.poolId } });
    assert(pool!.status === 'open', `Expected open, got ${pool!.status}`);
    assert(pool!.verified_members_count === 1, `Expected 1 verified, got ${pool!.verified_members_count}`);
  });
}

async function testUser2Joins() {
  console.log('\n  ── PHASE 3: User2 Joins → Pool becomes "full" ──');

  await step('User2 joins pool', async () => {
    const res = await makeRequest('POST', `/api/vc-pools/${ctx.poolId}/join`, {
      payment_method: 'binance',
      user_wallet_address: '0x' + 'b'.repeat(40),
    }, ctx.user2Token);
    assert(res.status < 300, `Join failed: ${JSON.stringify(res.body)}`);
    ctx.user2SubmissionId = res.body.submission_id;
    ctx.user2MemberId = res.body.member_id;
  });

  await step('User2 submits TX', async () => {
    const hash = '0x' + Math.random().toString(16).substring(2).padEnd(64, '0');
    const res = await makeRequest('POST', `/api/vc-pools/${ctx.poolId}/submit-binance-tx`, {
      tx_hash: hash,
      binance_tx_id: `u2_tx_${ts}`,
      binance_tx_timestamp: new Date().toISOString(),
    }, ctx.user2Token);
    assert(res.status < 300, `TX submit failed: ${JSON.stringify(res.body)}`);
  });

  await step('Admin approves User2 payment → pool becomes "full"', async () => {
    const res = await makeRequest('PUT', `/admin/pools/${ctx.poolId}/payments/${ctx.user2SubmissionId}/approve`, {
      admin_notes: 'User2 verified',
    }, ctx.adminToken);
    assert(res.status < 300, `Approve failed: ${JSON.stringify(res.body)}`);
  });

  await step('Verify pool is now "full" (2/2 members)', async () => {
    const pool = await prisma.vc_pools.findUnique({ where: { pool_id: ctx.poolId } });
    assert(pool!.status === 'full', `Expected full, got ${pool!.status}`);
    assert(pool!.verified_members_count === 2, `Expected 2 verified, got ${pool!.verified_members_count}`);
  });
}

async function testStartPool() {
  console.log('\n  ── PHASE 4: Admin Starts Pool → "active" ──');

  await step('Admin starts pool', async () => {
    const res = await makeRequest('PUT', `/admin/pools/${ctx.poolId}/start`, {}, ctx.adminToken);
    assert(res.status < 300, `Start failed: ${JSON.stringify(res.body)}`);
  });

  await step('Verify pool is "active"', async () => {
    const pool = await prisma.vc_pools.findUnique({ where: { pool_id: ctx.poolId } });
    assert(pool!.status === 'active', `Expected active, got ${pool!.status}`);
    assert(!!pool!.started_at, 'started_at not set');
    assert(!!pool!.end_date, 'end_date not set');
    assert(Number(pool!.total_invested_usdt) === 1000, `Expected 1000 invested, got ${pool!.total_invested_usdt}`);
  });

  await step('Verify member share_percent calculated (50% each)', async () => {
    const m1 = await prisma.vc_pool_members.findUnique({ where: { member_id: ctx.user1MemberId } });
    const m2 = await prisma.vc_pool_members.findUnique({ where: { member_id: ctx.user2MemberId } });
    assert(Number(m1!.share_percent) === 50, `User1 share: ${m1!.share_percent}`);
    assert(Number(m2!.share_percent) === 50, `User2 share: ${m2!.share_percent}`);
  });
}

async function testExitBlockedWhenActive() {
  console.log('\n  ── PHASE 5: User tries to exit active pool → BLOCKED ──');

  await step('User1 tries to exit → should get 400 error', async () => {
    const res = await makeRequest('POST', `/api/vc-pools/${ctx.poolId}/request-exit`, {}, ctx.user1Token);
    assert(res.status === 400, `Expected 400, got ${res.status}`);
    assert(
      res.body.message?.includes('only allowed before the pool starts trading') ||
      res.body.message?.includes('Cancellation is only allowed'),
      `Unexpected error: ${res.body.message}`,
    );
  });

  await step('User2 also cannot exit', async () => {
    const res = await makeRequest('POST', `/api/vc-pools/${ctx.poolId}/request-exit`, {}, ctx.user2Token);
    assert(res.status === 400, `Expected 400, got ${res.status}`);
  });
}

async function testDeleteBlockedWhenNotDraft() {
  console.log('\n  ── PHASE 6: Admin cannot delete non-draft pool ──');

  await step('Admin tries to delete active pool → should get 400 error', async () => {
    const res = await makeRequest('DELETE', `/admin/pools/${ctx.poolId}`, undefined, ctx.adminToken);
    assert(res.status === 400, `Expected 400, got ${res.status}`);
    assert(
      res.body.message?.includes('Only draft pools can be deleted'),
      `Unexpected error: ${res.body.message}`,
    );
  });
}

async function testCompletePoolAndPayouts() {
  console.log('\n  ── PHASE 7: Admin completes pool → creates payouts ──');

  await step('Admin completes pool', async () => {
    const res = await makeRequest('PUT', `/admin/pools/${ctx.poolId}/complete`, {}, ctx.adminToken);
    assert(res.status < 300, `Complete failed: ${JSON.stringify(res.body)}`);
    assert(res.body.status === 'completed', `Expected completed, got ${res.body.status}`);
    assert(res.body.payouts_created === 2, `Expected 2 payouts, got ${res.body.payouts_created}`);
  });

  await step('Verify pool status is "completed"', async () => {
    const pool = await prisma.vc_pools.findUnique({ where: { pool_id: ctx.poolId } });
    assert(pool!.status === 'completed', `Expected completed, got ${pool!.status}`);
    assert(!!pool!.completed_at, 'completed_at not set');
  });

  await step('Verify payout records created for both users', async () => {
    const payouts = await prisma.vc_pool_payouts.findMany({
      where: { pool_id: ctx.poolId },
      orderBy: { created_at: 'asc' },
    });
    assert(payouts.length === 2, `Expected 2 payouts, got ${payouts.length}`);
    assert(payouts[0].status === 'pending', `Payout 1 status: ${payouts[0].status}`);
    assert(payouts[1].status === 'pending', `Payout 2 status: ${payouts[1].status}`);
    // No trades, so no PnL. Net payout = initial investment (no profit, no admin fee)
    assert(Number(payouts[0].net_payout) === 500, `Payout 1 net: ${payouts[0].net_payout}`);
    assert(Number(payouts[1].net_payout) === 500, `Payout 2 net: ${payouts[1].net_payout}`);
  });
}

async function testMarkPayoutsAsPaid() {
  console.log('\n  ── PHASE 8: Admin marks each payout as paid ──');

  const payouts = await prisma.vc_pool_payouts.findMany({
    where: { pool_id: ctx.poolId },
    orderBy: { created_at: 'asc' },
  });

  await step('Admin marks User1 payout as paid', async () => {
    const txHash = '0x' + Math.random().toString(16).substring(2).padEnd(64, '0');
    const res = await makeRequest('PUT', `/admin/pools/${ctx.poolId}/payouts/${payouts[0].payout_id}/mark-paid`, {
      binance_tx_id: txHash,
      notes: 'User1 payout sent',
    }, ctx.adminToken);
    assert(res.status < 300, `Mark paid failed: ${JSON.stringify(res.body)}`);
    assert(res.body.status === 'completed', `Expected completed, got ${res.body.status}`);
  });

  await step('Admin marks User2 payout as paid', async () => {
    const txHash = '0x' + Math.random().toString(16).substring(2).padEnd(64, '0');
    const res = await makeRequest('PUT', `/admin/pools/${ctx.poolId}/payouts/${payouts[1].payout_id}/mark-paid`, {
      binance_tx_id: txHash,
      notes: 'User2 payout sent',
    }, ctx.adminToken);
    assert(res.status < 300, `Mark paid failed: ${JSON.stringify(res.body)}`);
    assert(res.body.status === 'completed', `Expected completed, got ${res.body.status}`);
  });

  await step('Verify ALL payouts are "completed"', async () => {
    const allPayouts = await prisma.vc_pool_payouts.findMany({
      where: { pool_id: ctx.poolId },
    });
    const allCompleted = allPayouts.every(p => p.status === 'completed');
    assert(allCompleted, 'Not all payouts are completed');
  });

  await step('Final: pool is completed and all funds distributed', async () => {
    const pool = await prisma.vc_pools.findUnique({ where: { pool_id: ctx.poolId } });
    assert(pool!.status === 'completed', `Pool status: ${pool!.status}`);

    const pendingPayouts = await prisma.vc_pool_payouts.count({
      where: { pool_id: ctx.poolId, status: 'pending' },
    });
    assert(pendingPayouts === 0, `Still ${pendingPayouts} pending payouts`);
  });
}

// ── Main ──

async function run() {
  console.log('\n┌────────────────────────────────────────────────────────────┐');
  console.log('│  VC POOL COMPLETE LIFECYCLE TEST                           │');
  console.log('│  2 Users → Join → Active → Exit Blocked → Complete → Paid  │');
  console.log('└────────────────────────────────────────────────────────────┘');

  try {
    await setup();
    await testCreateAndPublishPool();
    await testUser1Joins();
    await testUser2Joins();
    await testStartPool();
    await testExitBlockedWhenActive();
    await testDeleteBlockedWhenNotDraft();
    await testCompletePoolAndPayouts();
    await testMarkPayoutsAsPaid();

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  RESULT: ${passed} passed, ${failed} failed`);
    console.log(`${'═'.repeat(60)}`);

    if (failed === 0) {
      console.log('\n  ✓✓✓ ALL TESTS PASSED ✓✓✓\n');
    } else {
      console.error('\n  ✗ SOME TESTS FAILED\n');
      process.exit(1);
    }
  } catch (error: any) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  RESULT: ${passed} passed, ${failed} failed`);
    console.log(`${'═'.repeat(60)}`);
    console.error('\n  ✗ TEST SUITE ABORTED\n');
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

run();
