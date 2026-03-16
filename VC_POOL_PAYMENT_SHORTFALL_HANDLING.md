# VC Pool Payment — Edge Case Handling (Current: EXACT MATCH ONLY)

**Status:** Implementation decided — EXACT MATCH ONLY (no edge case handling)

**Date:** 2026-03-07  
**Changed from:** Previous design with shortfall/overpayment tolerance options  
**Current approach:** Strict exact amount matching, no refunds for variance

---

## The Decision

```
After evaluating multiple edge case scenarios (shortfall, overpayment, network fee tolerance),
the business decision is:

✅ EXACT MATCH ONLY - Zero Tolerance Approach
   ├─ User sends EXACTLY the expected amount → APPROVED (instant)
   ├─ User sends ANY OTHER amount → NOT APPROVED (stays pending)
   ├─ After 24 hours with no exact match → Manual admin review
   └─ No automatic refunds for variance
```

---

## Why This Approach?

**Simplicity:** 
- One rule: amount must equal expected amount
- No complex variance calculations
- No tolerance percentage debates (1%? 0.5%? Custom per network?)

**Security:**
- Prevents underpayments being accepted
- Prevents overpayments creating credit / confusion
- Creates clear audit trail
- No refund logic needed for variance

**User Experience:**
- Clear instruction: "Send exactly {amount} USDT"
- No ambiguity about what's acceptable
- If amount doesn't match, user knows to retry
- No accidental overpayments creating credit accounts

---

## How It Works in Practice

```
Scenario 1: Exact Match ✅
  Admin requires: 1000 USDT
  User sends: 1000 USDT (mainnet)
  Result: Next cron cycle (5 min) → AUTO-APPROVED
  User becomes member immediately

Scenario 2: Shortfall ❌
  Admin requires: 1000 USDT
  User sends: 999.99 USDT
  Result: Stays PENDING (no exact match)
  Next cron cycles keep checking for 24 hours
  Admin can manually review and approve if desired
  User must send additional amount or accept rejection

Scenario 3: Overpayment ❌
  Admin requires: 1000 USDT
  User sends: 1000.50 USDT
  Result: Stays PENDING (no exact match)
  Same as Scenario 2 — admin manual review or user resends

Scenario 4: Network Fee Variance ❌
  Admin requires: 1000 USDT
  User sends: 1000 USDT on Binance mainnet
  Network fee deducted: 0.0001 USDT
  Received: 999.9999 USDT
  Result: Stays PENDING (no exact match)
  But this scenario is unlikely because:
    - Most mainnet USDT transfers have negligible fees
    - Binance fees are absorbed by exchange, not the user
    - If fees are deducted, they're very small (<0.001 USDT typically)
```

---

## Implementation Details

### Where Exact Match Happens

**File:** `binance-verification.service.ts`  
**Method:** `verifyPaymentViaDeposit()`

```typescript
// Look for EXACT match only
for (const deposit of deposits) {
  const depositAmount = new Decimal(deposit.amount.toString());
  
  // Check for EXACT match only - no tolerance
  if (depositAmount.equals(expectedAmount)) {
    return {
      verified: true,
      reason: `Exact amount verified: ${depositAmount} USDT`,
      amount: depositAmount,
    };
  }
}

// No exact match found
return {
  verified: false,
  reason: `No exact amount match found (expected: ${expectedAmount} USDT)`,
};
```

### Cron Job Workflow

**File:** `payment-verification.scheduler.ts`  
**Runs:** Every 5 minutes

```
1. Fetch all PENDING payments
2. Get admin's deposit history for last 24 hours
3. For each pending payment:
   ├─ Search deposits for EXACT amount match
   ├─ If found: Update payment.status = "APPROVED"
   └─ If not found: Leave as PENDING (next check in 5 min)
4. Log results
```

After 24 hours without exact match: Payment stays PENDING, requires manual admin review.

---

## What If User Makes a Mistake?

### Underpayment (sent less than required)

**What happens:**
- Payment stays PENDING
- Cron job rechecks every 5 minutes for 24 hours
- After 24 hours: Manual admin review needed

**User options:**
1. Send additional USDT to reach exact amount (admin can create new payment submission)
2. Contact admin to manually approve partial payment
3. Request refund of sent amount

### Overpayment (sent more than required)

**What happens:**
- Payment stays PENDING (overage doesn't match expected amount)
- Cron job rechecks every 5 minutes for 24 hours
- After 24 hours: Manual admin review needed

**User options:**
1. Contact admin to explain overpayment
2. Admin can manually approve the overage as a tip/additional contribution
3. Request refund of overpayment (admin handles via separate transfer)

### Network Fee Deduction

**Most likely scenario:** Very rare because:
- Binance absorbs most network fees (user-friendly)
- USDT transfers typically <$0.01 in network fees
- When fees are deducted, they're minimal (<0.001 USDT)

**If it happens:**
- Payment stays PENDING
- After review, admin can manually approve
- Or user can send the additional fractional amount to complete

---

## Database Fields (Current Implementation)

### vc_pool_payment_submissions Table

```prisma
submission_id    String
pool_id          String
user_id          String
exact_amount_expected    Decimal      // The exact amount required
status           String               // "pending", "approved", "rejected"
verified_at      DateTime?            // When auto-verified
verification_method  String           // "network_deposit"
matched_amount   Decimal?             // The deposit amount that was matched
created_at       DateTime
updated_at       DateTime
```

**No fields for:**
- Shortfall amount
- Overpayment amount
- Suspense account tracking
- Refund thresholds
- Fee variance tolerance

This keeps it simple and focused on exact matches only.

---

## Future Considerations (If Business Rules Change)

If in future we want to add tolerance, the changes would be:

1. Add `payment_variance_tolerance_percent` (e.g., 0.5%) to `vc_pools` table
2. Add logic in `verifyPaymentViaDeposit()` to calculate:
   ```
   variance = (deposit_amount - expected_amount).abs()
   variance_percent = (variance / expected_amount) × 100
   if (variance_percent <= pool.payment_variance_tolerance_percent) → APPROVE
   ```
3. Add `variance_percent` and `variance_reason` to `vc_pool_payment_submissions`
4. Add admin UI to override individual payments
5. Add refund logic for underpayments/overpayments

But for now: **One rule, enforced strictly: Amount must be exactly equal.**
│                                                       │
│ 1. Flag transaction in admin dashboard:              │
│    Alert: "Shortfall detected - 100 USDT received,  │
│             5 USDT missing from Member A"            │
│                                                       │
│ 2. Admin actions:                                     │
│    a) "Approve Shortfall" → Create member with      │
│       adjusted membership (e.g., 95% share)          │
│    b) "Request More" → Send auto-notification to    │
│        user with payment link                        │
│    c) "Reject" → Refund user immediately            │
│    d) "Combine with Other Shortfall" → Link two     │
│        shortfalls to complete one membership         │
│                                                       │
│ Implementation: Admin can:                            │
│    - Set minimum acceptable shortfall % (e.g., 2%)   │
│    - Auto-approve shortfalls within ±2%             │
│    - Require manual approval for > ±2%              │
│                                                       │
└───────────────────────────────────────────────────────┘

┌─Option C: Dynamic Adjustment (Most User-Friendly)─┐
│                                                     │
│ 1. If shortfall is MINOR (within 2%):             │
│    └─ Auto-approve and adjust down membership by  │
│       2% (e.g., 2 out of 100 = 1 seat less)      │
│                                                     │
│ 2. If shortfall is MAJOR (2-5%):                  │
│    ├─ Send to admin for review                    │
│    ├─ Admin sees: "Approve shortfall from X?"     │
│    └─ Auto-refund after 24h if no admin action    │
│                                                     │
│ 3. If shortfall is CRITICAL (> 5%):               │
│    ├─ Auto-reject                                  │
│    └─ Initiate auto-refund within 24 hours        │
│                                                     │
│ Backend checks:                                     │
│    shortfall_pct = (required - received) / required │
│                                                     │
│    if shortfall_pct <= 0.02:                       │
│      auto_approve = true                           │
│      adjusted_membership_pct = 100 - (shortfall %) │
│    elif shortfall_pct <= 0.05:                     │
│      send_to_admin_for_review = true              │
│      auto_refund_after_24h = true                  │
│    else:                                            │
│      auto_reject = true                            │
│      initiate_auto_refund = true                   │
│                                                     │
└─────────────────────────────────────────────────────┘

Recommended: Option C (Dynamic Adjustment)
```

---

### Category 2: OVERPAYMENT (Amount > Required)

```
Scenario: User sends 110 USDT instead of 105 USDT (overpaid by 5 USDT)

Detection:
  ├─ TX exists in admin's deposit history ✓
  ├─ Amount 110 > 105 ✗
  └─ Status: "overpayment"

Response Options:

┌─Option A: Accept Overpayment & Credit for Fees──────────┐
│                                                          │
│ 1. Accept the full 110 USDT as payment                  │
│ 2. Apply it as:                                          │
│    ├─ 100 USDT → Investment                            │
│    ├─ 5 USDT → Pool fee (covers exactly)               │
│    └─ 5 USDT → Credited as "pool credit" or refund    │
│                                                          │
│ 3. When pool completes:                                 │
│    ├─ Member's payout calculation = same (105 basis)   │
│    ├─ Extra 5 USDT handled as:                         │
│    │   a) Returned in final payout                      │
│    │   b) Credited to next pool membership             │
│    │   c) Donated to platform (with permission)        │
│    └─ User notified of credit                          │
│                                                          │
│ Pros: Simple, no refund delays, good UX               │
│ Cons: Need to track "user credit account"             │
│                                                          │
└──────────────────────────────────────────────────────────┘

┌─Option B: Immediate Auto-Refund Difference──────────────┐
│                                                          │
│ 1. Accept 105 USDT as payment                           │
│ 2. Immediately transfer back 5 USDT via Binance:        │
│    ├─ Withdraw 5 USDT to user's address               │
│    ├─ Get TX ID from Binance                           │
│    ├─ Store as separate transaction record             │
│    └─ Notify user: "Overpayment of 5 USDT refunded"   │
│                                                          │
│ 3. Create member with exactly 105 USDT                 │
│                                                          │
│ Pros: Clean, no ambiguity, professional                │
│ Cons: Extra TX fee (Binance withdrawal fees)           │
│                                                          │
└──────────────────────────────────────────────────────────┘

┌─Option C: Accept as-is (Simplest)──────────────────────┐
│                                                          │
│ 1. If overpayment is small (< 2%):                      │
│    └─ Accept 110 USDT as membership payment            │
│       and credit excess to user's account              │
│                                                          │
│ 2. If overpayment is large (> 2%):                      │
│    └─ Trigger Option B (auto-refund difference)        │
│                                                          │
│ Pros: Minimal overhead, user doesn't mind extra amount │
│ Cons: Requires user credit system                       │
│                                                          │
└──────────────────────────────────────────────────────────┘

Recommended: Option C (Accept small overpay, auto-refund large)
  └─ Tolerance: Accept ±2% variance automatically
```

---

### Category 3: ORPHANED TRANSACTIONS (TX in admin's account but unmatched)

```
Scenario: Admin's Binance shows incoming USDT but we don't know whose it is

Root Causes:
  ├─ User sent right amount but TX ID submission failed (network error)
  ├─ User sent but TX ID format was wrong
  ├─ User sent, TX succeeded, but user never came back to app
  ├─ Refund from another pool (partial refund)
  └─ Manual transfer from another admin/user

Detection (Automated Daily Job):
  
  1. Fetch admin's full deposit history
  2. For each deposit:
     ├─ Check if TX ID exists in vc_pool_transactions
     └─ If NOT found:
         ├─ Create "orphaned_transaction" record
         ├─ Amount: known from Binance
         ├─ Sender: known from Binance (if available)
         ├─ Status: "unmatched"
         └─ Alert admin: "Unmatched deposit of 105 USDT from UID xyz"

Resolution Process:

┌─Admin Dashboard: "Unmatched Deposits"────────────────┐
│                                                       │
│ Shows pending orphaned TXs:                          │
│  15.5 USDT - "Unknown sender" - Received 2h ago      │
│  105.0 USDT - "From UID 98765432" - Received 1d ago  │
│  210.0 USDT - "From address 0x123..." - Received 3d  │
│                                                       │
│ For each, Admin can:                                 │
│  a) "Identify Member" → Link to pending user        │
│     (system searches users who:                       │
│      - have open reservations                         │
│      - amount matches pool requirement               │
│      - within payment deadline)                       │
│                                                       │
│  b) "Mark as Refund" → Link to previous payout/     │
│     cancellation as refund confirmation              │
│                                                       │
│  c) "Manual Refund" → Immediately withdraw back     │
│     (if accidentally sent, or unclaimed fee)         │
│                                                       │
│  d) "Keep to Platform" → Convert to platform credit │
│     (if unclaimed for 30 days)                       │
│                                                       │
│  e) "Notes" → Add memo for future reference         │
│                                                       │
└───────────────────────────────────────────────────────┘

Implementation in vc_pool_transactions:

  model vc_pool_transactions {
    binance_tx_id: "abc123"
    tx_type: "orphaned"
    status: "unmatched"
    recipient_address: null  // Orphaned, not for anyone yet
    sender_binance_uid: "98765432"  // Known
    amount_usdt: 105.00
    admin_notes: "Pending identification"
    
    // Admin actions to resolve:
    matched_payment_submission_id?: string  // Link to a member
    matched_payout_id?: string  // Link to a refund
    matched_cancellation_id?: string
    resolution_type?: "accepted" | "refunded" | "platform_credit"
    resolved_at?: DateTime
  }

Auto-cleanup (after 30 days):
  ├─ If no action taken on orphaned TX
  ├─ Create platform credit entry
  └─ Notify admin: "Unclaimed 15.5 USDT → platform credit"
```

---

## Implementation: Complete Code

### Data Model Updates

```prisma
model vc_pool_transactions {
  // existing fields...
  
  // Shortfall handling
  shortfall_amount         Decimal?                @db.Decimal(20, 8)  // For "shortfall" tx_type
  shortfall_percentage     Decimal?                @db.Decimal(5, 2)
  shortfall_tolerance_pct  Decimal?                @db.Decimal(5, 2)   // Was it within tolerance?
  auto_approved            Boolean                 @default(false)      // Did system auto-approve?
  
  // Overpayment handling
  overpayment_amount       Decimal?                @db.Decimal(20, 8)  // For "overpayment" tx_type
  overpayment_action       String?                 @db.VarChar(50)   // "credited", "refunded", "accepted"
  refund_tx_id             String?                 @db.VarChar(255)    // If we refunded the overage
  
  // Orphaned transaction linking
  matched_payment_submission_id  String?           @db.Uuid
  matched_payout_id              String?           @db.Uuid
  matched_cancellation_id        String?           @db.Uuid
  resolution_type                String?           @db.VarChar(50)   // "accepted", "refunded", "platform_credit"
  
  // Timings
  suspension_deadline      DateTime?               @db.Timestamp(6)    // When shortfall must be resolved
  resolved_at              DateTime?               @db.Timestamp(6)    // When issue was resolved
  
  @@map("vc_pool_transactions")
}

model user_credits {
  credit_id         String                        @id @default(uuid()) @db.Uuid
  user_id           String                        @db.Uuid
  amount_usdt       Decimal                       @db.Decimal(20, 8)
  source            String                        @db.VarChar(50)  // "overpayment", "refund", "bonus"
  pool_id           String?                       @db.Uuid
  transaction_id    String?                       @db.Uuid  // Links to vc_pool_transactions
  
  used_for_pool_id  String?                       @db.Uuid  // Which pool this was applied to
  used_at           DateTime?                     @db.Timestamp(6)
  created_at        DateTime                      @default(now()) @db.Timestamp(6)
  
  user              users                         @relation(fields: [user_id], references: [user_id])
  pool              vc_pools?                     @relation(fields: [pool_id], references: [pool_id])
  used_for_pool     vc_pools?                     @relation("UsedForPool", fields: [used_for_pool_id], references: [pool_id])
  
  @@index([user_id])
  @@index([pool_id])
  @@map("user_credits")
}
```

---

### Service Logic

```typescript
// Service: payment-verification.service.ts

async handleAmountMismatch(
  submission: PaymentSubmission,
  binanceDeposit: BinanceDepositRecord,
  admin: Admin
): Promise<{
  status: 'accepted' | 'rejected' | 'suspense';
  action?: 'auto_approved' | 'pending_admin_review' | 'refund_initiated';
  member_id?: string;
  notification?: string;
}> {
  
  const required = parseFloat(submission.total_amount);
  const received = parseFloat(binanceDeposit.amount);
  const difference = Math.abs(required - received);
  const differencePct = (difference / required) * 100;
  
  // Configuration (admin-set tolerances)
  const AUTO_APPROVE_TOLERANCE_PCT = 2;  // Auto-approve if within ±2%
  const AUTO_REJECT_TOLERANCE_PCT = 5;   // Auto-reject and refund if > 5%
  
  // SHORTFALL CASE
  if (received < required) {
    const shortfall = required - received;
    const shortfallPct = (shortfall / required) * 100;
    
    // Create transaction record for audit
    const tx = await createTransaction({
      binance_tx_id: binanceDeposit.txId,
      tx_type: 'shortfall',
      amount_usdt: received,
      shortfall_amount: shortfall,
      shortfall_percentage: shortfallPct,
      shortfall_tolerance_pct: AUTO_APPROVE_TOLERANCE_PCT,
      status: 'suspense',
      pool_id: submission.pool_id,
      user_id: submission.user_id,
      admin_id: admin.admin_id,
      payment_submission_id: submission.submission_id
    });
    
    // Check tolerance
    if (shortfallPct <= AUTO_APPROVE_TOLERANCE_PCT) {
      // AUTO-APPROVE (small shortfall)
      const member = await createMember({
        pool_id: submission.pool_id,
        user_id: submission.user_id,
        payment_method: 'binance',
        invested_amount_usdt: received - (received * (submission.pool_fee_percent / 100)),
        // Adjusted investment: user gets reduced membership
        membership_status: 'partial'  // Or adjust share_percent
      });
      
      await updateTransaction(tx.tx_id, {
        status: 'confirmed',
        auto_approved: true,
        verified_at: now()
      });
      
      await notifyUser({
        user_id: submission.user_id,
        template: 'shortfall_accepted',
        data: {
          received: received,
          required: required,
          shortfall: shortfall,
          status: 'approved_with_reduced_share'
        }
      });
      
      return {
        status: 'accepted',
        action: 'auto_approved',
        member_id: member.member_id,
        notification: `Shortfall of ${shortfall} USDT accepted. Your membership reduced to ${(100 - shortfallPct).toFixed(1)}%.`
      };
      
    } else if (shortfallPct <= AUTO_REJECT_TOLERANCE_PCT) {
      // SEND TO ADMIN + SET AUTO-REFUND TIMER
      const suspensionDeadline = now() + (24 * 60 * 60 * 1000);  // 24 hours
      
      await updateTransaction(tx.tx_id, {
        suspension_deadline: suspensionDeadline
      });
      
      await notifyAdmin({
        admin_id: admin.admin_id,
        type: 'shortfall_review_needed',
        data: {
          user_id: submission.user_id,
          amount_received: received,
          amount_required: required,
          shortfall: shortfall,
          transaction_id: tx.tx_id,
          deadline: suspensionDeadline
        }
      });
      
      await notifyUser({
        user_id: submission.user_id,
        template: 'shortfall_detected',
        data: {
          received: received,
          required: required,
          shortfall: shortfall,
          options: [
            `1. Send remaining ${shortfall} USDT to complete payment`,
            `2. Request admin approval for reduced membership`,
            `3. Request full refund`
          ]
        }
      });
      
      return {
        status: 'suspense',
        action: 'pending_admin_review',
        notification: `Waiting for admin review or user to send remaining ${shortfall} USDT`
      };
      
    } else {
      // AUTO-REJECT (large shortfall)
      await updateTransaction(tx.tx_id, {
        status: 'rejected',
        verified_at: now()
      });
      
      // Initiate auto-refund
      await scheduleRefund({
        transaction_id: tx.tx_id,
        recipient_address: binanceDeposit.fromAddress,
        amount_usdt: received,
        reason: `Shortfall > tolerance (${shortfallPct.toFixed(1)}%)`
      });
      
      await notifyUser({
        user_id: submission.user_id,
        template: 'shortfall_rejected',
        data: {
          received: received,
          required: required,
          shortfall: shortfall,
          message: 'Your payment is too low. A full refund will be processed within 24 hours.'
        }
      });
      
      return {
        status: 'rejected',
        action: 'refund_initiated'
      };
    }
  }
  
  // OVERPAYMENT CASE
  else if (received > required) {
    const overpayment = received - required;
    const overpaymentPct = (overpayment / required) * 100;
    
    const tx = await createTransaction({
      binance_tx_id: binanceDeposit.txId,
      tx_type: 'overpayment',
      amount_usdt: received,
      overpayment_amount: overpayment,
      status: 'pending',
      pool_id: submission.pool_id,
      user_id: submission.user_id,
      admin_id: admin.admin_id,
      payment_submission_id: submission.submission_id
    });
    
    if (overpaymentPct <= AUTO_APPROVE_TOLERANCE_PCT) {
      // ACCEPT OVERPAYMENT + CREATE CREDIT
      
      // Accept full amount as payment
      const member = await createMember({
        pool_id: submission.pool_id,
        user_id: submission.user_id,
        payment_method: 'binance',
        invested_amount_usdt: required - (required * (submission.pool_fee_percent / 100))
      });
      
      // Create credit account for overpayment
      await createUserCredit({
        user_id: submission.user_id,
        amount_usdt: overpayment,
        source: 'overpayment',
        pool_id: submission.pool_id,
        transaction_id: tx.tx_id
      });
      
      await updateTransaction(tx.tx_id, {
        status: 'confirmed',
        overpayment_action: 'credited',
        verified_at: now(),
        auto_approved: true
      });
      
      await notifyUser({
        user_id: submission.user_id,
        template: 'overpayment_accepted',
        data: {
          received: received,
          required: required,
          credit: overpayment,
          message: `Thank you! We received ${received} USDT. ${overpayment} USDT has been credited to your account for future pools.`
        }
      });
      
      return {
        status: 'accepted',
        action: 'auto_approved',
        member_id: member.member_id,
        notification: `Overpayment of ${overpayment} USDT credited to your account.`
      };
      
    } else {
      // AUTO-REFUND OVERAGE
      
      const member = await createMember({
        pool_id: submission.pool_id,
        user_id: submission.user_id,
        payment_method: 'binance',
        invested_amount_usdt: required - (required * (submission.pool_fee_percent / 100))
      });
      
      // Initiate refund for overage
      const refundTx = await BinanceService.withdraw(
        decrypt(admin.binance_api_key_encrypted),
        decrypt(admin.binance_api_secret_encrypted),
        {
          coin: 'USDT',
          network: binanceDeposit.network,
          address: binanceDeposit.fromAddress,
          amount: overpayment
        }
      );
      
      await updateTransaction(tx.tx_id, {
        status: 'processing',
        overpayment_action: 'refunded',
        refund_tx_id: refundTx.id,
        verified_at: now()
      });
      
      await notifyUser({
        user_id: submission.user_id,
        template: 'overpayment_refunded',
        data: {
          received: received,
          required: required,
          refund_amount: overpayment,
          refund_tx_id: refundTx.id,
          message: `Thank you! We received ${received} USDT. Excess ${overpayment} USDT will be refunded within 24 hours.`
        }
      });
      
      return {
        status: 'accepted',
        action: 'auto_approved',
        member_id: member.member_id,
        notification: `Member created. Overpayment of ${overpayment} USDT being refunded.`
      };
    }
  }
}

// Scheduled job: resolve suspense transactions after 24h
@Cron(CronExpression.EVERY_HOUR)
async resolveSuspenseTransactions() {
  const expiredSuspense = await vc_pool_transactions.findMany({
    where: {
      tx_type: 'shortfall',
      status: 'suspense',
      suspension_deadline: { lt: now() }
    }
  });
  
  for (const tx of expiredSuspense) {
    // Auto-refund if not resolved
    await initiateRefund({
      transaction_id: tx.tx_id,
      amount: tx.amount_usdt,
      reason: 'Shortfall not resolved within 24 hours'
    });
    
    await updateTransaction(tx.tx_id, {
      status: 'refunded',
      resolution_type: 'auto_refund_timeout',
      resolved_at: now()
    });
  }
}
```

---

## Summary Table: What Happens In Each Scenario

| Scenario | Amount | Detection | Action | Outcome |
|----------|--------|-----------|--------|---------|
| Exact payment | 105 USDT | Match ✓ | Auto-verify | Member created ✓ |
| Minor shortfall | 102 USDT (-2.9%) | Mismatch | Auto-approve with reduced share | Member created (92.9% share) ✓ |
| Major shortfall | 100 USDT (-5%) | Mismatch | Send to admin review + 24h timer | Pending admin decision or auto-refund |
| Critical shortfall | 95 USDT (-9%) | Mismatch | Auto-reject | Auto-refund initiated ✓ |
| Minor overpay | 107 USDT (+1.9%) | Mismatch | Accept + credit | Member created, 2 USDT credit ✓ |
| Major overpay | 115 USDT (+9%) | Mismatch | Accept + refund overage | Member created, 10 USDT refunded ✓ |
| Late payment | 105 USDT, 45 min | Timestamp fail | Reject | Admin can override |
| Duplicate TX ID | (existing TX) | Already exists | Prevent | Error: "TX already processed" |

---

## Configuration Example

Admin can set these tolerances:

```json
{
  "payment_tolerance_settings": {
    "auto_approve_shortfall_pct": 2,
    "auto_reject_shortfall_pct": 5,
    "auto_refund_overpay_pct": 2,
    "accept_overpay_threshold_pct": 2,
    "auto_refund_timeout_hours": 24,
    "allow_manual_override_for_shortfalls": true,
    "email_on_shortfall": true,
    "email_on_overpay": false
  }
}
```

---

## Trust Score Formula

For every transaction, calculate trust confidence:

```
trust_score = (
  (amount_matches * 0.4) +
  (timestamp_valid * 0.3) +
  (sender_identified * 0.2) +
  (no_duplicates * 0.1)
) * 100

If trust_score >= 95: AUTO-APPROVE
If trust_score >= 70: ADMIN REVIEW
If trust_score <  70: AUTO-REFUND
```

---

**This framework ensures:**
- ✅ No orphaned funds
- ✅ Complete audit trail
- ✅ Automatic resolution for most cases
- ✅ Admin oversight for edge cases
- ✅ User trust via transparent communication
- ✅ Fast refunds if needed
- ✅ Credits/reconciliation for future use

**End of Shortfall Handling**
