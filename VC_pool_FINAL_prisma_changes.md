# VC Pool — Final Prisma Schema Changes (v2)

**Definitive specification. Apply these changes to `prisma/schema.prisma` when ready.**
**Supersedes:** `VC_pool_prisma_changes.md`, `VC_pool_prisma_summary.md`, v1 of this file.

---

## Design Decisions (locked in)

| Decision | Choice | Rationale |
|---|---|---|
| Payment methods | **Dual**: Stripe (auto) + Binance manual (screenshot + admin approval) | User selects method when joining; locked for that membership's lifetime |
| Stripe keys | Per-admin, encrypted in `admins` table | Each admin has their own Stripe account; keys encrypted via EncryptionService |
| Stripe payouts | Stripe Connect — users connect bank account via Stripe to receive payouts | Handles profit payouts exceeding original charge |
| Binance payment | Fully manual — user transfers, uploads screenshot, admin approves/rejects | No Binance API needed for payments; admin's Binance UID shown in pool details |
| Binance trading | Admin's Binance API keys (encrypted) for executing pool trades | Reuses existing EncryptionService |
| Screenshot storage | Cloudinary (already set up in codebase) | Reuses existing `CloudinaryService` |
| Payment verification | Stripe: automated via webhook; Binance: manual admin review | No automated scheduler needed for payment verification |
| Seat reservation timer | Applies to both methods (configurable `payment_window_minutes`) | Stripe: time to complete checkout; Binance: time to upload screenshot |
| Seat confirmation | Stripe: auto-confirmed on webhook; Binance: confirmed immediately when admin approves | No extra step after approval |
| Investment model | Fixed amount per user per pool | Equal shares |
| Admin system | Completely separate from `users` | Own email/password, own sessions, different URL `/admin/auth/*` |
| Pool dates | `started_at` + `end_date` set when admin starts pool, NOT at creation | `end_date = started_at + duration_days` |
| Pool trades | Standalone `vc_pool_trades` table referencing `strategies` | Does NOT go through `strategy_signals → orders` pipeline |
| BCNF | `vc_pool_payouts` and `vc_pool_cancellations` omit `user_id` | Resolve via `member.user` |
| Access control | Only ELITE tier users can join pools | `FeatureType.VC_POOL_ACCESS` |

---

## Fee Structure (3 fees, all configurable per pool)

| Fee | When Charged | Stored On | Example |
|---|---|---|---|
| **Pool fee** (`pool_fee_percent`) | Upfront when user joins | `vc_pools` | User invests 100 + 5% fee = sends 105 total |
| **Admin profit fee** (`admin_profit_fee_percent`) | On pool completion, from profits only | `vc_pools` | Pool profits 200 → admin takes 20% = 40 |
| **Cancellation fee** (`cancellation_fee_percent`) | When user exits early | `vc_pools` | User exits with 110 value → 5% = 5.50 fee |

Admin sets defaults in `admins` table. Each pool copies defaults at creation but can override.

---

## 1. Existing Schema — Reuse (No Changes Needed to These)

| Existing | Use in VC Pool |
|---|---|
| `users` — user_id, email, kyc_status, current_tier | Pool members |
| `FeatureType.VC_POOL_ACCESS` | Gate behind ELITE subscription |
| `strategies` — strategy_id | Pool trades tagged with strategy |
| `SignalAction` (BUY, SELL, HOLD) | Reuse for `vc_pool_trades.action` |
| `subscription_usage` + `plan_features` | Track pool access limits per tier |
| `EncryptionService` (AES-256-GCM) | Encrypt admin Binance API keys + Stripe keys |
| `CloudinaryService` | Store Binance payment screenshots |
| Redis + BullMQ | Seat expiry scheduler + pool value updater |

---

## 2. Add to Existing Models

### 2.1 Add to `users` Model

**Location:** Inside `model users { ... }`, add before `@@index([current_tier])`:

```prisma
  stripe_connect_account_id  String?                     @db.VarChar(255)

  pool_memberships           vc_pool_members[]
  pool_seat_reservations     vc_pool_seat_reservations[]
  pool_payment_submissions   vc_pool_payment_submissions[]
```

- `stripe_connect_account_id`: Set when user completes Stripe Connect onboarding (required before receiving Stripe payouts).
- No `is_admin` — admin is completely separate.

### 2.2 Add to `strategies` Model

**Location:** Inside `model strategies { ... }`, add with other relations:

```prisma
  vc_pool_trades             vc_pool_trades[]
```

---

## 3. New Enums

**Location:** Add after the existing `enum PaymentStatus { ... }` block.

```prisma
enum PoolStatus {
  draft
  open
  full
  active
  completed
  cancelled
}

enum PaymentMethod {
  stripe
  binance
}

enum SeatReservationStatus {
  reserved
  confirmed
  released
  expired
}

enum PaymentSubmissionStatus {
  pending
  processing
  verified
  rejected
  expired
}

enum ExitRequestStatus {
  pending
  approved
  rejected
  processed
}

enum PoolPayoutStatus {
  pending
  processing
  completed
  failed
}

enum PayoutType {
  completion
  pool_cancelled
}
```

**Status flows per payment method:**

| Status | Stripe | Binance |
|---|---|---|
| `pending` | Checkout session created, user redirected | Waiting for user to upload screenshot |
| `processing` | *(skipped — goes pending → verified via webhook)* | Screenshot uploaded, awaiting admin review |
| `verified` | Webhook confirms payment success | Admin approves screenshot |
| `rejected` | Webhook reports payment failure | Admin rejects screenshot |
| `expired` | User didn't complete checkout in time | User didn't upload screenshot in time |

---

## 4. New Models

**Location:** Add after `payment_history` model, before `enum KycStatus`.

### 4.1 admins

Completely separate from `users`. Each admin has their own Stripe account AND Binance connection.
All secret keys are encrypted via `EncryptionService` (AES-256-GCM).

```prisma
model admins {
  admin_id                          String                  @id @default(uuid()) @db.Uuid
  email                             String                  @unique @db.VarChar(255)
  password_hash                     String                  @db.VarChar(255)
  full_name                         String?                 @db.VarChar(120)

  // Stripe — each admin has their own Stripe account (encrypted via EncryptionService)
  stripe_secret_key_encrypted       String?
  stripe_publishable_key            String?                 @db.VarChar(255)
  stripe_webhook_secret_encrypted   String?

  // Binance — UID shown to users for manual transfers; API keys for pool trading
  binance_uid                       String?                 @db.VarChar(100)
  binance_api_key_encrypted         String?
  binance_api_secret_encrypted      String?

  // Default fee settings (copied to new pools, overridable per pool)
  default_pool_fee_percent          Decimal                 @default(5.00) @db.Decimal(5, 2)
  default_admin_profit_fee_percent  Decimal                 @default(20.00) @db.Decimal(5, 2)
  default_cancellation_fee_percent  Decimal                 @default(5.00) @db.Decimal(5, 2)
  default_payment_window_minutes    Int                     @default(30)

  created_at                        DateTime                @default(now()) @db.Timestamp(6)
  updated_at                        DateTime?               @updatedAt @db.Timestamp(6)

  sessions                          admin_sessions[]
  pools                             vc_pools[]
  pool_trades                       vc_pool_trades[]
  reviewed_payments                 vc_pool_payment_submissions[] @relation("PaymentReviewer")
  reviewed_cancellations            vc_pool_cancellations[]

  @@map("admins")
}
```

**Stripe webhook URL per admin:** Each admin configures their Stripe webhook URL as:
`https://your-domain.com/webhooks/stripe/{admin_id}`
This allows the backend to look up the correct `stripe_webhook_secret_encrypted` for signature verification.

### 4.2 admin_sessions

Mirrors `user_sessions` but FK to `admins`. Required because admin is not in `users` table.

```prisma
model admin_sessions {
  session_id         String   @id @default(uuid()) @db.Uuid
  admin_id           String   @db.Uuid
  issued_at          DateTime @default(now()) @db.Timestamp(6)
  expires_at         DateTime @db.Timestamp(6)
  revoked            Boolean  @default(false)
  device_id          String?  @db.VarChar(255)
  ip_address         String?  @db.VarChar(45)
  refresh_token_hash String?

  admin              admins   @relation(fields: [admin_id], references: [admin_id], onDelete: Cascade)

  @@index([admin_id])
  @@map("admin_sessions")
}
```

### 4.3 vc_pools

Core pool definition. `started_at` and `end_date` are set when admin starts the pool (not at creation).
Both Stripe and Binance are always available — user chooses at join time.

```prisma
model vc_pools {
  pool_id                    String                          @id @default(uuid()) @db.Uuid
  admin_id                   String                          @db.Uuid

  name                       String                          @db.VarChar(150)
  description                String?                         @db.Text
  coin_type                  String                          @default("USDT") @db.VarChar(10)

  contribution_amount        Decimal                         @db.Decimal(20, 8)
  max_members                Int

  // Fees (copied from admin defaults at creation, overridable)
  pool_fee_percent           Decimal                         @db.Decimal(5, 2)
  admin_profit_fee_percent   Decimal                         @db.Decimal(5, 2)
  cancellation_fee_percent   Decimal                         @db.Decimal(5, 2)

  payment_window_minutes     Int                             @default(30)
  duration_days              Int

  status                     PoolStatus                      @default(draft)

  // Set when admin starts the pool (status → active)
  started_at                 DateTime?                       @db.Timestamp(6)
  end_date                   DateTime?                       @db.Timestamp(6)

  // Cloning / replication
  is_replica                 Boolean                         @default(false)
  original_pool_id           String?                         @db.Uuid

  // Counters (updated atomically to avoid COUNT queries)
  verified_members_count     Int                             @default(0)
  reserved_seats_count       Int                             @default(0)

  // Aggregate financials (updated periodically)
  total_invested_usdt        Decimal?                        @db.Decimal(20, 8)
  current_pool_value_usdt    Decimal?                        @db.Decimal(20, 8)
  total_profit_usdt          Decimal?                        @db.Decimal(20, 8)
  total_pool_fees_usdt       Decimal?                        @db.Decimal(20, 8)
  admin_fee_earned_usdt      Decimal?                        @db.Decimal(20, 8)

  is_archived                Boolean                         @default(false)
  created_at                 DateTime                        @default(now()) @db.Timestamp(6)
  updated_at                 DateTime?                       @updatedAt @db.Timestamp(6)
  completed_at               DateTime?                       @db.Timestamp(6)
  cancelled_at               DateTime?                       @db.Timestamp(6)

  admin                      admins                          @relation(fields: [admin_id], references: [admin_id])
  original_pool              vc_pools?                       @relation("PoolReplica", fields: [original_pool_id], references: [pool_id])
  replicas                   vc_pools[]                      @relation("PoolReplica")
  members                    vc_pool_members[]
  seat_reservations          vc_pool_seat_reservations[]
  payment_submissions        vc_pool_payment_submissions[]
  trades                     vc_pool_trades[]
  payouts                    vc_pool_payouts[]
  cancellations              vc_pool_cancellations[]

  @@index([admin_id])
  @@index([status])
  @@index([is_archived])
  @@map("vc_pools")
}
```

### 4.4 vc_pool_seat_reservations

Locks a seat when user clicks "Join Pool". Timer applies to both payment methods:
- Stripe: user must complete Stripe checkout within the window
- Binance: user must upload screenshot within the window

```prisma
model vc_pool_seat_reservations {
  reservation_id     String                       @id @default(uuid()) @db.Uuid
  pool_id            String                       @db.Uuid
  user_id            String                       @db.Uuid

  payment_method     PaymentMethod
  reserved_at        DateTime                     @default(now()) @db.Timestamp(6)
  expires_at         DateTime                     @db.Timestamp(6)
  status             SeatReservationStatus        @default(reserved)

  pool               vc_pools                     @relation(fields: [pool_id], references: [pool_id])
  user               users                        @relation(fields: [user_id], references: [user_id])
  payment_submission vc_pool_payment_submissions?

  @@unique([pool_id, user_id])
  @@index([pool_id])
  @@index([user_id])
  @@index([status])
  @@index([expires_at])
  @@map("vc_pool_seat_reservations")
}
```

### 4.5 vc_pool_payment_submissions

Handles both payment methods. Stripe fields are null for Binance, and vice versa.

**Stripe flow:** `pending → verified` (webhook) or `pending → expired` (timeout)
**Binance flow:** `pending → processing` (screenshot uploaded) `→ verified` (admin approves) or `→ rejected` (admin rejects), or `pending → expired` (timeout)

```prisma
model vc_pool_payment_submissions {
  submission_id              String                       @id @default(uuid()) @db.Uuid
  pool_id                    String                       @db.Uuid
  user_id                    String                       @db.Uuid
  reservation_id             String                       @unique @db.Uuid

  payment_method             PaymentMethod
  investment_amount          Decimal                      @db.Decimal(20, 8)
  pool_fee_amount            Decimal                      @db.Decimal(20, 8)
  total_amount               Decimal                      @db.Decimal(20, 8)

  // ── Stripe fields (null for Binance payments) ──
  stripe_checkout_session_id String?                      @db.VarChar(255)
  stripe_payment_intent_id   String?                      @unique @db.VarChar(255)

  // ── Binance fields (null for Stripe payments) ──
  screenshot_url             String?
  admin_notes                String?                      @db.VarChar(500)

  status                     PaymentSubmissionStatus      @default(pending)
  payment_deadline           DateTime                     @db.Timestamp(6)

  rejection_reason           String?                      @db.VarChar(500)
  reviewed_by_admin_id       String?                      @db.Uuid
  verified_at                DateTime?                    @db.Timestamp(6)
  submitted_at               DateTime                     @default(now()) @db.Timestamp(6)

  pool                       vc_pools                     @relation(fields: [pool_id], references: [pool_id])
  user                       users                        @relation(fields: [user_id], references: [user_id])
  reservation                vc_pool_seat_reservations    @relation(fields: [reservation_id], references: [reservation_id])
  reviewing_admin            admins?                      @relation("PaymentReviewer", fields: [reviewed_by_admin_id], references: [admin_id])

  @@index([pool_id])
  @@index([user_id])
  @@index([status])
  @@index([stripe_payment_intent_id])
  @@map("vc_pool_payment_submissions")
}
```

### 4.6 vc_pool_members

Created when payment is verified (auto for Stripe, admin approval for Binance).
`payment_method` is locked — all future transactions (refunds, payouts) use this method.

```prisma
model vc_pool_members {
  member_id            String                     @id @default(uuid()) @db.Uuid
  pool_id              String                     @db.Uuid
  user_id              String                     @db.Uuid

  payment_method       PaymentMethod
  invested_amount_usdt Decimal                    @db.Decimal(20, 8)
  share_percent        Decimal                    @db.Decimal(8, 5)
  user_binance_uid     String?                    @db.VarChar(100)

  is_active            Boolean                    @default(true)
  joined_at            DateTime                   @default(now()) @db.Timestamp(6)
  exited_at            DateTime?                  @db.Timestamp(6)

  pool                 vc_pools                   @relation(fields: [pool_id], references: [pool_id])
  user                 users                      @relation(fields: [user_id], references: [user_id])
  payouts              vc_pool_payouts[]
  cancellation         vc_pool_cancellations?

  @@unique([pool_id, user_id])
  @@index([pool_id])
  @@index([user_id])
  @@map("vc_pool_members")
}
```

### 4.7 vc_pool_trades

Admin-executed trades. Standalone table — does NOT flow through `strategy_signals → orders`.
Execution uses admin's Binance API keys (encrypted in `admins` table).

```prisma
model vc_pool_trades {
  trade_id             String                     @id @default(uuid()) @db.Uuid
  pool_id              String                     @db.Uuid
  strategy_id          String?                    @db.Uuid
  admin_id             String                     @db.Uuid

  asset_pair           String                     @db.VarChar(20)
  action               SignalAction
  quantity             Decimal                    @db.Decimal(30, 10)
  entry_price_usdt     Decimal                    @db.Decimal(20, 8)
  exit_price_usdt      Decimal?                   @db.Decimal(20, 8)
  pnl_usdt             Decimal?                   @db.Decimal(20, 8)
  is_open              Boolean                    @default(true)

  binance_order_id     String?                    @db.VarChar(100)

  notes                String?                    @db.Text
  traded_at            DateTime                   @db.Timestamp(6)
  closed_at            DateTime?                  @db.Timestamp(6)
  created_at           DateTime                   @default(now()) @db.Timestamp(6)

  pool                 vc_pools                   @relation(fields: [pool_id], references: [pool_id])
  strategy             strategies?                @relation(fields: [strategy_id], references: [strategy_id])
  admin                admins                     @relation(fields: [admin_id], references: [admin_id])

  @@index([pool_id])
  @@index([strategy_id])
  @@index([is_open])
  @@index([pool_id, strategy_id])
  @@map("vc_pool_trades")
}
```

### 4.8 vc_pool_cancellations

User-initiated exit requests. Refund uses the member's locked `payment_method`.
`user_id` NOT stored (BCNF) — resolve via `member.user`.

```prisma
model vc_pool_cancellations {
  cancellation_id          String                   @id @default(uuid()) @db.Uuid
  pool_id                  String                   @db.Uuid
  member_id                String                   @unique @db.Uuid

  pool_status_at_request   PoolStatus
  invested_amount          Decimal                  @db.Decimal(20, 8)
  share_percent_at_exit    Decimal?                 @db.Decimal(8, 5)
  pool_value_at_exit       Decimal?                 @db.Decimal(20, 8)
  member_value_at_exit     Decimal                  @db.Decimal(20, 8)

  cancellation_fee_pct     Decimal                  @db.Decimal(5, 2)
  fee_amount               Decimal                  @db.Decimal(20, 8)
  refund_amount            Decimal                  @db.Decimal(20, 8)

  // Refund tracking (method determined by member.payment_method)
  stripe_refund_id         String?                  @db.VarChar(255)
  stripe_transfer_id       String?                  @db.VarChar(255)
  binance_refund_tx_id     String?                  @db.VarChar(255)

  status                   ExitRequestStatus        @default(pending)
  requested_at             DateTime                 @default(now()) @db.Timestamp(6)
  reviewed_by_admin_id     String?                  @db.Uuid
  reviewed_at              DateTime?                @db.Timestamp(6)
  rejection_reason         String?                  @db.VarChar(500)
  refunded_at              DateTime?                @db.Timestamp(6)

  pool                     vc_pools                 @relation(fields: [pool_id], references: [pool_id])
  member                   vc_pool_members          @relation(fields: [member_id], references: [member_id])
  reviewing_admin          admins?                  @relation(fields: [reviewed_by_admin_id], references: [admin_id])

  @@index([pool_id])
  @@index([member_id])
  @@index([status])
  @@map("vc_pool_cancellations")
}
```

### 4.9 vc_pool_payouts

Final distributions when pool completes OR full refunds when admin cancels unfilled pool.
Payout method follows the member's locked `payment_method`.

```prisma
model vc_pool_payouts {
  payout_id              String                     @id @default(uuid()) @db.Uuid
  pool_id                String                     @db.Uuid
  member_id              String                     @db.Uuid

  payout_type            PayoutType

  initial_investment     Decimal                    @db.Decimal(20, 8)
  share_percent          Decimal                    @db.Decimal(8, 5)
  pool_final_value       Decimal?                   @db.Decimal(20, 8)
  gross_payout           Decimal                    @db.Decimal(20, 8)
  admin_fee_deducted     Decimal                    @db.Decimal(20, 8)
  net_payout             Decimal                    @db.Decimal(20, 8)
  profit_loss            Decimal                    @db.Decimal(20, 8)

  // Payment tracking (method from member.payment_method)
  stripe_refund_id       String?                    @db.VarChar(255)
  stripe_transfer_id     String?                    @db.VarChar(255)
  binance_tx_id          String?                    @db.VarChar(255)

  status                 PoolPayoutStatus           @default(pending)
  paid_at                DateTime?                  @db.Timestamp(6)
  notes                  String?                    @db.Text
  created_at             DateTime                   @default(now()) @db.Timestamp(6)

  pool                   vc_pools                   @relation(fields: [pool_id], references: [pool_id])
  member                 vc_pool_members            @relation(fields: [member_id], references: [member_id])

  @@index([pool_id])
  @@index([member_id])
  @@index([status])
  @@map("vc_pool_payouts")
}
```

---

## 5. Summary: All Tables

| # | Table | Type | Purpose |
|---|---|---|---|
| 1 | `admins` | **NEW** | Admin users, Stripe keys (encrypted) + Binance connection, default fees |
| 2 | `admin_sessions` | **NEW** | Admin JWT sessions |
| 3 | `vc_pools` | **NEW** | Pool definitions with fees, status, counters, financials |
| 4 | `vc_pool_seat_reservations` | **NEW** | Seat lock + timer (Stripe checkout / Binance screenshot window) |
| 5 | `vc_pool_payment_submissions` | **NEW** | Dual: Stripe checkout data OR Binance screenshot + admin review |
| 6 | `vc_pool_members` | **NEW** | Verified contributors with locked `payment_method` and share % |
| 7 | `vc_pool_trades` | **NEW** | Admin-executed pool trades linked to strategy |
| 8 | `vc_pool_cancellations` | **NEW** | User exit requests with fee calculation + refund tracking |
| 9 | `vc_pool_payouts` | **NEW** | Pool completion payouts + pool-cancelled refunds |
| 10 | `users` | **MODIFIED** | Add `stripe_connect_account_id` + 3 pool relations |
| 11 | `strategies` | **MODIFIED** | Add `vc_pool_trades` relation |

**New enums:** 7 (`PoolStatus`, `PaymentMethod`, `SeatReservationStatus`, `PaymentSubmissionStatus`, `ExitRequestStatus`, `PoolPayoutStatus`, `PayoutType`)

**Removed from v1:** `vc_pool_used_transactions` table (Stripe has built-in uniqueness via `payment_intent_id`; Binance is manually reviewed by admin)

---

## 6. Environment Variables

No new Stripe env vars needed — each admin's Stripe keys are stored encrypted in the `admins` table.
No new Binance env vars needed — admin's Binance API keys for trading are also in the `admins` table.

The existing `ENCRYPTION_KEY` env var (used by `EncryptionService`) is the only requirement. It encrypts all admin secrets (Stripe + Binance).

---

## 7. Implementation Order

1. Add **7 new enums** (Section 3) after `PaymentStatus`
2. Add **`admins`** + **`admin_sessions`** models (Section 4.1, 4.2)
3. Add **7 VC Pool models** (Section 4.3–4.9) after `payment_history`, before `enum KycStatus`
4. Add **`users`** changes (Section 2.1): `stripe_connect_account_id` + 3 pool relations
5. Add **`strategies`** relation (Section 2.2): `vc_pool_trades`

Then run:

```bash
cd q_nest
npm install stripe
npx prisma migrate dev --name add_admin_and_vc_pool_tables
npx prisma generate
```

---

## 8. After Migration

### Insert first admin

```sql
INSERT INTO admins (admin_id, email, password_hash, full_name)
VALUES (
  gen_random_uuid(),
  'admin@quantiva.io',
  '$2b$10$...hashed_password...',
  'Quantiva Admin'
);
```

### Verify

```bash
npx prisma studio
```

---

## 9. Payout & Refund Method Logic

### How payout method is determined

```
member.payment_method = 'stripe'
  → refund ≤ original amount  → Stripe Refund API (refunds to original payment method)
  → payout > original amount  → Stripe Refund (original) + Stripe Connect Transfer (profit)
  → requires: user.stripe_connect_account_id is set

member.payment_method = 'binance'
  → admin manually transfers on Binance
  → marks as paid in dashboard with Binance TxID
```

### Payout formulas (unchanged from v1)

**Pool Completion** (`payout_type = completion`):
```
share_percent      = invested_amount / total_invested_usdt
gross_payout       = share_percent × pool_final_value
profit             = max(0, gross_payout - invested_amount)
admin_fee_deducted = admin_profit_fee_percent × profit
net_payout         = gross_payout - admin_fee_deducted
profit_loss        = net_payout - invested_amount
```

**Pool Cancelled by Admin** (`payout_type = pool_cancelled`):
```
gross_payout       = invested_amount  (full refund, no fee)
admin_fee_deducted = 0
net_payout         = invested_amount
profit_loss        = 0
```

**User Exit — Pool Not Yet Started**:
```
member_value_at_exit = invested_amount
fee_amount           = cancellation_fee_pct × invested_amount
refund_amount        = invested_amount - fee_amount
```

**User Exit — Pool Active (Trading)**:
```
share_percent_at_exit = invested_amount / total_invested_usdt
member_value_at_exit  = share_percent_at_exit × current_pool_value_usdt
fee_amount            = cancellation_fee_pct × member_value_at_exit
refund_amount         = member_value_at_exit - fee_amount
```

---

*VC Pool Final Prisma Changes v2.1 — Dual payment (Stripe per-admin + Binance manual), single source of truth.*
