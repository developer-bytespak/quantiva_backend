# VC Pool — Phase 1: Complete Module (No Payment Gateway)

**Full working VC Pool module. Payments are manual (screenshot + admin approval).**
**Stripe is bypassed. Binance trading is manual entry. Payouts are admin-marked.**
**Schema reference:** `VC_pool_FINAL_prisma_changes.md` (install FULL schema now — no migration needed for Phase 2)

---

## What Phase 1 Delivers

| Feature | Phase 1 Behavior |
|---|---|
| Admin auth | Full (login, sessions, JWT, separate from users) |
| Admin settings | Binance UID + fees + payment window (Stripe keys setup skipped) |
| Pool CRUD | Full (draft → open → full → active → completed / cancelled) |
| Pool cloning | Full |
| Seat reservation + timer | Full (BullMQ scheduler for expiry) |
| **Stripe payment** | **BYPASSED** — user selects "stripe", admin manually approves (no checkout page) |
| **Binance payment** | Screenshot upload (Cloudinary) → admin reviews → approve/reject |
| Pool trading | **Manual entry** — admin types trade details (no Binance API execution) |
| Pool value calculation | From manually entered trade records |
| Cancellations | Fee calculated in DB, admin manually processes refund + marks paid |
| Payouts | Calculated in DB, admin manually marks each payout as paid |
| Access control | ELITE tier only |

---

## Sub-Phase Dependency Chain

```
┌────────────────────────────────────────────────────────┐
│ 1A  Schema + Admin Auth Foundation                     │
│     Prisma migration, admin login/sessions/settings    │
└─────────────────────┬──────────────────────────────────┘
                      │ depends on
┌─────────────────────▼──────────────────────────────────┐
│ 1B  Pool Management + User Browse                      │
│     Pool CRUD, lifecycle, clone, user pool listing      │
└─────────────────────┬──────────────────────────────────┘
                      │ depends on
┌─────────────────────▼──────────────────────────────────┐
│ 1C  Joining + Seat Reservation + Payments              │
│     Join flow, screenshot upload, admin approve/reject  │
│     Seat expiry scheduler, member creation              │
└─────────────────────┬──────────────────────────────────┘
                      │ depends on
┌─────────────────────▼──────────────────────────────────┐
│ 1D  Pool Trading + Value Tracking                      │
│     Start pool, manual trades, PnL, value scheduler    │
└─────────────────────┬──────────────────────────────────┘
                      │ depends on
┌─────────────────────▼──────────────────────────────────┐
│ 1E  Completion + Cancellations + Payouts               │
│     User exit, pool complete/cancel, payout calc,      │
│     manual mark-paid                                   │
└────────────────────────────────────────────────────────┘
```

**Each sub-phase is testable independently.** After finishing each one, you can verify it works before moving on.

---

---

# SUB-PHASE 1A — Schema + Admin Auth Foundation

**Goal:** Database is ready, admin can log in, configure settings.
**Testable after:** Admin logs in → sets Binance UID → sets fees → refreshes token → logs out.

---

## 1A.1 Prisma Schema — Install FULL Schema

Apply **all** tables, enums, and relations from `VC_pool_FINAL_prisma_changes.md` — the complete schema.
This avoids needing a migration when Phase 2 adds payment gateway integration.

```bash
cd q_nest

# 1. Apply all schema changes from VC_pool_FINAL_prisma_changes.md to prisma/schema.prisma
#    - 7 new enums (PoolStatus, PaymentMethod, SeatReservationStatus, etc.)
#    - 9 new models (admins, admin_sessions, vc_pools, etc.)
#    - 2 modified models (users, strategies)

# 2. Run migration
npx prisma migrate dev --name add_admin_and_vc_pool_tables
npx prisma generate
```

**Fields that will be NULL in Phase 1 (used in Phase 2):**
- `admins.stripe_secret_key_encrypted` — not set until Phase 2
- `admins.stripe_publishable_key` — not set until Phase 2
- `admins.stripe_webhook_secret_encrypted` — not set until Phase 2
- `admins.binance_api_key_encrypted` — not needed for manual trading (Phase 1)
- `admins.binance_api_secret_encrypted` — not needed for manual trading (Phase 1)
- `vc_pool_payment_submissions.stripe_checkout_session_id` — bypassed
- `vc_pool_payment_submissions.stripe_payment_intent_id` — bypassed
- `vc_pool_trades.binance_order_id` — no API execution in Phase 1
- `vc_pool_payouts.stripe_refund_id` / `stripe_transfer_id` — manual payouts
- `vc_pool_cancellations.stripe_refund_id` / `stripe_transfer_id` — manual refunds
- `users.stripe_connect_account_id` — not set until Phase 2

### Insert first admin (after migration)

```sql
INSERT INTO admins (admin_id, email, password_hash, full_name)
VALUES (
  gen_random_uuid(),
  'admin@quantiva.io',
  '$2b$10$...hashed_password...',
  'Quantiva Admin'
);
```

Or create a seed script that hashes the password with bcrypt.

---

## 1A.2 Admin Auth Module

Completely separate from user auth — own table, own JWT strategy, own guard.

### Files to create

```
src/modules/admin-auth/
├── admin-auth.module.ts
├── controllers/
│   └── admin-auth.controller.ts
├── services/
│   ├── admin-auth.service.ts
│   ├── admin-token.service.ts
│   └── admin-session.service.ts
├── guards/
│   └── admin-jwt-auth.guard.ts
├── strategies/
│   └── admin-jwt.strategy.ts
└── dto/
    └── admin-login.dto.ts
```

### Endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/admin/auth/login` | Email + password → JWT access + refresh tokens |
| POST | `/admin/auth/logout` | Revoke session, clear cookies |
| POST | `/admin/auth/refresh` | Verify refresh token, issue new token pair |

### Login flow

```
POST /admin/auth/login
Body: { email, password }

1. Find admin by email in admins table
2. Verify password_hash with bcrypt
3. Create admin_sessions record:
   - issued_at = NOW()
   - expires_at = NOW() + refresh_token_ttl
   - device_id, ip_address from request
4. Generate JWT tokens:
   - Access token:  { sub: admin_id, email, role: 'admin' } — short-lived (15 min)
   - Refresh token: hash stored in admin_sessions.refresh_token_hash
5. Return tokens via httpOnly cookie + response body
```

### Admin JWT Strategy

```
admin-jwt.strategy.ts:
- Extract JWT from cookie or Authorization header
- Validate: token has role === 'admin'
- Look up admin_id in admins table
- Verify session is valid and not revoked
- Attach admin object to request
```

### Admin JWT Guard

```
admin-jwt-auth.guard.ts:
- Uses AdminJwtStrategy (not the user JwtStrategy)
- Returns 401 if not admin
```

**Mirror from existing codebase:**
- `auth/strategies/jwt.strategy.ts` → adapt for admin
- `auth/services/token.service.ts` → adapt for admin tokens
- `auth/auth.module.ts` → adapt module wiring

---

## 1A.3 Admin Settings

| Method | Path | Description |
|---|---|---|
| PUT | `/admin/settings/binance` | Set Binance UID (no API keys in Phase 1) |
| PUT | `/admin/settings/fees` | Set default fee percentages + payment window |
| PUT | `/admin/settings/stripe` | **Stub** — returns "Coming in Phase 2" |
| GET | `/admin/settings` | Get current admin settings |

### Binance Settings (Phase 1)

```
PUT /admin/settings/binance
Body: { binance_uid }

1. Validate binance_uid is not empty
2. Update admins.binance_uid
3. Return updated settings

Phase 1: Only binance_uid. API keys added in Phase 2.
```

### Fee Settings

```
PUT /admin/settings/fees
Body: {
  default_pool_fee_percent,            // e.g., 5.00
  default_admin_profit_fee_percent,    // e.g., 20.00
  default_cancellation_fee_percent,    // e.g., 5.00
  default_payment_window_minutes       // e.g., 30
}

1. Validate all values are positive, percentages ≤ 100
2. Update admins record
3. Return updated settings

These defaults are copied into new pools at creation time.
```

---

## 1A — What you can test after completion

```
✅ Database has all VC Pool tables (verify with prisma studio)
✅ POST /admin/auth/login → returns JWT tokens
✅ GET /admin/settings → returns admin info (using admin JWT)
✅ PUT /admin/settings/binance → stores binance_uid
✅ PUT /admin/settings/fees → updates default fees
✅ POST /admin/auth/refresh → new token pair
✅ POST /admin/auth/logout → session revoked
✅ Non-admin requests to /admin/* → 401
```

---

---

# SUB-PHASE 1B — Pool Management + User Browse

**Goal:** Admin can create, edit, publish, and clone pools. Users can browse open pools.
**Depends on:** 1A (admin auth + tables)
**Testable after:** Admin creates a pool → publishes it → user sees it in available pools.

---

## 1B.1 Pool CRUD (Admin)

### Files to create

```
src/modules/vc-pool/
├── vc-pool.module.ts
├── controllers/
│   └── admin-pool.controller.ts
├── services/
│   └── pool-management.service.ts
├── guards/
│   └── elite-tier.guard.ts
└── dto/
    ├── create-pool.dto.ts
    └── update-pool.dto.ts
```

### Endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/admin/pools` | Create pool (draft) |
| GET | `/admin/pools` | List all admin's pools (with status filters) |
| GET | `/admin/pools/:id` | Pool details + member count + counters |
| PUT | `/admin/pools/:id` | Edit pool (draft only) |
| PUT | `/admin/pools/:id/publish` | Draft → Open |
| POST | `/admin/pools/:id/clone` | Clone pool as new draft |

### Create Pool (Draft)

```
POST /admin/pools
Body: {
  name,                        // required
  description,                 // optional
  coin_type,                   // default "USDT"
  contribution_amount,         // required (e.g., 100)
  max_members,                 // required (e.g., 5)
  duration_days,               // required (e.g., 30)
  pool_fee_percent,            // optional — copies from admin default
  admin_profit_fee_percent,    // optional — copies from admin default
  cancellation_fee_percent,    // optional — copies from admin default
  payment_window_minutes       // optional — copies from admin default
}

1. Validate required fields
2. Copy fee defaults from admin record for any not provided
3. Create vc_pools record:
   - admin_id = current admin
   - status = 'draft'
   - started_at = NULL, end_date = NULL
   - All counters = 0, all aggregates = NULL
4. Return pool details
```

### Edit Pool

```
PUT /admin/pools/:id
Body: { any editable field }

1. Validate pool.admin_id === current admin
2. Validate pool.status === 'draft' (can't edit after publishing)
3. Update allowed fields
4. Return updated pool
```

### Publish Pool

```
PUT /admin/pools/:id/publish

1. Validate pool.status === 'draft'
2. Validate all required fields are set:
   - name, contribution_amount, max_members, duration_days, all fees
3. Validate admin has binance_uid configured
4. Skip Stripe keys validation (Phase 1)
5. pool.status = 'open'
6. Return updated pool
```

### Clone Pool

```
POST /admin/pools/:id/clone

1. Validate source pool belongs to current admin
2. Copy: name + " (Copy)", description, coin_type, contribution_amount,
   max_members, all fees, payment_window_minutes, duration_days
3. Set: is_replica = true, original_pool_id = source pool_id
4. Set: status = 'draft', all counters = 0
5. Return new pool for editing
```

### List Pools

```
GET /admin/pools?status=open&page=1&limit=20

Returns admin's pools with:
- Pool info (name, status, dates)
- Member counts (verified / max)
- Reserved seat count
- Financial summary (if active/completed)
```

---

## 1B.2 User Browse Pools

### Files to create/extend

```
src/modules/vc-pool/
├── controllers/
│   └── user-pool.controller.ts    # Create (add browse endpoints)
```

### Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/vc-pools/available` | List open pools for ELITE users |
| GET | `/api/vc-pools/:id` | Pool details (public info) |

### Browse Available Pools

```
GET /api/vc-pools/available

1. Verify user.current_tier === 'ELITE' (EliteTierGuard)
2. Query vc_pools WHERE status = 'open' AND is_archived = false
3. Return for each pool:
   - name, description, coin_type
   - contribution_amount, pool_fee_percent
   - max_members, available_seats (max - reserved - verified)
   - duration_days
   - admin.binance_uid (shown if user picks Binance later)
   - created_at
```

### Elite Tier Guard

```
elite-tier.guard.ts:
- Checks user.current_tier === 'ELITE'
- Returns 403 "Only ELITE tier users can access VC Pool"
- Applied to all user-facing VC Pool endpoints
```

---

## 1B — What you can test after completion

```
✅ POST /admin/pools → creates draft pool
✅ PUT /admin/pools/:id → edits draft pool
✅ PUT /admin/pools/:id/publish → draft → open
✅ POST /admin/pools/:id/clone → creates copy as draft
✅ GET /admin/pools → lists admin's pools with filters
✅ GET /admin/pools/:id → pool details
✅ GET /api/vc-pools/available → ELITE user sees open pools
✅ GET /api/vc-pools/:id → user sees pool details
✅ Non-ELITE user → 403 on /api/vc-pools/*
✅ Publishing without binance_uid → validation error
```

---

---

# SUB-PHASE 1C — Joining + Seat Reservation + Payments

**Goal:** Users can join pools, upload screenshots, admin can approve/reject, members are created.
**Depends on:** 1B (pools must exist and be open)
**Testable after:** User joins → uploads screenshot → admin approves → user is pool member → pool becomes full.

---

## 1C.1 Seat Reservation + Join Flow

### Files to create/extend

```
src/modules/vc-pool/
├── services/
│   ├── seat-reservation.service.ts       # Reserve, release, expire logic
│   └── payment-submission.service.ts     # Create submissions, handle both methods
├── controllers/
│   └── user-pool.controller.ts           # Add join endpoint
└── dto/
    └── join-pool.dto.ts
```

### Endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/api/vc-pools/:id/join` | Reserve seat + select payment method |
| GET | `/api/vc-pools/:id/payment-status` | Check reservation + payment status |

### Join Pool

```
POST /api/vc-pools/:pool_id/join
Body: { payment_method: 'stripe' | 'binance', user_binance_uid?: string }

Step 1 — Validate eligibility:
  - user.current_tier === 'ELITE'
  - KYC approved
  - No active membership for this pool
  - No active reservation for this pool
  - Pool status === 'open'

Step 2 — Check seat availability:
  available = max_members - reserved_seats_count - verified_members_count
  IF available <= 0 → 409 "No seats available"

Step 3 — Reserve seat (atomic transaction):
  - Create vc_pool_seat_reservations:
    payment_method, reserved_at = NOW()
    expires_at = NOW() + pool.payment_window_minutes
    status = 'reserved'
  - pool.reserved_seats_count += 1

Step 4 — Calculate payment:
  investment_amount = pool.contribution_amount
  pool_fee_amount = investment × pool.pool_fee_percent / 100
  total_amount = investment + pool_fee

Step 5 — Create payment submission + branch:

IF 'binance':
  - Create vc_pool_payment_submissions:
    payment_method = 'binance', status = 'pending'
    payment_deadline = reservation.expires_at
  - Return:
    {
      reservation_id, total_amount, coin: pool.coin_type,
      admin_binance_uid: admin.binance_uid,
      deadline: expires_at, minutes_remaining,
      instructions: [
        "1. Open Binance → Transfer → Internal Transfer",
        "2. Enter recipient UID: {admin_binance_uid}",
        "3. Send exactly {total_amount} {coin}",
        "4. Take screenshot of completed transfer",
        "5. Upload screenshot before timer expires"
      ]
    }

IF 'stripe':
  - Create vc_pool_payment_submissions:
    payment_method = 'stripe', status = 'processing'  ← BYPASSED
    payment_deadline = reservation.expires_at
  - Return:
    {
      reservation_id, total_amount,
      message: "Join request submitted. Awaiting admin approval.",
      deadline: expires_at, minutes_remaining
    }
```

### Payment Status

```
GET /api/vc-pools/:pool_id/payment-status

Returns:
  - reservation: { status, expires_at, minutes_remaining }
  - payment: { method, status, screenshot_url? }
  - membership: { exists, joined_at? } (if already a member)
```

---

## 1C.2 Screenshot Upload (Binance)

### Files to create/extend

```
src/modules/vc-pool/
├── services/
│   └── screenshot-upload.service.ts     # Cloudinary upload
├── controllers/
│   └── user-pool.controller.ts          # Add upload endpoint
└── dto/
    └── upload-screenshot.dto.ts
```

### Endpoint

| Method | Path | Description |
|---|---|---|
| POST | `/api/vc-pools/:id/upload-screenshot` | Upload Binance payment screenshot |

### Upload Screenshot

```
POST /api/vc-pools/:pool_id/upload-screenshot
Body: multipart/form-data { reservation_id, screenshot (file) }

1. Validate reservation exists, belongs to user, status = 'reserved'
2. Validate NOT expired (NOW() < expires_at)
3. Validate payment_method === 'binance'
4. Upload screenshot to Cloudinary via CloudinaryService
5. Update payment_submission:
   - screenshot_url = Cloudinary secure URL
   - status = 'processing' (awaiting admin review)
6. Return: { message: "Screenshot uploaded. Awaiting admin approval." }
```

---

## 1C.3 Admin Payment Review (Approve / Reject)

### Files to create/extend

```
src/modules/vc-pool/
├── controllers/
│   └── admin-pool-payments.controller.ts    # Payment review endpoints
```

### Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/admin/pools/:id/payments` | List payment submissions (filterable by status, method) |
| GET | `/admin/pools/:id/reservations` | List seat reservations |
| GET | `/admin/pools/:id/members` | List pool members |
| PUT | `/admin/pools/:id/payments/:sid/approve` | Approve payment → create member |
| PUT | `/admin/pools/:id/payments/:sid/reject` | Reject payment → release seat |

### Approve Payment

```
PUT /admin/pools/:pool_id/payments/:submission_id/approve
Body: { admin_notes? }

In a single DB transaction:
  1. Validate submission.status === 'processing'
  2. submission.status = 'verified'
  3. submission.verified_at = NOW()
  4. submission.reviewed_by_admin_id = current admin
  5. reservation.status = 'confirmed'
  6. Create vc_pool_members:
     - payment_method = submission.payment_method
     - invested_amount_usdt = submission.investment_amount
     - share_percent = will be recalculated when pool starts
     - user_binance_uid = from join request (if Binance)
     - is_active = true
  7. pool.verified_members_count += 1
  8. pool.reserved_seats_count -= 1
  9. IF verified_members_count === max_members:
       pool.status = 'full'
```

### Reject Payment

```
PUT /admin/pools/:pool_id/payments/:submission_id/reject
Body: { rejection_reason }

1. Validate submission.status === 'processing'
2. submission.status = 'rejected'
3. submission.rejection_reason = reason
4. submission.reviewed_by_admin_id = current admin
5. reservation.status = 'released'
6. pool.reserved_seats_count -= 1
```

---

## 1C.4 Seat Expiry Scheduler (BullMQ)

### Files to create

```
src/modules/vc-pool/
├── schedulers/
│   └── seat-expiry.scheduler.ts     # BullMQ repeatable job
```

### Scheduler

```
Job: 'vc-pool-seat-expiry'
Interval: every 30 seconds
Queue: reuse existing Redis + BullMQ setup

EVERY 30 SECONDS:
  1. Find: vc_pool_seat_reservations
     WHERE status = 'reserved' AND expires_at < NOW()
  2. For each expired reservation:
     a. reservation.status = 'expired'
     b. pool.reserved_seats_count -= 1
     c. IF related submission exists AND status IN ('pending', 'processing'):
          submission.status = 'expired'
```

---

## 1C — What you can test after completion

```
✅ POST /api/vc-pools/:id/join (Binance) → seat reserved, instructions returned
✅ POST /api/vc-pools/:id/join (Stripe) → seat reserved, bypass message returned
✅ POST /api/vc-pools/:id/upload-screenshot → screenshot on Cloudinary
✅ GET /api/vc-pools/:id/payment-status → reservation + submission status
✅ GET /admin/pools/:id/payments → admin sees pending submissions
✅ PUT .../approve → member created, seat confirmed
✅ PUT .../reject → seat released, user can try again
✅ Pool fills up → status auto-changes to 'full'
✅ Seat timer expires → scheduler releases seat + expires submission
✅ Duplicate join attempt → 409
✅ Non-ELITE user → 403
✅ Full pool → 409 "No seats available"
```

---

---

# SUB-PHASE 1D — Pool Trading + Value Tracking

**Goal:** Admin can start a full pool, manually record trades, and pool value updates automatically.
**Depends on:** 1C (pool must be full with verified members)
**Testable after:** Admin starts pool → records trade → closes trade → PnL calculated → pool value updated.

---

## 1D.1 Start Pool (Full → Active)

### Extend

```
admin-pool.controller.ts      # Add start endpoint
pool-management.service.ts    # Add start logic
```

### Endpoint

| Method | Path | Description |
|---|---|---|
| PUT | `/admin/pools/:id/start` | Full → Active (sets dates, calculates shares) |

### Start Pool

```
PUT /admin/pools/:pool_id/start

1. Validate pool.status === 'full'
2. Validate verified_members_count === max_members
3. Set:
   - pool.status = 'active'
   - pool.started_at = NOW()
   - pool.end_date = NOW() + duration_days
   - pool.total_invested_usdt = SUM(members.invested_amount_usdt)
   - pool.current_pool_value_usdt = total_invested_usdt
4. Calculate share_percent for all members:
   share_percent = invested_amount / total_invested × 100
   (With fixed contribution, all shares are equal: 100 / max_members)
5. Return updated pool
```

---

## 1D.2 Manual Trade Entry

### Files to create

```
src/modules/vc-pool/
├── controllers/
│   └── admin-pool-trades.controller.ts    # Trade endpoints
├── services/
│   └── pool-trading.service.ts            # Trade CRUD + PnL
└── dto/
    ├── manual-trade.dto.ts
    └── close-trade.dto.ts
```

### Endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/admin/pools/:id/trades` | Record a new trade (manual entry) |
| GET | `/admin/pools/:id/trades` | List pool trades (open, closed, all) |
| PUT | `/admin/pools/:id/trades/:tid/close` | Close trade with exit price |

### Open Trade

```
POST /admin/pools/:pool_id/trades
Body: {
  asset_pair,          // e.g., "BTCUSDT"
  action,              // BUY or SELL
  quantity,            // e.g., 0.005
  entry_price_usdt,    // admin types the fill price
  strategy_id?,        // optional strategy tag
  notes?
}

1. Validate pool.status === 'active'
2. Validate pool.admin_id === current admin
3. Create vc_pool_trades:
   - is_open = true
   - traded_at = NOW()
   - binance_order_id = NULL (no API — Phase 1)
4. Return trade details
```

### Close Trade

```
PUT /admin/pools/:pool_id/trades/:trade_id/close
Body: { exit_price_usdt }

1. Validate trade.is_open === true
2. Calculate PnL:
   IF action === BUY:  pnl = (exit_price - entry_price) × quantity
   IF action === SELL: pnl = (entry_price - exit_price) × quantity
3. Update trade:
   - exit_price_usdt = provided
   - pnl_usdt = calculated
   - is_open = false
   - closed_at = NOW()
4. Recalculate pool.current_pool_value_usdt
5. Return updated trade
```

---

## 1D.3 Pool Value Calculation + Scheduler

### Files to create

```
src/modules/vc-pool/
├── services/
│   └── pool-value.service.ts              # Value calculation logic
├── schedulers/
│   └── pool-value-update.scheduler.ts     # BullMQ repeatable job
```

### Value Calculation

```
pool-value.service.ts:

calculatePoolValue(pool_id):
  1. Get total_invested_usdt from pool
  2. Sum closed trades: SUM(pnl_usdt) WHERE is_open = false
  3. For open trades:
     - Fetch current price via BinanceService.getPrice(asset_pair)
     - unrealized_pnl = (current_price - entry_price) × quantity (direction-adjusted)
  4. current_pool_value = total_invested + closed_pnl + unrealized_pnl
  5. total_profit = current_pool_value - total_invested
  6. Update pool: current_pool_value_usdt, total_profit_usdt
```

### Scheduler

```
Job: 'vc-pool-value-update'
Interval: every 60 seconds
Queue: reuse existing Redis + BullMQ setup

EVERY 60 SECONDS:
  1. Find all pools WHERE status = 'active'
  2. For each: call calculatePoolValue(pool_id)
```

---

## 1D — What you can test after completion

```
✅ PUT /admin/pools/:id/start → pool active, dates set, shares calculated
✅ Start with status !== 'full' → 400
✅ POST .../trades → trade recorded with entry price
✅ GET .../trades → list trades (open, closed)
✅ PUT .../trades/:tid/close → PnL calculated, pool value updated
✅ Pool value scheduler runs → updates current_pool_value_usdt every 60s
✅ Open trade + price change → unrealized PnL reflected in pool value
```

---

---

# SUB-PHASE 1E — Completion + Cancellations + Payouts

**Goal:** Full pool lifecycle — users can exit, admin can complete/cancel pools, payouts are tracked.
**Depends on:** 1D (pool must be active with trades)
**Testable after:** User exits active pool → admin approves → refund tracked. Admin completes pool → payouts calculated → mark paid.

---

## 1E.1 User Cancellation Requests

### Files to create/extend

```
src/modules/vc-pool/
├── services/
│   └── pool-cancellation.service.ts     # Exit requests + fee calc
├── controllers/
│   └── user-pool.controller.ts          # Add cancel endpoint
├── guards/
│   └── pool-member.guard.ts             # Verify user is active member
```

### User Endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/api/vc-pools/:id/cancel-membership` | Request to exit pool |
| GET | `/api/vc-pools/:id/my-cancellation` | Check cancellation status |
| GET | `/api/vc-pools/my-pools` | List my pool memberships + stats |

### Request Cancellation

```
POST /api/vc-pools/:pool_id/cancel-membership

1. Validate: user is active member, no pending cancellation
2. Capture snapshot:
   - pool_status_at_request = pool.status

   IF pool NOT started (status = 'open' or 'full'):
     - member_value_at_exit = invested_amount
     - fee_amount = cancellation_fee_percent × invested_amount / 100
     - refund_amount = invested_amount - fee_amount

   IF pool active (trading):
     - share_percent_at_exit = member.share_percent
     - pool_value_at_exit = pool.current_pool_value_usdt
     - member_value_at_exit = share_percent × pool_value / 100
     - fee_amount = cancellation_fee_percent × member_value / 100
     - refund_amount = member_value - fee_amount

3. Create vc_pool_cancellations:
   - status = 'pending'
   - All calculated fields stored
4. Return: estimated refund details + "Awaiting admin approval"
```

### My Pools

```
GET /api/vc-pools/my-pools

For each membership:
  - Pool info: name, status, dates, coin_type
  - My details: invested_amount, share_percent, payment_method
  - Pool performance: current_pool_value, total_profit
  - My current value: share_percent × current_pool_value / 100
  - My PnL: current_value - invested_amount
  - Cancellation status (if any)
```

---

## 1E.2 Admin Review Cancellations

### Extend

```
admin-pool.controller.ts or create admin-pool-cancellations.controller.ts
```

### Admin Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/admin/pools/:id/cancellations` | List cancellation requests |
| PUT | `/admin/pools/:id/cancellations/:cid/approve` | Approve exit |
| PUT | `/admin/pools/:id/cancellations/:cid/reject` | Reject exit |
| PUT | `/admin/pools/:id/cancellations/:cid/mark-refunded` | Mark refund as done |

### Approve Cancellation

```
PUT /admin/pools/:pool_id/cancellations/:cid/approve

1. Validate cancellation.status === 'pending'
2. Recalculate fee/refund at current pool value (may have changed since request):
   IF pool active: recalc member_value from current pool value
   IF pool not started: member_value = invested_amount
3. cancellation.status = 'approved'
4. cancellation.reviewed_by_admin_id = current admin
5. cancellation.reviewed_at = NOW()
6. Return: { refund_amount, message: "Transfer refund externally, then mark as refunded." }
```

### Mark Refunded

```
PUT /admin/pools/:pool_id/cancellations/:cid/mark-refunded
Body: { binance_tx_id?, notes? }

1. Validate cancellation.status === 'approved'
2. cancellation.status = 'processed'
3. cancellation.refunded_at = NOW()
4. cancellation.binance_refund_tx_id = provided (if Binance)
5. member.is_active = false
6. member.exited_at = NOW()
7. pool.verified_members_count -= 1
8. Recalculate remaining members' share_percent
```

### Reject Cancellation

```
PUT /admin/pools/:pool_id/cancellations/:cid/reject
Body: { rejection_reason }

1. cancellation.status = 'rejected'
2. cancellation.rejection_reason = reason
3. Member stays active — no changes
```

---

## 1E.3 Pool Completion + Payout Calculation

### Files to create/extend

```
src/modules/vc-pool/
├── services/
│   └── pool-payout.service.ts     # Payout calculation + mark-paid
```

### Admin Endpoints

| Method | Path | Description |
|---|---|---|
| PUT | `/admin/pools/:id/complete` | Active → Completed (calculates payouts) |
| GET | `/admin/pools/:id/payouts` | List payout records |
| PUT | `/admin/pools/:id/payouts/:pid/mark-paid` | Mark payout as done |

### Complete Pool

```
PUT /admin/pools/:pool_id/complete

1. Validate pool.status === 'active'
2. Validate NO open trades (admin must close all trades first)
   IF open trades exist → 400 "Close all open trades before completing"
3. Calculate final pool value (from closed trade PnLs)
4. For EACH active member, create vc_pool_payouts:
   - payout_type = 'completion'
   - share_percent = member.share_percent
   - pool_final_value = pool.current_pool_value_usdt
   - gross_payout = share_percent × pool_final_value / 100
   - profit = max(0, gross_payout - initial_investment)
   - admin_fee_deducted = admin_profit_fee_percent × profit / 100
   - net_payout = gross_payout - admin_fee_deducted
   - profit_loss = net_payout - initial_investment
   - status = 'pending'
5. Update pool:
   - status = 'completed'
   - completed_at = NOW()
   - total_profit_usdt = pool_final_value - total_invested_usdt
   - admin_fee_earned_usdt = SUM(admin_fee_deducted)
   - total_pool_fees_usdt = SUM(pool_fee_amount from payment submissions)
```

### Mark Payout as Paid

```
PUT /admin/pools/:pool_id/payouts/:payout_id/mark-paid
Body: { binance_tx_id?, notes? }

1. Validate payout.status === 'pending'
2. payout.status = 'completed'
3. payout.paid_at = NOW()
4. payout.binance_tx_id = provided
5. payout.notes = provided
```

---

## 1E.4 Cancel Pool (Admin)

### Admin Endpoints

| Method | Path | Description |
|---|---|---|
| PUT | `/admin/pools/:id/cancel` | Open/Full → Cancelled (full refund) |

### Cancel Pool

```
PUT /admin/pools/:pool_id/cancel

1. Validate pool.status IN ('open', 'full')
2. For EACH active member, create vc_pool_payouts:
   - payout_type = 'pool_cancelled'
   - net_payout = invested_amount (full refund, NO fee)
   - admin_fee_deducted = 0
   - profit_loss = 0
   - status = 'pending'
3. Release all RESERVED seat reservations:
   - reservation.status = 'released'
4. Expire all PENDING/PROCESSING payment submissions:
   - submission.status = 'expired'
5. pool.status = 'cancelled'
6. pool.cancelled_at = NOW()
7. pool.reserved_seats_count = 0

Admin then manually transfers refunds and marks each as paid.
```

---

## 1E — What you can test after completion

```
✅ POST /api/vc-pools/:id/cancel-membership → cancellation request created
✅ GET /api/vc-pools/:id/my-cancellation → status check
✅ GET /api/vc-pools/my-pools → memberships + current value + PnL
✅ PUT .../cancellations/:cid/approve → approved, refund amount shown
✅ PUT .../cancellations/:cid/mark-refunded → member deactivated, shares recalculated
✅ PUT .../cancellations/:cid/reject → member stays active

✅ PUT /admin/pools/:id/complete → payouts calculated for all members
✅ Complete with open trades → 400 error
✅ GET .../payouts → list payout records with amounts
✅ PUT .../payouts/:pid/mark-paid → payout completed

✅ PUT /admin/pools/:id/cancel → full refund records, no fee
✅ All reserved seats released, pending submissions expired

✅ Full end-to-end walkthrough works (see Section 8)
```

---

---

## 7. Full Phase 1 Module Structure (All Sub-Phases Combined)

```
src/modules/
├── admin-auth/                              # Sub-Phase 1A
│   ├── admin-auth.module.ts
│   ├── controllers/
│   │   └── admin-auth.controller.ts
│   ├── services/
│   │   ├── admin-auth.service.ts
│   │   ├── admin-token.service.ts
│   │   └── admin-session.service.ts
│   ├── guards/
│   │   └── admin-jwt-auth.guard.ts
│   ├── strategies/
│   │   └── admin-jwt.strategy.ts
│   └── dto/
│       └── admin-login.dto.ts
│
├── vc-pool/                                 # Sub-Phases 1B–1E
│   ├── vc-pool.module.ts
│   ├── controllers/
│   │   ├── admin-pool.controller.ts         # 1B: CRUD + 1D: start + 1E: complete/cancel
│   │   ├── admin-pool-payments.controller.ts# 1C: approve/reject
│   │   ├── admin-pool-trades.controller.ts  # 1D: manual trades
│   │   └── user-pool.controller.ts          # 1B: browse + 1C: join/upload + 1E: cancel/my-pools
│   ├── services/
│   │   ├── pool-management.service.ts       # 1B: CRUD, lifecycle
│   │   ├── seat-reservation.service.ts      # 1C: reserve, release, expire
│   │   ├── payment-submission.service.ts    # 1C: create, status tracking
│   │   ├── screenshot-upload.service.ts     # 1C: Cloudinary upload
│   │   ├── pool-trading.service.ts          # 1D: manual trade CRUD + PnL
│   │   ├── pool-value.service.ts            # 1D: value calculation
│   │   ├── pool-cancellation.service.ts     # 1E: exit requests + fee calc
│   │   └── pool-payout.service.ts           # 1E: payout calculation + mark-paid
│   ├── schedulers/
│   │   ├── seat-expiry.scheduler.ts         # 1C: BullMQ repeatable job
│   │   └── pool-value-update.scheduler.ts   # 1D: BullMQ repeatable job
│   ├── guards/
│   │   ├── elite-tier.guard.ts              # 1B: ELITE access check
│   │   └── pool-member.guard.ts             # 1E: verify active member
│   └── dto/
│       ├── create-pool.dto.ts               # 1B
│       ├── update-pool.dto.ts               # 1B
│       ├── join-pool.dto.ts                 # 1C
│       ├── upload-screenshot.dto.ts         # 1C
│       ├── manual-trade.dto.ts              # 1D
│       └── close-trade.dto.ts               # 1D
```

---

## 8. Full Phase 1 Walkthrough (End-to-End)

```
SUB-PHASE 1A:
  1. Admin logs in at /admin/auth/login
  2. Admin sets Binance UID + fees in settings

SUB-PHASE 1B:
  3. Admin creates pool "BTC Alpha" (100 USDT, max 3, 30-day, 5% pool fee)
  4. Admin publishes pool → status: open

SUB-PHASE 1C:
  5. User A (ELITE) clicks "Join Pool" → selects Binance
     → Seat reserved (30 min timer)
     → Shown: "Transfer 105 USDT to Binance UID: 12345678"
     → User transfers on Binance, takes screenshot
     → Uploads screenshot → status: 'processing'
     → Admin sees screenshot, clicks Approve
     → User A is pool member ✓

  6. User B clicks "Join Pool" → selects Stripe
     → Seat reserved (30 min timer)
     → "Join request submitted. Awaiting admin approval."
     → Admin confirms external payment, clicks Approve
     → User B is pool member ✓

  7. User C joins (same flow) → pool is FULL (3/3)

SUB-PHASE 1D:
  8. Admin starts pool → status: active
     → started_at = NOW(), end_date = NOW() + 30 days
     → Each member: share_percent = 33.33%

  9. Admin trades on Binance externally, records in system:
     → POST /trades { asset: "BTCUSDT", action: BUY, qty: 0.005, entry: 40000 }
     → Later: PUT /trades/:tid/close { exit_price: 44000 }
     → PnL: +20 USDT recorded
     → Pool value scheduler updates: 320 USDT → current_pool_value_usdt

SUB-PHASE 1E:
  10. (Optional) User C requests cancellation while pool active:
      → member_value = 33.33% × 320 = 106.67
      → fee = 5% × 106.67 = 5.33
      → estimated refund = 101.33
      → Admin approves → admin transfers externally → marks refunded
      → User C removed, remaining shares recalculated to 50% each

  11. After 30 days, admin completes pool:
      → All trades closed (admin enters exit prices)
      → Payouts calculated for remaining members
      → Payout records created (status: pending)

  12. Admin transfers money to each member externally
      → PUT /payouts/:pid/mark-paid { notes: "Binance transfer done" }
      → Payout status: completed ✓

  13. Pool status: completed ✓
```

---

## 9. Sub-Phase Summary

| Sub-Phase | Scope | Endpoints | Key Deliverable |
|---|---|---|---|
| **1A** | Schema + Admin Auth + Settings | 6 | Admin can log in and configure |
| **1B** | Pool CRUD + User Browse | 8 | Pools can be created and browsed |
| **1C** | Join + Seat + Payments + Scheduler | 9 | Users can join, admin can approve members |
| **1D** | Start + Trading + Value Scheduler | 4 | Pool trading works, value tracks |
| **1E** | Cancel + Complete + Payouts | 10 | Full lifecycle with payouts |
| **Total** | | **37** | Complete working module |

---

*VC Pool Phase 1 — 5 sub-phases, each independently testable. Schema is future-proof for Phase 2.*
