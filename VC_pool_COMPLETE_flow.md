# VC Pool — Complete System Flow (v2)

**Admin + User flows, dual payment system (Stripe + Binance manual), automated processes.**
**DB schema reference:** `VC_pool_FINAL_prisma_changes.md` (v2)

---

## 1. System Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                         QUANTIVA VC POOL                             │
├───────────────────┬──────────────────────────────────────────────────┤
│   ADMIN PANEL     │                USER APP                          │
│  /admin/auth/*    │             /api/vc-pools/*                      │
│  /admin/pools/*   │                                                  │
│  /admin/trades/*  │                                                  │
├───────────────────┴──────────────────────────────────────────────────┤
│                       BACKEND (NestJS)                                │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────────┐ │
│  │ Admin Auth   │  │  VC Pool     │  │  Stripe Webhook Handler    │ │
│  │  Module      │  │  Module      │  │  (auto payment confirm)    │ │
│  └──────────────┘  └──────────────┘  └────────────────────────────┘ │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────────┐ │
│  │ Binance API  │  │  Cloudinary  │  │  Seat Expiry Scheduler     │ │
│  │  (trading)   │  │  (screenshots│  │  (BullMQ)                  │ │
│  └──────────────┘  └──────────────┘  └────────────────────────────┘ │
├──────────────────────────────────────────────────────────────────────┤
│                      PostgreSQL + Redis                               │
└───────────┬──────────────────────┬───────────────────────────────────┘
            │                      │
   ┌────────┴────────┐    ┌───────┴────────┐
   │   Binance API   │    │   Stripe API   │
   │  (pool trading) │    │  (payments +   │
   │                 │    │   Connect)     │
   └─────────────────┘    └────────────────┘
```

**Two Payment Channels:**

| Channel | Collection (User Pays) | Verification | Refunds/Payouts |
|---|---|---|---|
| **Stripe** | Stripe Checkout (redirect) | Automatic via webhook | Stripe Refund + Stripe Connect Transfer |
| **Binance** | Manual transfer to admin UID | Admin reviews screenshot | Admin manually transfers on Binance |

**Reused infrastructure from codebase:**
- Redis + BullMQ — seat expiry scheduler, pool value updater
- EncryptionService (AES-256-GCM) — admin Stripe keys + Binance API keys
- CloudinaryService — Binance payment screenshot storage
- JWT + Passport — mirrored for admin auth (separate from user auth)
- BinanceService — extended for authenticated pool trading

---

## 2. Admin Flows

### 2.1 Admin Registration & Login

Admin is completely separate from users — own table, own sessions, own JWT, different URL.

```
ADMIN REGISTRATION (seed script or super-admin endpoint):
──────────────────────────────────────────────────────────
1. Hash password with bcrypt
2. INSERT INTO admins (email, password_hash, full_name, default fees)
3. Admin record created

ADMIN LOGIN:
──────────────────────────────────────────────────────────
POST /admin/auth/login
Body: { email, password }

1. Find admin by email in admins table
2. Verify password_hash with bcrypt
3. Create admin_session record
4. Generate JWT tokens:
   - Access token:  { sub: admin_id, email, role: 'admin' }
   - Refresh token: stored as hash in admin_sessions
5. Return tokens (httpOnly cookie + response body)

ADMIN LOGOUT:
POST /admin/auth/logout → revoke session, clear cookies

ADMIN REFRESH:
POST /admin/auth/refresh → verify refresh token, issue new pair
```

**Admin JWT Guard:** Separate from user JwtAuthGuard. Checks:
- Token has `role: 'admin'`
- `admin_id` exists in `admins` table
- Session is valid and not revoked

### 2.2 Admin Binance Setup (for Trading)

Admin's Binance API keys are used for TRADING, not payment verification.
Admin's Binance UID is displayed to users so they know where to send manual transfers.

```
PUT /admin/settings/binance
Body: { binance_uid, api_key, api_secret }

1. Encrypt api_key and api_secret using EncryptionService
2. Update admins record
3. Verify connection by calling Binance API (get account info)
4. Return success/failure

Binance API Key Requirements:
  ✅ Read account info         — ENABLED
  ✅ Spot Trading              — ENABLED (for pool trades)
  ✅ Internal Transfer         — ENABLED (for Binance refunds/payouts)
  ❌ Withdraw                  — DISABLED
  ❌ Futures / Margin          — DISABLED
  IP Restriction: Backend server IP only
```

### 2.3 Admin Stripe Setup (for Payments)

Each admin has their own Stripe account. Keys are encrypted and stored in the `admins` table.

```
PUT /admin/settings/stripe
Body: { stripe_secret_key, stripe_publishable_key, stripe_webhook_secret }

1. Encrypt stripe_secret_key and stripe_webhook_secret using EncryptionService
2. Store stripe_publishable_key as-is (public key, safe to expose)
3. Update admins record
4. Verify connection by calling Stripe API (list recent charges or account info)
5. Return success/failure + webhook URL to configure in Stripe dashboard

Response includes:
{
  status: "connected",
  webhook_url: "https://your-domain.com/webhooks/stripe/{admin_id}"
}

Admin must configure this webhook URL in their Stripe Dashboard:
  Stripe Dashboard → Developers → Webhooks → Add endpoint
  URL: https://your-domain.com/webhooks/stripe/{admin_id}
  Events: checkout.session.completed, checkout.session.expired, charge.refunded
```

### 2.4 Admin Default Fee Configuration

```
PUT /admin/settings/fees
Body: {
  default_pool_fee_percent,          // upfront joining fee (e.g., 5%)
  default_admin_profit_fee_percent,  // admin cut of profits (e.g., 20%)
  default_cancellation_fee_percent,  // exit fee (e.g., 5%)
  default_payment_window_minutes     // timer for Stripe checkout / screenshot upload (e.g., 30)
}

1. Validate all values
2. Update admins record
3. New pools will use these defaults (existing pools unaffected)
```

### 2.5 Pool Creation (Draft)

```
POST /admin/pools
Body: {
  name, description, coin_type,
  contribution_amount, max_members, duration_days,
  pool_fee_percent,              // optional, defaults from admin
  admin_profit_fee_percent,      // optional
  cancellation_fee_percent,      // optional
  payment_window_minutes         // optional
}

1. Validate admin has Binance UID configured
2. Copy fee defaults from admin if not provided
3. Create vc_pools record:
   - status = draft
   - started_at = NULL, end_date = NULL
   - All counters = 0
4. Return pool details

Pool is invisible to users in draft status. Admin can edit all fields.
Both payment methods (Stripe + Binance) are always available.
```

### 2.6 Publish Pool (Draft → Open)

```
PUT /admin/pools/:pool_id/publish

1. Validate pool.status === 'draft'
2. Validate all required fields set
3. Validate admin has Binance UID configured (for Binance manual transfers)
4. Validate admin has Stripe keys configured (for Stripe payments)
5. pool.status = 'open'
6. Pool now visible to ELITE users
```

### 2.7 Pool Monitoring Dashboard

```
GET /admin/pools                    — All pools with status summary
GET /admin/pools/:pool_id          — Detailed view

Admin sees for each pool:
- Member list with payment method + investment amounts
- Pending seat reservations (with timer countdown)
- Payment submissions:
  ► Stripe: auto-verified ones
  ► Binance: pending screenshots awaiting review
- Active trades with PnL
- Cancellation requests pending review
- Pool value chart over time
```

### 2.8 Review Binance Payment Screenshots

Admin reviews Binance payment submissions (Stripe is auto-verified).

```
GET /admin/pools/:pool_id/payments?status=processing&payment_method=binance

For each pending Binance payment:
  Admin sees:
  - User info
  - Expected amount (total_amount)
  - Screenshot image (from Cloudinary)
  - Submission timestamp
  - Time remaining in payment window

APPROVE:
PUT /admin/pools/:pool_id/payments/:submission_id/approve
Body: { admin_notes? }

1. Validate submission.status === 'processing'
2. Validate submission.payment_method === 'binance'
3. In single DB transaction:
   a. submission.status = 'verified'
   b. submission.verified_at = NOW()
   c. submission.reviewed_by_admin_id = current admin
   d. reservation.status = 'confirmed'   ← seat confirmed immediately
   e. CREATE vc_pool_members record:
      - payment_method = 'binance'
      - invested_amount_usdt = submission.investment_amount
      - share_percent = calculated
      - user_binance_uid = provided by user (optional)
   f. pool.verified_members_count += 1
   g. IF verified_members_count === max_members:
        pool.status = 'full'

REJECT:
PUT /admin/pools/:pool_id/payments/:submission_id/reject
Body: { rejection_reason }

1. submission.status = 'rejected'
2. submission.rejection_reason = reason
3. submission.reviewed_by_admin_id = current admin
4. reservation.status = 'released'   ← seat opens back up
5. pool.reserved_seats_count -= 1
```

### 2.9 Start Pool (Full → Active)

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
   (With fixed contribution all shares are equal: 100 / max_members)
5. Pool is now active — admin can start trading
```

### 2.10 Pool Trading

Admin trades on behalf of the pool using their Binance account.
Trades recorded in `vc_pool_trades` (standalone, NOT through strategy_signals → orders).

```
POST /admin/pools/:pool_id/trades
Body: { asset_pair, action, quantity, strategy_id?, notes? }

1. Validate pool.status === 'active'
2. Decrypt admin's Binance API keys
3. Execute trade on Binance API
4. Create vc_pool_trades record:
   - entry_price_usdt = fill price from Binance
   - binance_order_id = Binance order ID
   - is_open = true
5. Discard decrypted keys from memory
6. Return trade details

CLOSE TRADE:
PUT /admin/pools/:pool_id/trades/:trade_id/close

1. Execute close order on Binance
2. Update trade:
   - exit_price_usdt = fill price
   - pnl_usdt = (exit - entry) × quantity (adjusted for BUY/SELL direction)
   - is_open = false, closed_at = NOW()
3. Update pool.current_pool_value_usdt
```

**Pool value calculation:**
```
current_pool_value = total_invested_usdt
                   + SUM(closed trades PnL)
                   + SUM(open trades unrealized PnL)
```

### 2.11 Pool Completion

```
PUT /admin/pools/:pool_id/complete

1. Validate pool.status === 'active'
2. Close ALL open trades on Binance
3. Calculate final pool value
4. For EACH active member, create vc_pool_payouts:
   - payout_type = 'completion'
   - Calculate share, gross, admin fee (on profits only), net, P&L
   - status = 'pending'
5. Update pool:
   - status = 'completed', completed_at = NOW()
   - total_profit, admin_fee_earned

PROCESS PAYOUTS:
POST /admin/pools/:pool_id/payouts/process

For each pending payout:
  IF member.payment_method === 'stripe':
    IF net_payout ≤ initial_investment:
      → Stripe Refund API (partial refund to original payment)
      → Store stripe_refund_id
    ELSE:
      → Stripe Refund (full original amount)
      → Stripe Connect Transfer (profit portion to user's Connect account)
      → Requires user.stripe_connect_account_id
      → Store stripe_refund_id + stripe_transfer_id

  IF member.payment_method === 'binance':
    → Admin manually transfers on Binance to member's Binance UID
    → Admin enters Binance TxID in dashboard
    → Store binance_tx_id

  Update payout: status = 'completed', paid_at = NOW()
```

### 2.12 Cancel Unfilled Pool

```
PUT /admin/pools/:pool_id/cancel

1. Validate pool.status IN ('open', 'full')
2. For EACH active member, create vc_pool_payouts:
   - payout_type = 'pool_cancelled'
   - net_payout = invested_amount (full refund, no fee)
3. Release all RESERVED seat reservations
4. Reject all PENDING payment submissions
5. pool.status = 'cancelled', cancelled_at = NOW()
6. Process refunds per member's payment_method:
   - Stripe: Stripe Refund API (full amount)
   - Binance: admin manually transfers back
```

### 2.13 Review User Cancellation Requests

```
GET /admin/pools/:pool_id/cancellations?status=pending

APPROVE:
PUT /admin/pools/:pool_id/cancellations/:cid/approve

1. Capture current pool value snapshot (if pool active)
2. Calculate fee and refund:
   Pre-start:  refund = invested - (cancel_fee_pct × invested)
   Active:     refund = member_value - (cancel_fee_pct × member_value)
3. Process refund per member's payment_method:
   - Stripe: Refund API + Connect Transfer if applicable
   - Binance: admin manually transfers, enters TxID
4. Update cancellation: status = 'processed'
5. Update member: is_active = false, exited_at = NOW()
6. Recalculate remaining members' share_percent
7. pool.verified_members_count -= 1

REJECT:
PUT /admin/pools/:pool_id/cancellations/:cid/reject
Body: { rejection_reason }
→ status = 'rejected', member stays active
```

### 2.14 Clone Pool

```
POST /admin/pools/:pool_id/clone

1. Copy: name, description, coin_type, contribution_amount,
   max_members, all fees, payment_window_minutes, duration_days
2. Set: is_replica = true, original_pool_id = source
3. Set: status = 'draft', all counters = 0
4. Return new pool for admin to edit and publish
```

---

## 3. User Flows

### 3.1 Browse Available Pools

```
GET /api/vc-pools/available

1. Verify user.current_tier === 'ELITE'
2. Query vc_pools WHERE status = 'open' AND is_archived = false
3. Return:
   - name, description, coin_type, contribution_amount
   - max_members, available_seats
   - pool_fee_percent
   - Payment methods available: Stripe + Binance (both always available)
   - Admin Binance UID (shown if user selects Binance method)
```

### 3.2 Join Pool — Payment Method Selection + Seat Reservation

User selects payment method (Stripe or Binance) when clicking "Join Pool".
This method is locked for the entire membership lifetime.

```
POST /api/vc-pools/:pool_id/join
Body: { payment_method: 'stripe' | 'binance', user_binance_uid?: string }

Step 1: Validate eligibility
  - user.current_tier === 'ELITE'
  - KYC approved
  - No active membership or reservation for this pool
  - Pool status === 'open'

Step 2: Check seat availability
  available = max_members - reserved_seats_count
  IF available <= 0 → "Pool is full. No seats available."

Step 3: Reserve seat (atomic)
  - Create vc_pool_seat_reservations:
    payment_method, reserved_at = NOW()
    expires_at = NOW() + pool.payment_window_minutes
    status = 'reserved'
  - pool.reserved_seats_count += 1

Step 4: Calculate payment
  investment_amount = pool.contribution_amount
  pool_fee_amount = investment × pool.pool_fee_percent / 100
  total_amount = investment + pool_fee

Step 5: Branch by payment method
```

#### 3.2a — Stripe Payment Flow

```
IF payment_method === 'stripe':

1. Decrypt admin's Stripe secret key from admins table
2. Create Stripe Checkout Session using admin's key:
   const stripe = new Stripe(decryptedAdminStripeKey)
   stripe.checkout.sessions.create({
     mode: 'payment',
     line_items: [{
       price_data: {
         currency: 'usd',
         unit_amount: total_amount × 100,  // Stripe uses cents
         product_data: { name: pool.name }
       },
       quantity: 1
     }],
     metadata: {
       pool_id, user_id, reservation_id, submission_id, admin_id
     },
     success_url: '/vc-pools/{pool_id}/payment-success',
     cancel_url: '/vc-pools/{pool_id}/payment-cancelled',
     expires_after: pool.payment_window_minutes * 60  // seconds
   })
3. Discard decrypted key from memory

2. Create vc_pool_payment_submissions:
   - payment_method = 'stripe'
   - stripe_checkout_session_id = session.id
   - status = 'pending'
   - payment_deadline = reservation.expires_at

3. Return { checkout_url: session.url }
   → User is redirected to Stripe's hosted checkout page
   → Timer is ticking (payment_window_minutes)

4. STRIPE WEBHOOK (POST /webhooks/stripe):
   Event: checkout.session.completed
   → Extract pool_id, user_id, reservation_id from metadata
   → submission.stripe_payment_intent_id = event.payment_intent
   → submission.status = 'verified'
   → submission.verified_at = NOW()
   → reservation.status = 'confirmed'
   → CREATE vc_pool_members (payment_method = 'stripe')
   → pool.verified_members_count += 1
   → IF full: pool.status = 'full'

   Event: checkout.session.expired
   → submission.status = 'expired'
   → reservation.status = 'expired'
   → pool.reserved_seats_count -= 1
```

#### 3.2b — Binance Manual Payment Flow

```
IF payment_method === 'binance':

1. Create vc_pool_payment_submissions:
   - payment_method = 'binance'
   - status = 'pending'
   - payment_deadline = reservation.expires_at

2. Return payment instructions:
   {
     reservation_id,
     total_amount: 105.00,
     coin: "USDT",
     admin_binance_uid: admin.binance_uid,
     deadline: expires_at,
     minutes_remaining: pool.payment_window_minutes,
     instructions: [
       "1. Open Binance → Transfer → Internal Transfer",
       "2. Enter recipient UID: {admin_binance_uid}",
       "3. Send exactly {total_amount} {coin}",
       "4. Take a screenshot of the completed transfer",
       "5. Upload the screenshot below before the timer expires"
     ]
   }

3. USER UPLOADS SCREENSHOT:
   POST /api/vc-pools/:pool_id/upload-screenshot
   Body: multipart/form-data { reservation_id, screenshot (file) }

   a. Validate reservation not expired (NOW() < expires_at)
   b. Upload screenshot to Cloudinary via CloudinaryService
   c. Update submission:
      - screenshot_url = Cloudinary secure URL
      - status = 'processing'    ← now awaiting admin review
   d. Return: "Screenshot uploaded. Awaiting admin approval."

4. ADMIN REVIEWS (see Section 2.7):
   Approve → seat confirmed immediately, member created
   Reject  → seat released, user can try again if seats available
```

### 3.3 Stripe Connect Onboarding (for receiving payouts)

Required for Stripe-paying members before payouts can be processed.

```
POST /api/vc-pools/stripe-connect/onboard

1. Create Stripe Connect account:
   stripe.accounts.create({
     type: 'express',
     email: user.email,
     metadata: { user_id }
   })

2. Create account link for onboarding:
   stripe.accountLinks.create({
     account: connect_account.id,
     refresh_url: '/vc-pools/stripe-connect/refresh',
     return_url: '/vc-pools/stripe-connect/complete',
     type: 'account_onboarding'
   })

3. Save: user.stripe_connect_account_id = connect_account.id
4. Return { onboarding_url: accountLink.url }
   → User redirected to Stripe Connect onboarding
   → User provides bank details
   → Returns to app when complete

GET /api/vc-pools/stripe-connect/status
→ Returns whether Connect account is set up and verified
```

### 3.4 View My Pools

```
GET /api/vc-pools/my-pools

For each pool membership:
  - Pool info: name, status, dates, coin_type
  - My details: invested_amount, share_percent, payment_method
  - Pool performance: current_pool_value, total_profit
  - My current value: share_percent × current_pool_value
  - My PnL: current_value - invested_amount
```

### 3.5 Request Cancellation (Exit Pool)

```
POST /api/vc-pools/:pool_id/cancel-membership

1. Validate active member, no pending cancellation
2. Capture snapshot:
   - pool_status_at_request
   - IF active: calculate member_value from pool value
   - IF pre-start: member_value = invested_amount
3. Calculate estimated fee and refund
4. Create vc_pool_cancellations (status = 'pending')
5. Return estimated refund details
6. Admin reviews (Section 2.12)
   → Refund goes through member's locked payment_method
```

### 3.6 Check Payment / Reservation Status

```
GET /api/vc-pools/:pool_id/payment-status

Returns:
  - reservation: { status, expires_at, minutes_remaining }
  - payment: { method, status, screenshot_url?, stripe_session_id? }
  - message: e.g., "Awaiting admin approval" or "Payment verified"
```

---

## 4. Automated System Flows

### 4.1 Stripe Webhook Handler

Handles all Stripe events. NOT a scheduler — triggered by Stripe on each event.
Each admin has their own webhook URL: `/webhooks/stripe/:admin_id`

```
POST /webhooks/stripe/:admin_id  (no auth — verified by Stripe signature)

1. Look up admin by admin_id
2. Decrypt admin's stripe_webhook_secret_encrypted
3. Verify webhook signature using admin's webhook secret
4. Discard decrypted secret from memory
5. Process events:

   checkout.session.completed:
     → Find submission by stripe_checkout_session_id
     → submission.status = 'verified'
     → submission.stripe_payment_intent_id = event.payment_intent
     → reservation.status = 'confirmed'
     → Create vc_pool_members
     → Update pool counters (possibly → 'full')

   checkout.session.expired:
     → submission.status = 'expired'
     → reservation.status = 'expired'
     → pool.reserved_seats_count -= 1

   charge.refunded:
     → Update payout/cancellation record with stripe_refund_id

   transfer.created (Connect):
     → Update payout record with stripe_transfer_id
```

### 4.2 Seat Expiry Scheduler (BullMQ)

Runs every 30 seconds. Handles expired reservations for BOTH payment methods.

```
EVERY 30 SECONDS:

1. Find expired reservations:
   WHERE status = 'reserved' AND expires_at < NOW()

2. For each expired reservation:
   a. reservation.status = 'expired'
   b. pool.reserved_seats_count -= 1
   c. IF related submission exists AND status IN ('pending', 'processing'):
        submission.status = 'expired'

Note: For Stripe, the checkout.session.expired webhook also fires,
but the scheduler is a safety net in case the webhook is delayed.
```

### 4.3 Pool Value Update Scheduler (BullMQ)

Runs every 60 seconds for active pools. Updates pool financial aggregates.

```
EVERY 60 SECONDS (for pools WHERE status = 'active'):

1. Sum closed trades PnL
2. Fetch current market prices from Binance for open trades
3. Calculate unrealized PnL
4. Update pool:
   current_pool_value = total_invested + closed PnL + unrealized PnL
   total_profit = current_pool_value - total_invested
```

---

## 5. Complete State Transitions

### 5.1 Pool Status

```
              ┌─────────┐
              │  draft   │  Admin creates pool
              └────┬─────┘
                   │ Admin publishes
              ┌────▼─────┐
         ┌────│   open   │────────────────────┐
         │    └────┬─────┘                    │
         │         │ All seats verified        │ Admin cancels
         │    ┌────▼─────┐                    │
         │    │   full   │──────────┐         │
         │    └────┬─────┘          │         │
         │         │ Admin starts   │ Admin   │
         │    ┌────▼─────┐        cancels     │
         │    │  active  │──────────┤         │
         │    └────┬─────┘          │         │
         │         │ Admin          │         │
         │         │ completes      │         │
         │    ┌────▼─────┐    ┌────▼─────┐   │
         │    │completed │    │cancelled │◄──┘
         │    └──────────┘    └──────────┘
         │                         ▲
         └─────────────────────────┘
```

### 5.2 Seat Reservation Status

| From | To | Trigger | Stripe | Binance |
|---|---|---|---|---|
| `reserved` | `confirmed` | Payment verified | Webhook auto-confirms | Admin approves screenshot |
| `reserved` | `released` | Payment rejected | *(rare — charge.failed)* | Admin rejects screenshot |
| `reserved` | `expired` | Timer elapsed | Checkout session expired | Screenshot not uploaded in time |

### 5.3 Payment Submission Status

| From | To | Stripe | Binance |
|---|---|---|---|
| `pending` | `processing` | *(skipped)* | User uploads screenshot |
| `pending` | `verified` | Webhook: session.completed | *(goes through processing first)* |
| `processing` | `verified` | — | Admin approves |
| `processing` | `rejected` | — | Admin rejects |
| `pending` | `expired` | Webhook: session.expired / scheduler | Scheduler: timer elapsed |
| `processing` | `expired` | — | Scheduler: timer elapsed (screenshot uploaded but not reviewed in time) |

### 5.4 Cancellation Status

| From | To | Trigger |
|---|---|---|
| `pending` | `approved` | Admin approves |
| `approved` | `processed` | Refund completed (Stripe API or Binance manual) |
| `pending` | `rejected` | Admin rejects |

### 5.5 Payout Status

| From | To | Trigger |
|---|---|---|
| `pending` | `processing` | Payout initiated |
| `processing` | `completed` | Stripe: refund/transfer confirmed; Binance: admin marks paid |
| `processing` | `failed` | Transfer failed — retry needed |

---

## 6. Security Controls

### 6.1 Stripe Security

```
Stripe keys:           Per-admin, encrypted (AES-256-GCM) in admins table
                       Decrypted only during checkout creation or webhook verification
Webhook verification:  Per-admin webhook secret; URL includes admin_id for routing
Checkout sessions:     Server-side creation using admin's decrypted key; client gets URL only
Payment intents:       Unique — stored with unique constraint in DB
Connect accounts:      Express type — Stripe manages compliance/KYC
Idempotency:           Stripe handles duplicate webhook delivery
Publishable key:       Stored in plain text (public key, safe to expose to frontend)
```

### 6.2 Binance Screenshot Review

```
Screenshot storage:    Cloudinary (existing service)
Review responsibility: Admin visually verifies:
  - Amount matches expected total_amount
  - Coin/currency matches pool.coin_type
  - Transfer is to the correct Binance UID
  - Screenshot is not a duplicate from a previous submission
Admin has approve/reject with notes field for audit trail
```

### 6.3 Admin Keys (Stripe + Binance)

```
Storage:     All secret keys AES-256-GCM encrypted in admins table
             (stripe_secret_key, stripe_webhook_secret, binance_api_key, binance_api_secret)
Decryption:  Only during: Stripe checkout creation, webhook verification, trade execution
Lifetime:    Plaintext in memory only during the API call, immediately discarded
Binance:     Spot Trading + Internal Transfer ENABLED; Withdraw DISABLED, IP restricted
Stripe:      Publishable key stored in plain text (public, sent to frontend for checkout)
```

### 6.4 Rate Limiting

```
@nestjs/throttler (already in dependencies)
Apply to:
  /api/vc-pools/join             — 3 per minute (prevent spam reservations)
  /api/vc-pools/upload-screenshot — 5 per minute
  /admin/pools/payments/approve  — 10 per minute
```

### 6.5 Access Control Matrix

| Action | Who | Guard |
|---|---|---|
| Create/edit/publish pool | Admin | AdminJwtGuard |
| Start/complete/cancel pool | Admin | AdminJwtGuard |
| Execute pool trades | Admin | AdminJwtGuard |
| Review Binance screenshots | Admin | AdminJwtGuard |
| Approve/reject cancellations | Admin | AdminJwtGuard |
| Process payouts | Admin | AdminJwtGuard |
| Browse available pools | ELITE user | JwtAuthGuard + TierGuard(ELITE) |
| Join pool | ELITE user + KYC | JwtAuthGuard + TierGuard + KycGuard |
| Upload Binance screenshot | ELITE user | JwtAuthGuard |
| Stripe Connect onboarding | ELITE user | JwtAuthGuard |
| View my pools | ELITE user | JwtAuthGuard |
| Request cancellation | Pool member | JwtAuthGuard + MemberGuard |

---

## 7. API Endpoints Summary

### Admin Endpoints (prefix: `/admin`)

| Method | Path | Description |
|---|---|---|
| POST | `/admin/auth/login` | Admin login |
| POST | `/admin/auth/logout` | Admin logout |
| POST | `/admin/auth/refresh` | Refresh admin tokens |
| PUT | `/admin/settings/stripe` | Configure Stripe account (keys encrypted) |
| PUT | `/admin/settings/binance` | Configure Binance connection |
| PUT | `/admin/settings/fees` | Update default fee settings |
| GET | `/admin/pools` | List all pools |
| POST | `/admin/pools` | Create pool (draft) |
| GET | `/admin/pools/:id` | Pool details with stats |
| PUT | `/admin/pools/:id` | Edit pool (draft only) |
| PUT | `/admin/pools/:id/publish` | Publish (draft → open) |
| PUT | `/admin/pools/:id/start` | Start (full → active) |
| PUT | `/admin/pools/:id/complete` | Complete (active → completed) |
| PUT | `/admin/pools/:id/cancel` | Cancel (open/full → cancelled) |
| POST | `/admin/pools/:id/clone` | Clone pool as new draft |
| GET | `/admin/pools/:id/members` | List pool members |
| GET | `/admin/pools/:id/reservations` | List seat reservations |
| GET | `/admin/pools/:id/payments` | List payment submissions |
| PUT | `/admin/pools/:id/payments/:sid/approve` | Approve Binance screenshot |
| PUT | `/admin/pools/:id/payments/:sid/reject` | Reject Binance screenshot |
| POST | `/admin/pools/:id/trades` | Execute trade |
| GET | `/admin/pools/:id/trades` | List pool trades |
| PUT | `/admin/pools/:id/trades/:tid/close` | Close a trade |
| GET | `/admin/pools/:id/cancellations` | List cancellation requests |
| PUT | `/admin/pools/:id/cancellations/:cid/approve` | Approve exit |
| PUT | `/admin/pools/:id/cancellations/:cid/reject` | Reject exit |
| POST | `/admin/pools/:id/payouts/process` | Process pending payouts |
| PUT | `/admin/pools/:id/payouts/:pid/mark-paid` | Mark Binance payout as paid |

### User Endpoints (prefix: `/api/vc-pools`)

| Method | Path | Description |
|---|---|---|
| GET | `/api/vc-pools/available` | List open pools |
| GET | `/api/vc-pools/my-pools` | My pool memberships |
| GET | `/api/vc-pools/:id` | Pool details + my stats |
| POST | `/api/vc-pools/:id/join` | Reserve seat + select payment method |
| POST | `/api/vc-pools/:id/upload-screenshot` | Upload Binance payment screenshot |
| GET | `/api/vc-pools/:id/payment-status` | Check payment/reservation status |
| POST | `/api/vc-pools/:id/cancel-membership` | Request exit |
| GET | `/api/vc-pools/:id/my-cancellation` | Check cancellation status |
| POST | `/api/vc-pools/stripe-connect/onboard` | Start Stripe Connect onboarding |
| GET | `/api/vc-pools/stripe-connect/status` | Check Connect account status |

### Webhook Endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/webhooks/stripe/:admin_id` | Stripe webhook handler (per-admin, signature verified with admin's key) |

---

## 8. Example End-to-End Walkthroughs

### Walkthrough A: Stripe Payment — Happy Path

```
1. Admin creates pool "BTC Alpha" (100 USDT, max 3 members, 5% pool fee)
2. Admin publishes → status: open

3. User A clicks "Join Pool" → selects Stripe
   → Seat reserved (30 min timer)
   → Stripe Checkout session created
   → User redirected to Stripe page
   → Pays 105 USD (100 + 5% fee) via credit card
   → Stripe webhook fires: checkout.session.completed
   → Seat auto-confirmed, User A is pool member

4. User B joins via Stripe → same flow → auto-confirmed
5. User C joins via Stripe → same flow → auto-confirmed
   → Pool status: full (3/3 verified)

6. Admin starts pool → status: active, trading begins
7. Admin trades BTC → pool value grows to 360 USDT

8. Admin completes pool → payouts calculated:
   Each member: gross = 120, profit = 20, admin fee = 4, net = 116
   → Stripe Refund: 105 (original charge)
   → Stripe Connect Transfer: 11 (remaining net_payout - refunded amount)
   → Total received by each user: 116

9. Admin earned: 12 (profit fees) + 15 (pool fees) = 27 USDT
```

### Walkthrough B: Binance Manual Payment — Happy Path

```
1. User D clicks "Join Pool" → selects Binance
   → Seat reserved (30 min timer starts)
   → Shown: "Transfer 105 USDT to Binance UID: 12345678"

2. User D opens Binance app, does internal transfer of 105 USDT

3. User D takes screenshot of completed transfer

4. User D uploads screenshot:
   POST /api/vc-pools/abc/upload-screenshot
   → Screenshot stored on Cloudinary
   → Submission status: 'processing' (awaiting admin)

5. Admin sees screenshot in dashboard
   → Verifies amount (105 USDT), coin (USDT), recipient UID
   → Clicks "Approve"
   → Seat confirmed immediately, User D is pool member

6. For payouts/refunds → admin manually transfers on Binance
   → Enters TxID in dashboard to mark as paid
```

### Walkthrough C: User Exits Active Pool (Binance member)

```
1. User D requests cancellation while pool is active (pool value = 330)
   → member_value = 33.33% × 330 = 110
   → cancellation fee = 5% × 110 = 5.50
   → estimated refund = 104.50

2. Admin approves cancellation
   → Admin manually transfers 104.50 USDT on Binance to User D
   → Admin enters Binance TxID in dashboard
   → Cancellation status: 'processed'
   → User D removed from pool, shares recalculated for remaining members
```

### Walkthrough D: Pool Never Fills → Admin Cancels

```
1. Pool has 2/5 members (1 Stripe, 1 Binance)
2. Admin cancels pool → full refund, no fee

   Stripe member: → Stripe Refund API (full 105 USD)
   Binance member: → Admin manually transfers 105 USDT on Binance

3. Pool status: cancelled
```

---

## 9. NestJS Module Structure (Recommended)

```
src/modules/
├── admin-auth/                    # Admin authentication
│   ├── admin-auth.module.ts
│   ├── controllers/
│   │   └── admin-auth.controller.ts
│   ├── services/
│   │   ├── admin-auth.service.ts
│   │   ├── admin-token.service.ts
│   │   └── admin-session.service.ts
│   ├── guards/
│   │   └── admin-jwt-auth.guard.ts
│   └── strategies/
│       └── admin-jwt.strategy.ts
│
├── vc-pool/                       # Core VC Pool module
│   ├── vc-pool.module.ts
│   ├── controllers/
│   │   ├── admin-pool.controller.ts
│   │   ├── admin-pool-payments.controller.ts
│   │   ├── admin-pool-trades.controller.ts
│   │   └── user-pool.controller.ts
│   ├── services/
│   │   ├── pool-management.service.ts
│   │   ├── seat-reservation.service.ts
│   │   ├── stripe-payment.service.ts     # Stripe Checkout + Connect
│   │   ├── binance-payment.service.ts    # Screenshot upload + admin review
│   │   ├── pool-trading.service.ts
│   │   ├── pool-payout.service.ts
│   │   ├── pool-cancellation.service.ts
│   │   └── pool-value.service.ts
│   ├── webhooks/
│   │   └── stripe-webhook.controller.ts  # POST /webhooks/stripe
│   ├── schedulers/
│   │   ├── seat-expiry.scheduler.ts      # BullMQ repeatable job
│   │   └── pool-value-update.scheduler.ts
│   ├── guards/
│   │   ├── elite-tier.guard.ts
│   │   └── pool-member.guard.ts
│   └── dto/
│       ├── create-pool.dto.ts
│       ├── join-pool.dto.ts
│       ├── upload-screenshot.dto.ts
│       └── execute-trade.dto.ts
```

---

*VC Pool Complete Flow v2.1 — Dual payment (Stripe per-admin + Binance manual), full admin + user flows.*
