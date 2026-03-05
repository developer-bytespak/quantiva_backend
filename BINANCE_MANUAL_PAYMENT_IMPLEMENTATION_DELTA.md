# Binance Manual Payment Implementation - SCHEMA DELTA ONLY

> **Status:** February 2025 | **Approach:** Minimal invasive changes to existing schema
> 
> **Context:** Core VC Pool infrastructure already exists in Prisma. This document shows ONLY the NEW tables and fields required for the Binance manual payment flow with automatic shortfall/overpayment handling.

---

## ✅ SCHEMA ALREADY COMPLETE

The following are **already fully implemented** in current Prisma schema:

### Existing Models (No Changes Needed)
- `admins` — Full admin infrastructure with Binance API credentials
- `admin_sessions` — Session management for admins
- `vc_pools` — Pool definitions with all fee calculations
- `vc_pool_seat_reservations` — Payment method already stored here
- `vc_pool_payment_submissions` — Base payment tracking (NOTE: has Stripe fields, but we'll add Binance)
- `vc_pool_members` — Member tracking with shares and binance_uid
- `vc_pool_trades`, `vc_pool_exchange_orders`, `vc_pool_cancellations`, `vc_pool_payouts` — Trading & exit flows

### Existing Enums (No Changes Needed)
- `PoolStatus`, `VcPaymentMethod`, `PaymentSubmissionStatus`, `ExitRequestStatus`, `PoolPayoutStatus`, `PayoutType`, `NotificationType`

---

## ❌ NEW ADDITIONS REQUIRED

### 1. **NEW Enum: ShortfallHandlingStatus**

```prisma
enum ShortfallHandlingStatus {
  auto_approved      // ≤ 0.5% shortfall = auto-approve immediately
  admin_review       // 0.5% - 2% shortfall = hold for admin review
  auto_rejected      // > 2% shortfall = auto-reject
  completed          // Shortfall resolved (user sent additional payment)
  expired            // Suspense period expired without resolution
  refund_processed   // Overpayment refunded to user_credits
}
```

---

### 2. **NEW Model: vc_pool_transactions**

Complete transaction audit trail for all VC pool financial events (payments, shortfalls, suspense, refunds).

```prisma
model vc_pool_transactions {
  transaction_id            String    @id @default(uuid()) @db.Uuid
  pool_id                   String    @db.Uuid
  user_id                   String    @db.Uuid
  payment_submission_id     String?   @unique @db.Uuid
  member_id                 String?   @db.Uuid
  
  // Transaction Details
  transaction_type          String    @db.VarChar(50)  // payment, shortfall, overpayment, refund, suspense_resolved
  amount_usdt               Decimal   @db.Decimal(20, 8)
  description               String?   @db.Text
  
  // Binance TX Details
  binance_tx_hash           String?   @db.VarChar(255) @unique
  binance_tx_timestamp      DateTime? @db.Timestamp(6)
  
  // Shortfall/Overpayment Tracking
  expected_amount           Decimal?  @db.Decimal(20, 8)
  actual_amount_received    Decimal?  @db.Decimal(20, 8)
  variance_amount           Decimal?  @db.Decimal(20, 8)       // Can be negative (shortfall) or positive (overpayment)
  variance_percent          Decimal?  @db.Decimal(5, 2)
  shortfall_handling_status ShortfallHandlingStatus?
  
  // Suspense Account Tracking (for shortfalls)
  suspense_until_date       DateTime? @db.Timestamp(6)
  additional_payment_needed Decimal?  @db.Decimal(20, 8)       // Amount user needs to send
  
  // Overpayment Handling
  credited_to_user_account  Boolean   @default(false)
  user_credit_id            String?   @db.Uuid
  
  // Status & Timestamps
  status                    String    @db.VarChar(50)          // pending, verified, rejected, resolved, failed
  created_at                DateTime  @default(now()) @db.Timestamp(6)
  updated_at                DateTime? @updatedAt @db.Timestamp(6)
  resolved_at               DateTime? @db.Timestamp(6)
  
  // Relations
  pool                      vc_pools                    @relation(fields: [pool_id], references: [pool_id])
  user                      users                       @relation(fields: [user_id], references: [user_id])
  payment_submission        vc_pool_payment_submissions? @relation("PaymentTransaction", fields: [payment_submission_id], references: [submission_id])
  member                    vc_pool_members?            @relation(fields: [member_id], references: [member_id])
  user_credit               user_credits?               @relation(fields: [user_credit_id], references: [credit_id])
  
  @@index([pool_id])
  @@index([user_id])
  @@index([shortfall_handling_status])
  @@index([status])
  @@index([created_at])
  @@index([binance_tx_hash])
  @@index([suspense_until_date])
  @@map("vc_pool_transactions")
}
```

---

### 3. **NEW Model: user_credits**

Tracks account credits for overpayments that can be:
- Auto-credited to user account balance
- Used for future pool investments
- Withdrawn to wallet (if implemented)

```prisma
model user_credits {
  credit_id             String    @id @default(uuid()) @db.Uuid
  user_id               String    @db.Uuid
  
  credit_amount_usdt    Decimal   @db.Decimal(20, 8)
  source                String    @db.VarChar(50)      // overpayment, refund, other
  
  is_spent              Boolean   @default(false)
  spent_on_pool_id      String?   @db.Uuid            // Which pool was credit used for?
  spent_amount          Decimal?  @db.Decimal(20, 8)  // How much was spent?
  
  created_at            DateTime  @default(now()) @db.Timestamp(6)
  spent_at              DateTime? @db.Timestamp(6)
  
  user                  users     @relation(fields: [user_id], references: [user_id], onDelete: Cascade)
  transaction_source    vc_pool_transactions[] @relation("CreditSource")
  
  @@index([user_id])
  @@index([is_spent])
  @@map("user_credits")
}
```

---

### 4. **EXTEND: users table**

Add new field for Binance deposit address:

```prisma
model users {
  // ... existing fields ...
  
  // NEW FOR BINANCE PAYMENT
  binance_deposit_address    String?  @db.VarChar(255)  // User's Binance wallet address (if different from admin's)
  
  // NEW RELATION TO CREDITS
  user_credits               user_credits[]
  
  // NEW RELATION TO TRANSACTIONS
  vc_pool_transactions       vc_pool_transactions[]
}
```

---

### 5. **EXTEND: vc_pool_payment_submissions table**

Add Binance-specific fields for manual payment tracking:

```prisma
model vc_pool_payment_submissions {
  // ... existing fields ...
  
  // NEW FOR BINANCE PAYMENT
  binance_tx_id                   String?        @db.VarChar(255)       // Transaction hash from Binance
  binance_tx_timestamp            DateTime?      @db.Timestamp(6)       // When Binance recorded TX
  binance_amount_received_usdt    Decimal?       @db.Decimal(20, 8)     // What admin actually received
  
  // NEW FOR SHORTFALL/OVERPAYMENT HANDLING
  expected_investment_amount      Decimal        @db.Decimal(20, 8)     // Expected amount from pool config
  total_expected_with_fee         Decimal        @db.Decimal(20, 8)     // investment + fees
  
  shortfall_amount                Decimal?       @db.Decimal(20, 8)     // If amount < expected (NULL if >= expected)
  overpayment_amount              Decimal?       @db.Decimal(20, 8)     // If amount > expected (NULL if <= expected)
  variance_percent                Decimal?       @db.Decimal(5, 2)      // (actual - expected) / expected * 100
  
  shortfall_handling_status       ShortfallHandlingStatus?
  shortfall_tolerance_applied     Decimal?       @db.Decimal(5, 2)      // Which tolerance level was used for decision
  
  // Suspense account tracking
  is_in_suspense                  Boolean        @default(false)
  suspense_expires_at             DateTime?      @db.Timestamp(6)       // When auto-refund/rejection happens
  suspense_reason                 String?        @db.VarChar(500)       // "User underpaid by 1.5%, admin review required"
  
  // NEW RELATION TO TRANSACTION AUDIT
  transaction_record             vc_pool_transactions? @relation("PaymentTransaction")
}
```

---

## 📋 Migration Steps

### Step 1: Add New Enum (5 minutes)
```prisma
enum ShortfallHandlingStatus {
  auto_approved
  admin_review
  auto_rejected
  completed
  expired
  refund_processed
}
```

### Step 2: Create New Tables (15 minutes)
- `vc_pool_transactions`
- `user_credits`

Create migration:
```bash
npx prisma migrate dev --name "add_binance_payment_shortfall_handling"
```

### Step 3: Extend Existing Tables (10 minutes)
- Add 7 new fields to `vc_pool_payment_submissions`
- Add 2 new fields to `users` table

Migration:
```bash
npx prisma migrate dev --name "extend_payment_submissions_and_users_for_binance"
```

### Step 4: Add Indexes (5 minutes)
Performance indexes on transaction queries:
- vc_pool_transactions(pool_id, status)
- vc_pool_transactions(user_id, created_at)
- vc_pool_transactions(shortfall_handling_status, suspense_until_date)
- user_credits(user_id, is_spent)

---

## 🔄 Implementation Flow (With Existing Schema)

### Payment Submission Workflow

```
1. User reserves seat
   ✅ vc_pool_seat_reservations.status = reserved
   ✅ vc_pool_seat_reservations.payment_method = binance

2. User submits payment proof (TX ID)
   ✅ CREATE vc_pool_payment_submissions
   ✅ payment_method = binance
   ✅ NEW: binance_tx_id = user provided TX
   ✅ NEW: expected_investment_amount = pool.contribution_amount
   ✅ status = pending

3. Admin Backend Cron Job (Every 5 minutes)
   ✅ Fetch admins.binance_api_key_encrypted (decrypt)
   ✅ Query Binance API for admin's deposit TX in last 24h
   ✅ Find matching TX by ID from payment_submissions
   ✅ NEW: binance_amount_received_usdt = amount from Binance
   
4. Automatic Shortfall/Overpayment Detection
   - If binance_amount_received == expected_investment
     ✅ NEW: shortfall_amount = NULL
     ✅ NEW: shortfall_handling_status = NULL
     ✅ status = verified ✓ APPROVED
     ✅ CREATE vc_pool_members
     ✅ CREATE vc_pool_transactions(type: payment, status: verified)
   
   - If binance_amount_received < expected_investment
     ✅ NEW: shortfall_amount = expected - received
     ✅ NEW: variance_percent = (shortfall / expected) * 100
     
     🔹 IF shortfall ≤ 0.5%
        ✅ NEW: shortfall_handling_status = auto_approved
        ✅ status = verified ✓ APPROVED
        ✅ CREATE vc_pool_members
        ✅ CREATE vc_pool_transactions(type: payment, status: verified)
     
     🔹 ELSE IF 0.5% < shortfall ≤ 2%
        ✅ NEW: shortfall_handling_status = admin_review
        ✅ NEW: is_in_suspense = true
        ✅ NEW: suspense_expires_at = now + 24h
        ✅ status = processing
        ✅ Create vc_pool_transactions(type: shortfall)
        ✅ Notify admin (pending review)
     
     🔹 ELSE (shortfall > 2%)
        ✅ NEW: shortfall_handling_status = auto_rejected
        ✅ status = rejected
        ✅ rejection_reason = "Underpayment exceeds 2% tolerance"
        ✅ Create vc_pool_transactions(type: shortfall)
        ✅ Return funds to user wallet
   
   - If binance_amount_received > expected_investment
     ✅ NEW: overpayment_amount = received - expected
     ✅ NEW: variance_percent = (overpayment / expected) * 100
     ✅ NEW: shortfall_handling_status = refund_processed
     ✅ status = verified ✓ APPROVED (accept full amount as pool investment)
     ✅ CREATE vc_pool_members
     ✅ NEW: CREATE user_credits(amount: overpayment, source: overpayment)
     ✅ Create vc_pool_transactions(type: overpayment)

5. Admin Manual Review (For 0.5-2% shortfalls)
   ✅ Admin dashboard shows pending reviews
   ✅ Admin action: approve or reject
   
   🔹 IF Approve:
      ✅ shortfall_handling_status = completed
      ✅ status = verified ✓ APPROVED
      ✅ CREATE vc_pool_members
      ✅ Create vc_pool_transactions(type: shortfall, status: completed)
   
   🔹 IF Reject:
      ✅ shortfall_handling_status = completed
      ✅ status = rejected
      ✅ rejection_reason = "Admin rejected 1.8% shortfall"
      ✅ Return funds to user wallet

6. Suspense Expiry Cron (Runs daily at 00:00 UTC)
   ✅ Find vc_pool_payment_submissions WHERE:
      - is_in_suspense = true
      - suspense_expires_at <= now()
      - status = processing
   ✅ Auto-reject them
   ✅ Return funds
   ✅ shortfall_handling_status = expired
   ✅ Create vc_pool_transactions(type: suspense_resolved, status: failed)
```

---

## 📊 Database Schema Comparison

| Model/Field | Current Status | New Status | Action |
|---|---|---|---|
| `admins` table | ✅ Exists | ✅ Complete | No changes |
| `vc_pools` table | ✅ Exists | ✅ Complete | No changes |
| `vc_pool_members` table | ✅ Exists | ✅ Complete | No changes |
| `users.binance_deposit_address` | ❌ Missing | ✅ Add | NEW |
| `users.vc_pool_transactions` relation | ❌ Missing | ✅ Add | NEW |
| `users.user_credits` relation | ❌ Missing | ✅ Add | NEW |
| `vc_pool_payment_submissions.binance_tx_id` | ❌ Missing | ✅ Add | NEW |
| `vc_pool_payment_submissions.binance_amount_received_usdt` | ❌ Missing | ✅ Add | NEW |
| `vc_pool_payment_submissions.shortfall_amount` | ❌ Missing | ✅ Add | NEW |
| `vc_pool_payment_submissions.shortfall_handling_status` | ❌ Missing | ✅ Add | NEW |
| `vc_pool_payment_submissions.is_in_suspense` | ❌ Missing | ✅ Add | NEW |
| `vc_pool_payment_submissions.suspense_expires_at` | ❌ Missing | ✅ Add | NEW |
| `vc_pool_transactions` table | ❌ Missing | ✅ Add | NEW |
| `user_credits` table | ❌ Missing | ✅ Add | NEW |
| `ShortfallHandlingStatus` enum | ❌ Missing | ✅ Add | NEW |

---

## 🎯 Implementation Timeline (Revised)

- **Schema Changes:** 30 minutes (2 migrations)
- **Backend Services:** 12-16 hours
  - Payment submission service
  - Binance TX verification service
  - Shortfall/overpayment handler
  - Suspense account cron job
  - User credits service
  - Database transaction tracking service
  
- **Admin Dashboard:** 4-6 hours
  - Pending reviews queue
  - Shortfall approval/rejection UI
  - Transaction history view
  
- **Testing & Validation:** 4 hours

**Total Implementation Time: 21-27 hours**

---

## ✅ Summary

**No existing models need deletion or major refactoring.** The new Binance manual payment flow fits seamlessly into the existing VC Pool infrastructure by:

1. Adding minimal new tables (`vc_pool_transactions`, `user_credits`)
2. Extending `vc_pool_payment_submissions` with Binance-specific fields
3. Adding comprehensive shortfall/overpayment handling logic at the service layer
4. Treating shortfalls as temporary suspenses, not hard failures
5. Auto-crediting overpayments for reuse in future pool investments

The schema change is **non-breaking** and backward-compatible with existing Stripe payment infrastructure.
