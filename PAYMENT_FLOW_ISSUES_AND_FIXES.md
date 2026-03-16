# VC Pool Payment Flow - Issues & Fixes

**Date:** March 7, 2026  
**Status:** Critical Issue Identified  
**Severity:** High  

---

## 🔴 Problem Description

A user joins a VC pool, transfers the amount to admin's Binance account using their Binance UID, and then waits for approval. However:

1. **Payment is NOT auto-approved** within the 5-minute cron cycle
2. **Timer expires** (default 30 minutes)
3. **User is NOT refunded** with the transferred funds

---

## 🔍 Root Causes Identified

### Issue 1: Seat Expiry Scheduler Doesn't Initiate Refunds

**File:** `src/modules/vc-pool/schedulers/seat-expiry.scheduler.ts`

```typescript
// Current behavior: Every 30 seconds
@Cron('*/30 * * * * *')
async handleSeatExpiry() {
  // Expires reservation
  // Expires payment submission
  // Decrements reserved seats
  // ❌ DOES NOT INITIATE REFUND
}
```

**Issue:** When a seat reservation expires:
- Reservation status → `expired`
- Payment submission status → `expired`
- But NO refund is created or initiated
- User's funds remain in admin's account with no record of refund

---

### Issue 2: Payment Verification Cron Only Processes Pending Payments

**File:** `src/modules/vc-pool/services/binance-verification.service.ts`

```typescript
const pendingPayments = await this.prisma.vc_pool_payment_submissions.findMany({
  where: {
    binance_payment_status: 'pending',  // ← Only pending
    binance_tx_id: { not: null },
    payment_method: 'binance',
  },
});
```

**Issue:** If a payment submission becomes `status: 'expired'`, the cron job won't process it because it only looks for `binance_payment_status: 'pending'`.

Timeline:
1. **T+0min** - User submits TX ID → `binance_payment_status: 'pending'`
2. **T+5min** - Cron runs, tries to verify TX
   - If TX not found or amount mismatch → Sets `binance_payment_status: 'rejected'`
   - If TX found but not confirmed → Stays `binance_payment_status: 'pending'`
3. **T+30min** - Seat expires
   - `status: 'expired'` (but `binance_payment_status` might still be 'pending')
4. **No refund initiated**

---

### Issue 3: No Refund Execution Logic

**Missing:** There is NO actual refund transaction creation when:
- A payment is rejected
- A seat expires
- A payment verification fails

The system sets `refund_initiated_at` flag but never:
1. Creates a Binance withdrawal transaction
2. Tracks refund status
3. Notifies admin to manually process refund

---

### Issue 4: Admin Cannot See All Transactions

**Currently Missing:** Admin has no unified view of:
- All payment submissions with full details
- Transaction status and verification history
- Which payments are pending, rejected, expired, etc.
- What happened with each transaction (TX ID, amount, reason)

Existing endpoints:
- `GET /admin/pools/:poolId/payments` - Lists submissions but limited details
- No endpoint to view all transactions in one place
- No endpoint to view transaction history with Binance API response data

---

## ✅ Solutions Implemented

### Solution 1: Admin Transaction View Page

**New Endpoint:** `GET /admin/pools/:poolId/transactions`
- Lists all transactions (payments, payouts, refunds)
- Shows complete state with details
- Filters by status, type, date range
- Shows Binance API response data for debugging

**New Endpoint:** `GET /admin/pools/:poolId/transactions/:txId`
- Shows single transaction with full audit trail
- Includes error messages and rejection reasons

---

### Solution 2: Fix Seat Expiry with Refund Initiation

**Updated:** `src/modules/vc-pool/schedulers/seat-expiry.scheduler.ts`

When a seat expires:
1. Set reservation status → `expired`
2. Set payment submission status → `expired`
3. **NEW:** Set `refund_initiated_at` timestamp
4. **NEW:** Create refund transaction record
5. **NEW:** Alert admin to process manual refund (if not auto-enabled)

---

### Solution 3: Enhanced Payment Verification Cron

**Updates to:** `src/modules/vc-pool/services/binance-verification.service.ts`

Better error handling:
- Log every verification attempt with TX ID
- If TX not found: Create "failed" transaction with reason
- If amount mismatch: Create "validation_failed" transaction with details
- Clear audit trail for admin to see what went wrong

---

### Solution 4: Payment Rejection Auto-Refund

**Updates to:** Various services

When a payment is rejected (expired or verification failed):
1. Set `refund_initiated_at` timestamp
2. Create transaction record with type `refund`
3. If admin has auto-refund enabled: Execute Binance withdrawal immediately
4. If manual refund required: Alert admin in dashboard

---

## 📊 New Payment Flow (Corrected)

```
T+0min
├─ User joins pool
├─ Seat reserved (expires in 30 min)
└─ Payment submission created (status: 'pending', binance_payment_status: pending)

T+0-2min
├─ User submits TX ID
├─ Backend validates format (not empty, valid length)
├─ Payment submission updated with TX ID
└─ Payment status: 'processing', binance_payment_status: 'pending'

T+5min (First Cron Cycle)
├─ Cron: verifyPendingPayments()
├─ Fetch admin's Binance deposit history
├─ Look for TX with matching ID
│  ├─ If found & amount matches & status confirmed
│  │  └─ ✅ APPROVED
│  │     ├─ Set binance_payment_status: 'verified'
│  │     ├─ Create member immediately
│  │     ├─ Confirm reservation
│  │     └─ Create transaction record (type: 'payment_verified')
│  │
│  ├─ If found but amount mismatch
│  │  └─ ❌ REJECTED - Shortfall/Overpayment
│  │     ├─ Set status: 'rejected'
│  │     ├─ Set binance_payment_status: 'rejected'
│  │     ├─ Create transaction record (type: 'payment_rejected', reason: 'amount_mismatch')
│  │     ├─ Set refund_initiated_at = now()
│  │     ├─ Release seat reservation
│  │     └─ Alert admin for manual refund
│  │
│  └─ If TX not found
│     └─ ⏳ STILL PENDING
│        ├─ Keep checking next cycle
│        └─ Transaction record created (type: 'verification_attempt', status: 'pending')

T+10min (Second Cron Cycle)
├─ Same as above, re-check pending payments
└─ If still not found after 2-3 cycles → Create failed transaction record

...

T+30min (Seat Expires)
├─ Cron: handleSeatExpiry()
├─ Check if reservation still 'reserved'
│  ├─ Find payment submission
│  ├─ If status still 'pending' or 'processing'
│  │  └─ UPDATE:
│  │     ├─ Set status: 'expired'
│  │     ├─ Set binance_payment_status: 'expired' (NEW)
│  │     ├─ Set refund_initiated_at: now() (NEW)
│  │     ├─ Create refund transaction record (NEW)
│  │     ├─ Alert admin for immediate action (NEW)
│  │     └─ If auto-refund enabled: Initiate Binance withdrawal
│  └─ If status 'verified' → Do nothing (already a member)
├─ Expire reservation
└─ Decrement reserved seats

T+30min+ (Admin Actions)
├─ Admin sees alert in dashboard
├─ Admin views transaction details
├─ Admin initiates refund via Binance API
├─ Refund TX created
├─ User receives funds back
└─ Refund marked as completed
```

---

## 🔧 Implementation Details

### Service: `vc-pool-transactions-admin.service.ts` (NEW)

```typescript
async listTransactions(
  adminId: string,
  poolId: string,
  filters: {
    status?: string;
    type?: string;
    dateFrom?: Date;
    dateTo?: Date;
    page?: number;
    limit?: number;
  }
): Promise<any>

async getTransactionDetail(
  adminId: string,
  poolId: string,
  txId: string
): Promise<any>
```

### Controller Endpoints (NEW)

```
GET /admin/pools/:poolId/transactions
  - Query: status, type, dateFrom, dateTo, page, limit
  - Returns: List of transactions with pagination

GET /admin/pools/:poolId/transactions/:txId
  - Returns: Single transaction with full details
  - Includes: Binance API response, error messages, refund status
```

### Database Schema Updates

No schema changes needed. Using existing fields:
- `vc_pool_transactions.status` - pending, verified, rejected, refund_processing, refund_completed, failed
- `vc_pool_transactions.description` - Error/refund details
- `vc_pool_payment_submissions.refund_initiated_at` - Tracks when refund was initiated
- `vc_pool_payment_submissions.refund_reason` - Why refund was initiated

---

## 🗂 Files Changed

1. **NEW** - `src/modules/vc-pool/services/vc-pool-transactions-admin.service.ts`
2. **UPDATED** - `src/modules/vc-pool/controllers/admin-pool.controller.ts`
3. **UPDATED** - `src/modules/vc-pool/schedulers/seat-expiry.scheduler.ts`
4. **UPDATED** - `src/modules/vc-pool/services/binance-verification.service.ts`
5. **UPDATED** - `src/modules/vc-pool/vc-pool.module.ts`

---

## 🎯 Benefits

✅ **Visibility** - Admin can see all transactions and their status in one place  
✅ **Debugging** - Full audit trail shows why payments were rejected  
✅ **Refunds** - Automated refund initiation when payments expire or fail  
✅ **User Experience** - Clear feedback on why payment was rejected  
✅ **Compliance** - Complete transaction history for auditing  

---

## 🧪 Testing Checklist

- [ ] Join pool, submit TX ID, payment auto-verified within 5 min
- [ ] Join pool, submit TX with wrong amount, auto-rejected with reason
- [ ] Join pool, don't submit TX, seat expires at 30 min
  - [ ] Reservation marked as expired
  - [ ] Payment marked as expired
  - [ ] Refund initiated (admin alerted)
  - [ ] User can't rejoin immediately
- [ ] Admin views transactions page
  - [ ] Sees all transactions
  - [ ] Filters work (status, type, date range)
  - [ ] Pagination works
- [ ] Admin views single transaction detail
  - [ ] Sees full error message
  - [ ] Sees Binance API response
  - [ ] Sees refund status
