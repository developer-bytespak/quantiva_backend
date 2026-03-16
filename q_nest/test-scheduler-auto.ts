/**
 * Test: Real Scheduler Test via API
 * 1. Create pool
 * 2. Join pool via API (creates reservation with expiry)
 * 3. Wait for scheduler to run (every 30 seconds)
 * 4. Check if scheduler automatically deleted the records
 */
import axios from 'axios';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const API_BASE = 'http://localhost:3000'; // Make sure backend is running

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function testSchedulerAuto() {
  try {
    console.log('========================================');
    console.log('TEST: Automatic Scheduler Deletion');
    console.log('========================================\n');
    console.log('⚠️  Make sure "npm run dev" is running in another terminal!\n');

    // STEP 1: Setup test data
    console.log('[SETUP] Creating test admin and user...');
    let adminId = await prisma.admins.findFirst({
      select: { admin_id: true },
      take: 1,
    }).then(a => a?.admin_id);

    if (!adminId) {
      const admin = await prisma.admins.create({
        data: {
          email: `testadmin-${Date.now()}@test.com`,
          password_hash: 'hash',
        },
        select: { admin_id: true },
      });
      adminId = admin.admin_id;
    }

    const user = await prisma.users.create({
      data: {
        email: `testuser-${Date.now()}@test.com`,
        username: `testuser-${Date.now()}`,
        kyc_status: 'approved',
        current_tier: 'PRO',
      },
      select: { user_id: true },
    });

    console.log(`✓ Admin ID: ${adminId}`);
    console.log(`✓ User ID: ${user.user_id}\n`);

    // STEP 2: Create pool with 1 minute payment window
    console.log('[STEP 1] Creating pool with 1 MINUTE payment window...');
    const pool = await prisma.vc_pools.create({
      data: {
        name: `Auto-Test Pool ${Date.now()}`,
        description: 'Testing automatic scheduler deletion',
        coin_type: 'USDT',
        contribution_amount: 100,
        pool_fee_percent: 5,
        admin_profit_fee_percent: 20,
        cancellation_fee_percent: 5,
        max_members: 5,
        payment_window_minutes: 1, // 1 minute
        duration_days: 7,
        status: 'open',
        admin_id: adminId,
      },
    });

    console.log(`✓ Pool created: ${pool.pool_id}`);
    console.log(`  Name: ${pool.name}`);
    console.log(`  Status: ${pool.status}`);
    console.log(`  Payment window: ${pool.payment_window_minutes} minute(s)\n`);

    // STEP 3: User joins pool
    console.log('[STEP 2] User joins pool...');
    
    let reservation;
    try {
      // Try via API first (if backend is running)
      const response = await axios.post(
        `${API_BASE}/api/user/pools/${pool.pool_id}/join`,
        { payment_method: 'binance' },
        {
          headers: {
            Authorization: `Bearer dummy-token-${user.user_id}`,
            'X-User-ID': user.user_id,
          },
        },
      );
      console.log(`✓ Joined via API`);
      console.log(`  Reservation ID: ${response.data.reservation_id}`);
      console.log(`  Expires at: ${response.data.deadline}`);
    } catch (err: any) {
      console.log('⚠️  API not available, using direct database insert...');
      
      const expiresAt = new Date(Date.now() + pool.payment_window_minutes * 60 * 1000);
      reservation = await prisma.vc_pool_seat_reservations.create({
        data: {
          pool_id: pool.pool_id,
          user_id: user.user_id,
          payment_method: 'binance',
          expires_at: expiresAt,
          status: 'reserved',
        },
      });

      await prisma.vc_pool_members.create({
        data: {
          pool_id: pool.pool_id,
          user_id: user.user_id,
          payment_method: 'binance',
          invested_amount_usdt: 100,
          share_percent: 0,
          is_active: false,
        },
      });

      await prisma.vc_pool_payment_submissions.create({
        data: {
          pool_id: pool.pool_id,
          user_id: user.user_id,
          reservation_id: reservation.reservation_id,
          payment_method: 'binance',
          investment_amount: 100,
          pool_fee_amount: 5,
          total_amount: 105,
          payment_deadline: expiresAt,
          status: 'pending',
        },
      });

      await prisma.vc_pools.update({
        where: { pool_id: pool.pool_id },
        data: { reserved_seats_count: { increment: 1 } },
      });

      console.log(`✓ Created via database`);
      console.log(`  Reservation ID: ${reservation.reservation_id}`);
      console.log(`  Expires at: ${reservation.expires_at.toISOString()}`);
    }

    // STEP 4: Check pool before expiry
    console.log('\n[STEP 3] Pool status BEFORE expiry:');
    let poolBefore = await prisma.vc_pools.findUnique({
      where: { pool_id: pool.pool_id },
      select: { reserved_seats_count: true, verified_members_count: true, max_members: true },
    });
    console.log(`  Reserved seats: ${poolBefore?.reserved_seats_count}`);
    console.log(`  Verified members: ${poolBefore?.verified_members_count}`);
    console.log(`  Available: ${(poolBefore?.max_members || 0) - (poolBefore?.reserved_seats_count || 0)}`);

    // STEP 5: Wait for expiry + scheduler
    console.log('\n[STEP 4] Waiting for expiry + scheduler to run...');
    console.log('         Payment window: 1 minute');
    console.log('         Scheduler runs: Every 30 seconds');
    console.log('         Total wait: ~65 seconds\n');
    console.log('         👀 WATCH THE DEV SERVER LOGS! You should see:');
    console.log('            [SCHEDULER] Checking for expired reservations...');
    console.log('            [UNDO JOIN] Deleted X record(s)...\n');

    for (let i = 0; i < 65; i++) {
      process.stdout.write(`         ${i + 1}s: `);
      if ((i + 1) % 30 === 0) {
        console.log('🔍 Scheduler should run NOW');
      } else if ((i + 1) === 60) {
        console.log('⏰ Reservation expired!');
      } else {
        console.log('waiting...');
      }
      await sleep(1000);
    }

    // STEP 6: Check if scheduler deleted
    console.log('\n[STEP 5] Checking if scheduler AUTOMATICALLY deleted records...\n');

    const checkRes = await prisma.vc_pool_seat_reservations.findUnique({
      where: { pool_id_user_id: { pool_id: pool.pool_id, user_id: user.user_id } },
    });

    const checkMem = await prisma.vc_pool_members.findUnique({
      where: { pool_id_user_id: { pool_id: pool.pool_id, user_id: user.user_id } },
    });

    const checkPay = await prisma.vc_pool_payment_submissions.findFirst({
      where: { pool_id: pool.pool_id, user_id: user.user_id },
    });

    let poolAfter = await prisma.vc_pools.findUnique({
      where: { pool_id: pool.pool_id },
      select: { reserved_seats_count: true, verified_members_count: true, max_members: true },
    });

    console.log('Results:');
    console.log(`  Reservation deleted: ${!checkRes ? '✓ YES' : '❌ NO'}`);
    console.log(`  Member deleted: ${!checkMem ? '✓ YES' : '❌ NO'}`);
    console.log(`  Payment deleted: ${!checkPay ? '✓ YES' : '❌ NO'}`);
    console.log(`  Reserved seats ${poolBefore?.reserved_seats_count} → ${poolAfter?.reserved_seats_count}: ${poolAfter?.reserved_seats_count === 0 ? '✓ Decremented' : '❌ NOT decremented'}`);

    if (!checkRes && !checkMem && !checkPay && poolAfter?.reserved_seats_count === 0) {
      console.log('\n✓ SCHEDULER WORKS! All records deleted automatically!\n');
    } else {
      console.log('\n❌ SCHEDULER NOT WORKING! Records still exist!\n');
      console.log('Debug info:');
      console.log(`  Reservation: ${checkRes ? checkRes.reservation_id : 'none'}`);
      console.log(`  Member: ${checkMem ? checkMem.member_id : 'none'}`);
      console.log(`  Payment: ${checkPay ? checkPay.submission_id : 'none'}`);
    }

    // Cleanup
    console.log('\nCleaning up test data...');
    await prisma.vc_pool_payment_submissions.deleteMany({
      where: { pool_id: pool.pool_id },
    });
    await prisma.vc_pool_seat_reservations.deleteMany({
      where: { pool_id: pool.pool_id },
    });
    await prisma.vc_pool_members.deleteMany({
      where: { pool_id: pool.pool_id },
    });
    await prisma.vc_pools.delete({
      where: { pool_id: pool.pool_id },
    });
    await prisma.users.delete({
      where: { user_id: user.user_id },
    });
    console.log('✓ Cleaned up\n');

  } catch (error) {
    console.error('\n❌ TEST ERROR:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

testSchedulerAuto();
