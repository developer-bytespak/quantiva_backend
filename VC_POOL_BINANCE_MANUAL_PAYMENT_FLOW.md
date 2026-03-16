# VC Pool — Binance Network Deposit Payment Flow with Automatic Verification

**Current, active implementation (as of 2026-03-07)**

**Core concept:** Users send USDT to admin's mainnet (network) deposit address. Backend automatically verifies deposits every 5 minutes using admin's Binance API keys. Exact match only — no tolerance for network fees. All transactions stored in DB for complete audit trail and automatic verification.

**Key change from previous P2P flow:** 
- ❌ OLD: P2P transfer + TX ID submission + manual admin review
- ✅ NEW: Mainnet network deposit + automatic verification via admin's Binance API keys

---

## 1. Executive Summary

| Stage | User Action | Backend Action | Admin Action | Status |
|-------|---|---|---|---|
| **Join** | Transfer to address | Cron checks every 5 min, auto-verifies | None (fully automated) | Auto-confirmed |
| **Pool Complete** | None | Batch fetch pending payouts | Click "Pay All" button | Backend auto-verifies via cron |
| **User Cancel** | Request exit | Calculate refund | Approve + system auto-transfers | Backend auto-verifies via cron |
| **Admin Cancel** | N/A | Calculate full refunds | Click "Cancel Pool" | Backend auto-verifies via cron |

**Key principle:** "Automatic verification via blockchain"
- User sends USDT to admin's mainnet address
- Cron job checks admin's Binance deposit history every 5 minutes
- Exact amount match → Instantly approved
- No manual steps, no TX ID submission, no admin approval needed

---

## 2. Database Schema (New Models)

### 2.1 New Table: `vc_pool_transactions`

**Purpose:** Comprehensive audit trail of all payment-related transactions (joins, payouts, refunds).

```prisma
model vc_pool_transactions {
  tx_id                 String                  @id @default(uuid()) @db.Uuid
  
  // Links to related entities
  payment_submission_id String?                 @db.Uuid
  payout_id             String?                 @db.Uuid
  cancellation_id       String?                 @db.Uuid
  
  pool_id               String                  @db.Uuid
  user_id               String?                 @db.Uuid  // Who benefits
  admin_id              String                  @db.Uuid  // Who initiated
  
  // Binance TX details
  binance_tx_id         String                  @db.VarChar(255) @unique
  tx_type               String                  @db.VarChar(50)  // "join", "payout", "refund", "cancelled_pool_refund"
  
  amount_usdt           Decimal                 @db.Decimal(20, 8)
  coin                  String                  @default("USDT") @db.VarChar(10)
  network               String                  @db.VarChar(30)  // "BEP20", "ERC20", "SOL", etc
  
  // Direction of funds
  sender_address        String?                 @db.VarChar(255)  // For incoming (user → admin)
  sender_binance_uid    String?                 @db.VarChar(100)  // For auditing
  
  recipient_address     String?                 @db.VarChar(255)  // For outgoing (admin → user)
  recipient_binance_uid String?                 @db.VarChar(100)  // User's UID
  
  // Verification status
  status                String                  @db.VarChar(50)  // "pending", "confirmed", "failed", "cancelled"
  verification_method   String?                 @db.VarChar(50)  // "admin_api", "user_api", "both", "blockchain"
  
  // Raw Binance response (for debugging/audit)
  binance_response_json Json?
  
  // Timing
  verified_at           DateTime?               @db.Timestamp(6)
  created_at            DateTime                @default(now()) @db.Timestamp(6)
  updated_at            DateTime?               @updatedAt @db.Timestamp(6)
  
  // Notes
  admin_notes           String?                 @db.Text
  
  // Relations
  payment_submission    vc_pool_payment_submissions?  @relation("TransactionPaymentSubmission", fields: [payment_submission_id], references: [submission_id], onDelete: SetNull)
  payout                vc_pool_payouts?       @relation("TransactionPayout", fields: [payout_id], references: [payout_id], onDelete: SetNull)
  cancellation          vc_pool_cancellations? @relation("TransactionCancellation", fields: [cancellation_id], references: [cancellation_id], onDelete: SetNull)
  pool                  vc_pools                @relation(fields: [pool_id], references: [pool_id])
  user                  users?                  @relation(fields: [user_id], references: [user_id])
  admin                 admins                  @relation(fields: [admin_id], references: [admin_id])
  
  @@index([binance_tx_id])
  @@index([payment_submission_id])
  @@index([payout_id])
  @@index([cancellation_id])
  @@index([tx_type])
  @@index([status])
  @@index([user_id])
  @@index([pool_id])
  @@map("vc_pool_transactions")
}
```

### 2.2 Modified Table: `vc_pool_payment_submissions`

Add fields to track verification details:

```prisma
model vc_pool_payment_submissions {
  // existing fields...
  
  // Binance TX details (user submits)
  binance_tx_id               String?               @db.VarChar(255)
  user_binance_address        String?               @db.VarChar(255)  // User's actual Binance address
  user_binance_network        String?               @db.VarChar(30)   // User's preferred network
  
  // Verification details (backend stores after API check)
  verified_via_api            Boolean               @default(false)
  verification_checked_at     DateTime?             @db.Timestamp(6)
  binance_deposit_amount      Decimal?              @db.Decimal(20, 8)  // What we actually found in admin's deposits
  binance_deposit_confirmed   Boolean               @default(false)      // Confirmed on-chain
  binance_sender_address      String?               @db.VarChar(255)     // Who actually sent it
  
  // Relation to transaction record
  transaction                 vc_pool_transactions? @relation("TransactionPaymentSubmission")

  @@map("vc_pool_payment_submissions")
}
```

### 2.3 Modified Table: `vc_pool_payouts`

Add transaction tracking:

```prisma
model vc_pool_payouts {
  // existing fields...
  
  // Transaction record
  transaction_id              String?               @db.Uuid
  transaction                 vc_pool_transactions? @relation("TransactionPayout", fields: [transaction_id], references: [tx_id])

  @@map("vc_pool_payouts")
}
```

### 2.4 Modified Table: `vc_pool_cancellations`

Add transaction tracking:

```prisma
model vc_pool_cancellations {
  // existing fields...
  
  // Transaction record
  transaction_id              String?               @db.Uuid
  transaction                 vc_pool_transactions? @relation("TransactionCancellation", fields: [transaction_id], references: [tx_id])

  @@map("vc_pool_cancellations")
}
```

### 2.5 Modified Table: `admins`

Add deposit address configuration:

```prisma
model admins {
  // existing fields...
  
  // Binance deposit address for join payments
  binance_deposit_address_usdt String?              @db.VarChar(255)
  binance_deposit_network       String?              @db.VarChar(30)  // "BEP20", "ERC20", "SOL", etc
  
  // Relations
  transactions                  vc_pool_transactions[]

  @@map("admins")
}
```

---

## 3. Join Flow — Binance Manual Transfer with TX Verification

### 3.1 User Flow

```
Step 1: User clicks "Join Pool"
  ├─ Sees pool details: amount required (100 USDT), fees (5%), total (105 USDT)
  ├─ Seat reserved (30 min timer starts)
  ├─ Shown admin's Binance payment instructions
  │   ├─ Admin's Binance UID: "12345678"
  │   ├─ Amount: "105.00 USDT"
  │   ├─ Network: "BEP-20" (BSC)
  │   ├─ Coin: "USDT"
  │   └─ Deadline: "in 30 minutes"
  └─ Instructions:
      1. Open Binance app
      2. Go to Transfer → Internal Transfer
      3. Recipient: enter UID "12345678"
      4. Amount: "105.00"
      5. Coin: "USDT"
      6. Network: ensure it's BEP-20
      7. Send
      8. Copy the Transaction ID (from Binance confirmation)
      9. Return to Quantiva and paste TX ID
      10. Click "Verify & Join"

Step 2: Backend receives TX ID submission
  POST /api/vc-pools/:poolId/payment/verify-and-join
  Body: { 
    binance_tx_id: "abc123xyz789",
    user_binance_address: "0x...",  // user's own address (for future refunds)
    user_binance_network: "BEP20"
  }
  
Step 3: Backend verification (automatic)
  ├─ Validate TX ID format (not empty, reasonable length)
  ├─ Check if TX ID already used (prevent duplicates)
  ├─ Fetch admin's deposit history via admin's Binance API
  ├─ Find matching TX in history
  ├─ Validate:
  │   ├─ Amount matches expected total (105.00 USDT)
  │   ├─ Timestamp is within payment deadline
  │   └─ TX status is "success" (confirmed on-chain)
  ├─ Save to vc_pool_transactions (status: "confirmed")
  ├─ Create member record
  ├─ Confirm seat reservation
  └─ Return success

Step 4: User is now a pool member
  └─ Sees confirmation: "Payment verified! You're in the pool."
```

### 3.2 Backend Implementation

```typescript
// Service: payments.service.ts

async verifyBinanceTxAndJoin(
  poolId: string,
  userId: string,
  binanceTxId: string,
  userBinanceAddress: string,
  userBinanceNetwork: string
): Promise<{ 
  success: boolean;
  member_id?: string;
  transaction_id?: string;
  message: string;
  errors?: string[]
}> {
  
  const errors = [];
  
  // 1. Get pool, payment submission, reservation
  const pool = await getPool(poolId);
  const submission = await getPaymentSubmission(poolId, userId, "pending");
  const reservation = await getReservation(submission.reservation_id);
  
  if (!submission) throw new Error("No pending payment submission");
  if (!reservation) throw new Error("Reservation not found");
  if (reservation.expires_at < now()) throw new Error("Reservation expired");
  
  // 2. Prevent duplicate TX IDs
  const existingTx = await vc_pool_transactions.findUnique({ 
    where: { binance_tx_id: binanceTxId } 
  });
  if (existingTx) throw new Error(`TX ${binanceTxId} already processed`);
  
  // 3. Fetch admin's Binance deposit history
  const admin = await getAdmin(pool.admin_id);
  let adminDepositHistory;
  
  try {
    adminDepositHistory = await BinanceService.getDepositHistory(
      decrypt(admin.binance_api_key_encrypted),
      decrypt(admin.binance_api_secret_encrypted),
      {
        coin: 'USDT',
        limit: 100,
        startTime: pool.created_at - (24 * 60 * 60 * 1000)  // Last 24 hours
      }
    );
  } catch (error) {
    errors.push(`Cannot fetch admin Binance history: ${error.message}`);
    throw { errors, message: "Could not verify transaction. Admin API error." };
  }
  
  // 4. Find matching TX
  const matchingDeposit = adminDepositHistory.find(
    (deposit) => deposit.txId === binanceTxId || deposit.id === binanceTxId
  );
  
  if (!matchingDeposit) {
    // Save failed attempt for audit
    await createFailedTransaction({
      binance_tx_id: binanceTxId,
      tx_type: 'join',
      status: 'failed',
      pool_id: poolId,
      user_id: userId,
      admin_id: admin.admin_id,
      admin_notes: 'TX not found in deposit history'
    });
    
    errors.push('TX ID not found in admin Binance deposit history');
    throw { 
      errors, 
      message: "Cannot find this TX. Please verify on Binance and try again.",
      help: "Make sure you sent the funds to the correct admin UID and used the correct network."
    };
  }
  
  // 5. Validate transaction details
  
  // ✓ Amount check
  if (parseFloat(matchingDeposit.amount) !== parseFloat(submission.total_amount)) {
    errors.push(
      `Amount mismatch: expected ${submission.total_amount}, found ${matchingDeposit.amount}`
    );
  }
  
  // ✓ Timestamp check
  if (matchingDeposit.insertTime > submission.payment_deadline) {
    errors.push(
      `Payment is late: deadline was ${submission.payment_deadline}, received at ${matchingDeposit.insertTime}`
    );
  }
  
  // ✓ Status check
  if (matchingDeposit.status !== 'success') {
    errors.push(
      `Transaction not confirmed. Status: ${matchingDeposit.status}`
    );
  }
  
  // 6. If there are shortfalls or issues, handle differently
  if (errors.length > 0) {
    await createFailedTransaction({
      binance_tx_id: binanceTxId,
      tx_type: 'join',
      status: 'failed',
      pool_id: poolId,
      user_id: userId,
      admin_id: admin.admin_id,
      admin_notes: errors.join('; ')
    });
    
    throw {
      errors,
      message: "Transaction validation failed",
      allow_manual_approval: true  // Flag for admin to review manually
    };
  }
  
  // 7. Save transaction to DB
  const savedTx = await createTransaction({
    binance_tx_id: binanceTxId,
    tx_type: 'join',
    amount_usdt: matchingDeposit.amount,
    coin: 'USDT',
    network: submission.user_binance_network || 'BEP20',
    sender_address: matchingDeposit.fromAddress || 'unknown',
    recipient_address: admin.binance_deposit_address_usdt || matchingDeposit.toAddress,
    status: 'confirmed',
    verification_method: 'admin_api',
    binance_response_json: matchingDeposit,
    verified_at: now(),
    pool_id: poolId,
    user_id: userId,
    admin_id: admin.admin_id,
    payment_submission_id: submission.submission_id
  });
  
  // 8. Update payment submission
  await updatePaymentSubmission(submission.submission_id, {
    binance_tx_id: binanceTxId,
    verified_via_api: true,
    verification_checked_at: now(),
    binance_deposit_amount: matchingDeposit.amount,
    binance_deposit_confirmed: true,
    binance_sender_address: matchingDeposit.fromAddress,
    status: 'verified'
  });
  
  // 9. Create member
  const member = await createMember({
    pool_id: poolId,
    user_id: userId,
    payment_method: 'binance',
    invested_amount_usdt: submission.investment_amount,
    binance_address: userBinanceAddress,
    binance_network: userBinanceNetwork
  });
  
  // 10. Confirm reservation
  await updateReservation(reservation.reservation_id, {
    status: 'confirmed'
  });
  
  // 11. Update pool counters
  await updatePool(poolId, {
    verified_members_count: { increment: 1 }
  });
  
  return {
    success: true,
    member_id: member.member_id,
    transaction_id: savedTx.tx_id,
    message: "Payment verified! You've successfully joined the pool."
  };
}
```

---

## 4. Pool Completion — Payout Process

### 4.1 Admin Flow

```
Admin dashboard → Pool Details → "Payouts" tab
  ├─ See 3 members with pending payouts
  │   ├─ Member A: 110.50 USDT (net payout after fees)
  │   ├─ Member B: 110.50 USDT
  │   └─ Member C: 110.50 USDT
  └─ Click button: "Execute All Payouts"

Backend immediately:
  ├─ For each member:
  │   ├─ Load member's Binance address
  │   ├─ Check admin's available balance (Binance API)
  │   ├─ Execute withdrawal from admin to member's address
  │   ├─ Get withdrawal TX ID immediately
  │   ├─ Save to vc_pool_transactions
  │   ├─ Mark payout as "processing"
  │   └─ Return success or error for this member
  └─ Show admin results: "3/3 payouts sent"

Every 5 minutes (cron job):
  ├─ Poll Binance for status of withdrawals
  ├─ When withdrawal status = "success"
  │   ├─ Update transaction to "confirmed"
  │   ├─ Mark payout as "completed"
  │   └─ Send email to user: "Your payout of 110.50 USDT received"
  └─ If withdrawal status = "failed"
      ├─ Update transaction to "failed"
      ├─ Alert admin: "Payout failed for Member A - check balance"
      └─ Retry on next cycle (if reason is transient)
```

### 4.2 Backend Implementation

```typescript
// Service: pool-payout.service.ts

async executeAllPayouts(poolId: string, adminId: string): Promise<{
  total_payouts: number;
  succeeded: number;
  failed: number;
  results: PayoutResult[]
}> {
  
  // 1. Validate pool & get all pending payouts
  const pool = await getPool(poolId, adminId);
  if (pool.status !== 'completed') {
    throw new Error("Pool is not completed");
  }
  
  const payouts = await getPayouts(poolId, { status: 'pending' });
  const admin = await getAdmin(adminId);
  
  // 2. Fetch admin's withdrawal history (to prevent double-pays)
  let existingWithdrawals;
  try {
    existingWithdrawals = await BinanceService.getWithdrawalHistory(
      decrypt(admin.binance_api_key_encrypted),
      decrypt(admin.binance_api_secret_encrypted),
      {
        coin: 'USDT',
        limit: 200,
        startTime: pool.started_at
      }
    );
  } catch (error) {
    throw new Error(`Cannot fetch admin withdrawal history: ${error.message}`);
  }
  
  // 3. Check admin's available balance
  let adminBalance;
  try {
    const accountInfo = await BinanceService.getAccountInfo(
      decrypt(admin.binance_api_key_encrypted),
      decrypt(admin.binance_api_secret_encrypted)
    );
    const usdtBalance = accountInfo.balances.find(b => b.asset === 'USDT');
    adminBalance = parseFloat(usdtBalance?.free || 0);
  } catch (error) {
    throw new Error(`Cannot fetch admin balance: ${error.message}`);
  }
  
  // 4. Process each payout
  const results: PayoutResult[] = [];
  let totalNeeded = 0;
  let succeeded = 0;
  let failed = 0;
  
  for (const payout of payouts) {
    totalNeeded += parseFloat(payout.net_payout);
  }
  
  if (adminBalance < totalNeeded) {
    throw new Error(
      `Insufficient balance. Need: ${totalNeeded} USDT, Have: ${adminBalance} USDT`
    );
  }
  
  for (const payout of payouts) {
    const member = await getMember(payout.member_id);
    
    try {
      // 4a. Check if already withdrawn (prevent double-pay)
      const alreadyWithdrawn = existingWithdrawals.find(
        (w) => w.address === member.binance_address &&
               w.amount === parseFloat(payout.net_payout) &&
               w.status === 'success'
      );
      
      if (alreadyWithdrawn) {
        // Record it and mark payout paid
        const tx = await createTransaction({
          binance_tx_id: alreadyWithdrawn.id,
          tx_type: 'payout',
          amount_usdt: payout.net_payout,
          recipient_address: member.binance_address,
          status: 'confirmed',
          verification_method: 'admin_api',
          payout_id: payout.payout_id,
          pool_id: poolId,
          user_id: member.user_id,
          admin_id: adminId
        });
        
        await updatePayout(payout.payout_id, {
          status: 'completed',
          binance_tx_id: alreadyWithdrawn.id,
          transaction_id: tx.tx_id,
          paid_at: now()
        });
        
        results.push({
          payout_id: payout.payout_id,
          member_id: member.member_id,
          status: 'already_paid',
          amount: payout.net_payout,
          tx_id: alreadyWithdrawn.id
        });
        succeeded++;
        continue;
      }
      
      // 4b. Validate member has address
      if (!member.binance_address) {
        results.push({
          payout_id: payout.payout_id,
          member_id: member.member_id,
          status: 'error',
          error: 'Member has no Binance address configured',
          amount: payout.net_payout
        });
        failed++;
        continue;
      }
      
      // 4c. Execute withdrawal
      const withdrawResponse = await BinanceService.withdraw(
        decrypt(admin.binance_api_key_encrypted),
        decrypt(admin.binance_api_secret_encrypted),
        {
          coin: 'USDT',
          network: member.binance_network || pool.default_network || 'BEP20',
          address: member.binance_address,
          amount: parseFloat(payout.net_payout),
          withdrawOrderId: `payout-${payout.payout_id}`  // Idempotency key
        }
      );
      
      // 4d. Save transaction
      const tx = await createTransaction({
        binance_tx_id: withdrawResponse.id,
        tx_type: 'payout',
        amount_usdt: payout.net_payout,
        recipient_address: member.binance_address,
        recipient_binance_uid: member.user_binance_uid,
        status: 'pending',  // Will be confirmed by cron job
        verification_method: 'admin_api',
        binance_response_json: withdrawResponse,
        payout_id: payout.payout_id,
        pool_id: poolId,
        user_id: member.user_id,
        admin_id: adminId
      });
      
      // 4e. Update payout
      await updatePayout(payout.payout_id, {
        status: 'processing',
        binance_tx_id: withdrawResponse.id,
        transaction_id: tx.tx_id
      });
      
      results.push({
        payout_id: payout.payout_id,
        member_id: member.member_id,
        status: 'submitted',
        amount: payout.net_payout,
        tx_id: withdrawResponse.id
      });
      succeeded++;
      
    } catch (error) {
      results.push({
        payout_id: payout.payout_id,
        member_id: member.member_id,
        status: 'error',
        error: error.message,
        amount: payout.net_payout
      });
      failed++;
    }
  }
  
  return {
    total_payouts: payouts.length,
    succeeded,
    failed,
    results
  };
}
```

---

## 5. Auto-Verification via Cron Job

### 5.1 Every 5 Minutes

```typescript
// Scheduler: transaction-verification.scheduler.ts

@Cron(CronExpression.EVERY_5_MINUTES)
async verifyPendingTransactions() {
  
  const pendingTxs = await vc_pool_transactions.findMany({
    where: { 
      status: 'pending',
      tx_type: { in: ['payout', 'refund'] }
    }
  });
  
  for (const tx of pendingTxs) {
    try {
      const admin = await getAdmin(tx.admin_id);
      
      // Fetch latest withdrawal history
      const withdrawHistory = await BinanceService.getWithdrawalHistory(
        decrypt(admin.binance_api_key_encrypted),
        decrypt(admin.binance_api_secret_encrypted),
        { coin: 'USDT', limit: 100 }
      );
      
      // Find our withdrawal
      const updated = withdrawHistory.find(w => w.id === tx.binance_tx_id);
      
      if (!updated) {
        // TX not found - might be too old or never submitted
        logger.warn(`Cannot find TX ${tx.binance_tx_id} in history`);
        continue;
      }
      
      if (updated.status === 'success') {
        // Confirmed!
        await updateTransaction(tx.tx_id, {
          status: 'confirmed',
          verified_at: now(),
          binance_response_json: updated
        });
        
        if (tx.payout_id) {
          await updatePayout(tx.payout_id, { status: 'completed' });
          
          // Notify user
          await emailService.send({
            to: tx.user.email,
            template: 'payout_received',
            data: { amount: tx.amount_usdt, pool_name: tx.pool.name }
          });
        }
        
        if (tx.cancellation_id) {
          await updateCancellation(tx.cancellation_id, { status: 'processed' });
          
          // Notify user
          await emailService.send({
            to: tx.user.email,
            template: 'refund_received',
            data: { amount: tx.amount_usdt }
          });
        }
        
      } else if (updated.status === 'failed') {
        // Failed
        await updateTransaction(tx.tx_id, {
          status: 'failed',
          verified_at: now(),
          admin_notes: `Binance: ${updated.failReason || 'Unknown failure'}`
        });
        
        // Alert admin
        await notificationService.alertAdmin({
          admin_id: tx.admin_id,
          type: 'payout_failed',
          data: {
            recipient: tx.recipient_address,
            amount: tx.amount_usdt,
            reason: updated.failReason
          }
        });
      }
      // else: still processing - check again next time
      
    } catch (error) {
      logger.error(`Error verifying TX ${tx.tx_id}:`, error);
    }
  }
}
```

---

## 6. Edge Cases & Shortfall Handling

**THIS IS THE CRITICAL PART** — Read [VC_POOL_PAYMENT_SHORTFALL_HANDLING.md](VC_POOL_PAYMENT_SHORTFALL_HANDLING.md) for comprehensive solutions.

### Quick Examples:

```
✗ User sends 100 USDT instead of 105 USDT
  → TX exists, amount mismatches
  → System detects shortfall
  → Creates "suspense transaction" record
  → Notifies admin: "Member A short by 5 USDT"
  → Admin can: approve shortfall and adjust membership, 
              request user send difference, or reject membership

✓ User sends 105 USDT on time, exact amount
  → TX verified and approved automatically
  → Member created immediately

✗ User sends 105 USDT but 45 minutes later (past deadline)
  → TX exists, amount matches, but timestamp is late
  → System detects late payment
  → Creates failed transaction
  → Admin can: approve as exception, or reject

✓ Admin executes payout twice by accident
  → First payout: creates TX, submits to Binance
  → Second payout: checks withdrawal history, sees first payout already exists
  → Prevents double-pay, just links both to same TX
  → Admin notified: "Already sent this payout"
```

See [VC_POOL_PAYMENT_SHORTFALL_HANDLING.md](VC_POOL_PAYMENT_SHORTFALL_HANDLING.md) for full handling logic.

---

## 7. API Endpoints

### User Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/vc-pools/available` | List open pools with admin Binance info |
| POST | `/api/vc-pools/:poolId/join` | Reserve seat, get payment instructions |
| POST | `/api/vc-pools/:poolId/payment/verify-and-join` | Submit TX ID, auto-verify, become member |
| GET | `/api/vc-pools/:poolId/payment-status` | Check verification status of pending payment |
| POST | `/api/vc-pools/:poolId/cancel-membership` | Request to exit pool |
| GET | `/api/vc-pools/my-pools` | List my pool memberships |

### Admin Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/admin/pools/:poolId/payments` | List all payment submissions with verification status |
| PUT | `/admin/pools/:poolId/payments/:submissionId/approve-manual` | Admin override approve (for shortfalls etc) |
| PUT | `/admin/pools/:poolId/payments/:submissionId/reject` | Reject payment, release seat |
| POST | `/admin/pools/:poolId/payouts/execute-all` | Execute all pending payouts |
| GET | `/admin/pools/:poolId/transactions` | View all transactions (joins, payouts, refunds) |
| GET | `/admin/pools/:poolId/transactions/:txId` | View single transaction with full details |
| PUT | `/admin/pools/:poolId/cancellations/:cancellationId/approve` | Approve exit, execute refund |
| PUT | `/admin/pools/:poolId/cancellations/:cancellationId/reject` | Reject exit request |

---

## 8. Database Queries

### Find all pending payouts for a pool

```sql
SELECT p.*, u.email, m.binance_address 
FROM vc_pool_payouts p
JOIN vc_pool_members m ON p.member_id = m.member_id
JOIN users u ON m.user_id = u.user_id
WHERE p.pool_id = ? AND p.status = 'pending'
ORDER BY p.created_at ASC;
```

### Find all transactions for a pool with status

```sql
SELECT 
  t.tx_id, t.binance_tx_id, t.tx_type, t.status, t.amount_usdt,
  u.email as user_email, 
  CASE 
    WHEN t.payout_id IS NOT NULL THEN 'payout'
    WHEN t.cancellation_id IS NOT NULL THEN 'refund'
    WHEN t.payment_submission_id IS NOT NULL THEN 'join'
  END as linked_entity
FROM vc_pool_transactions t
LEFT JOIN users u ON t.user_id = u.user_id
WHERE t.pool_id = ?
ORDER BY t.created_at DESC;
```

### Detect orphaned/suspicious transactions

```sql
-- Transactions in admin's Binance history not yet recorded in our DB
SELECT * FROM vc_pool_transactions
WHERE status = 'failed' 
  AND tx_type IN ('join', 'payout', 'refund')
  AND created_at > NOW() - INTERVAL '24 hours'
ORDER BY created_at DESC;
```

---

## 9. Testing Checklist

- [ ] User joins with exact amount → auto-verified
- [ ] User joins with shortfall amount → rejected with proper error message
- [ ] User joins with overage amount → handled appropriately (see shortfall doc)
- [ ] User joins late (past deadline) → rejected with deadline error
- [ ] Duplicate TX ID → rejected with "already processed" error
- [ ] Admin executes all payouts → all succeed
- [ ] One member missing address → that payout skipped, others succeed
- [ ] Withdrawal fails due to insufficient balance → error shown
- [ ] Cron job verifies pending payouts → converts to "confirmed"
- [ ] User cancels pool → members get auto-refunds
- [ ] Admin cancels pool → all members get full refunds

---

## 10. Security Considerations

1. **API Keys:** All admin Binance keys encrypted with AES-256-GCM, decrypted only during API calls
2. **TX Idempotency:** Unique constraint on `binance_tx_id` prevents duplicate processing
3. **Double-spend prevention:** Check withdrawal history before initiating transfers
4. **Address validation:** Validate Binance address format before storing
5. **Amount precision:** Use Decimal type, not float, for money calculations
6. **Audit trail:** Every transaction stored with full Binance response for debugging
7. **Rate limiting:** Apply throttling to join/refund endpoints

---

## 11. References

- **DB Schema:** See schema changes in section 2
- **Shortfall Handling:** `VC_POOL_PAYMENT_SHORTFALL_HANDLING.md`
- **Legacy Flows:** `LEGACY_VC_POOL_IMPLEMENTATION_PHASES.md`
- **Prisma Schema:** `VC_pool_FINAL_prisma_changes.md`

---

**End of Current Implementation**
