# VC Pool — Phase 2: Payment Gateway Integration

**Adds Stripe checkout + webhooks + Connect payouts, and Binance API trading.**
**Prerequisite:** Phase 1 fully implemented and working.
**No schema migration needed** — all tables/columns were created in Phase 1.

---

## What Phase 2 Adds

| Feature | Phase 1 (manual) | Phase 2 (integrated) |
|---|---|---|
| **Stripe payment** | Bypassed — admin manually approves | Stripe Checkout page → auto-verified via webhook |
| **Stripe payouts** | Admin manually marks as paid | Stripe Refund API + Stripe Connect Transfer (automated) |
| **Stripe refunds** | Admin manually marks as refunded | Stripe Refund API (automated) |
| **Stripe Connect** | Not available | User onboards → bank account linked → receives payouts |
| **Binance trading** | Admin manually enters trade details | Admin executes via Binance API → auto-recorded |
| **Binance payouts** | Admin manually transfers + marks paid | Admin clicks "Send" → Binance Internal Transfer API |
| **Webhook handler** | Not needed | `POST /webhooks/stripe/:admin_id` — handles checkout events |
| **Admin Stripe setup** | Skipped | Full: secret key + publishable key + webhook secret (encrypted) |
| **Admin Binance keys** | Only UID stored | Full: UID + API key + API secret (encrypted, for trading) |

---

## 1. Schema Changes — NONE

All tables, columns, and enums were created in Phase 1. Phase 2 simply populates the fields that were NULL:

| Field | Phase 1 | Phase 2 |
|---|---|---|
| `admins.stripe_secret_key_encrypted` | NULL | Encrypted Stripe secret key |
| `admins.stripe_publishable_key` | NULL | Stripe publishable key |
| `admins.stripe_webhook_secret_encrypted` | NULL | Encrypted webhook secret |
| `admins.binance_api_key_encrypted` | NULL | Encrypted Binance API key |
| `admins.binance_api_secret_encrypted` | NULL | Encrypted Binance API secret |
| `users.stripe_connect_account_id` | NULL | Set during Connect onboarding |
| `vc_pool_payment_submissions.stripe_checkout_session_id` | NULL | Stripe session ID |
| `vc_pool_payment_submissions.stripe_payment_intent_id` | NULL | Stripe payment intent ID |
| `vc_pool_trades.binance_order_id` | NULL | Binance order ID from API |
| `vc_pool_payouts.stripe_refund_id` | NULL | Stripe refund ID |
| `vc_pool_payouts.stripe_transfer_id` | NULL | Stripe Connect transfer ID |
| `vc_pool_cancellations.stripe_refund_id` | NULL | Stripe refund ID |
| `vc_pool_cancellations.stripe_transfer_id` | NULL | Stripe Connect transfer ID |

**No `npx prisma migrate` needed.** Just `npm install stripe` and implement the new services.

---

## 2. New Dependencies

```bash
cd q_nest
npm install stripe
```

---

## 3. Admin Setup — New Endpoints to Implement

### 3.1 Admin Stripe Setup

Replace the "Coming soon" stub from Phase 1.

```
PUT /admin/settings/stripe
Body: { stripe_secret_key, stripe_publishable_key, stripe_webhook_secret }

1. Encrypt stripe_secret_key using EncryptionService
2. Encrypt stripe_webhook_secret using EncryptionService
3. Store stripe_publishable_key as-is (public key)
4. Update admins record
5. Verify connection: call Stripe API with decrypted key
6. Discard decrypted key from memory
7. Return:
   {
     status: "connected",
     webhook_url: "https://your-domain.com/webhooks/stripe/{admin_id}"
   }

Admin configures this webhook URL in Stripe Dashboard:
  Stripe Dashboard → Developers → Webhooks → Add endpoint
  URL: https://your-domain.com/webhooks/stripe/{admin_id}
  Events: checkout.session.completed, checkout.session.expired, charge.refunded
```

### 3.2 Admin Binance API Keys Setup

Extend the Phase 1 endpoint to accept API keys for trading.

```
PUT /admin/settings/binance
Body: { binance_uid, api_key, api_secret }

1. Store binance_uid (same as Phase 1)
2. Encrypt api_key and api_secret using EncryptionService
3. Update admins record
4. Verify connection: call Binance API (get account info)
5. Discard decrypted keys from memory
6. Return success/failure

Binance API Key Requirements:
  ✅ Read account info     — ENABLED
  ✅ Spot Trading          — ENABLED
  ✅ Internal Transfer     — ENABLED (for payouts/refunds)
  ❌ Withdraw              — DISABLED
  ❌ Futures / Margin      — DISABLED
  IP Restriction: Backend server IP only
```

---

## 4. Stripe Payment Flow — Replace Phase 1 Bypass

### 4.1 User Joins with Stripe (Replace bypass logic)

**Phase 1:** User selects "stripe" → submission created with `status = 'processing'` → admin manually approves.

**Phase 2:** User selects "stripe" → real Stripe Checkout session created → user pays on Stripe → webhook auto-verifies.

```
In POST /api/vc-pools/:pool_id/join, IF payment_method === 'stripe':

1. Look up pool's admin → decrypt admin's stripe_secret_key
2. Create Stripe Checkout Session:
   const stripe = new Stripe(decryptedKey)
   const session = await stripe.checkout.sessions.create({
     mode: 'payment',
     line_items: [{
       price_data: {
         currency: 'usd',
         unit_amount: Math.round(total_amount * 100),
         product_data: { name: pool.name, description: pool.description }
       },
       quantity: 1
     }],
     metadata: { pool_id, user_id, reservation_id, submission_id, admin_id },
     success_url: '{frontend}/vc-pools/{pool_id}/payment-success',
     cancel_url: '{frontend}/vc-pools/{pool_id}/payment-cancelled',
     expires_at: Math.floor(reservation.expires_at.getTime() / 1000)
   })
3. Discard decrypted key

4. Create payment_submission:
   - payment_method = 'stripe'
   - stripe_checkout_session_id = session.id
   - status = 'pending'  ← (changed from Phase 1's 'processing')

5. Return { checkout_url: session.url }
   → User redirected to Stripe hosted checkout page
```

### 4.2 Stripe Webhook Handler — NEW

```
POST /webhooks/stripe/:admin_id

1. Look up admin by admin_id
2. Decrypt admin's stripe_webhook_secret_encrypted
3. Verify signature: stripe.webhooks.constructEvent(body, sig, decryptedSecret)
4. Discard decrypted secret

5. Handle events:

checkout.session.completed:
  a. Extract pool_id, user_id, reservation_id, submission_id from metadata
  b. submission.stripe_payment_intent_id = event.data.object.payment_intent
  c. submission.status = 'verified'
  d. submission.verified_at = NOW()
  e. reservation.status = 'confirmed'
  f. Create vc_pool_members (payment_method = 'stripe')
  g. pool.verified_members_count += 1
  h. IF full → pool.status = 'full'

checkout.session.expired:
  a. submission.status = 'expired'
  b. reservation.status = 'expired'
  c. pool.reserved_seats_count -= 1

charge.refunded:
  a. Find payout/cancellation by stripe_payment_intent_id
  b. Update record with stripe_refund_id

transfer.created:
  a. Find payout by stripe_transfer_id
  b. Update record
```

### 4.3 Stripe Connect Onboarding — NEW

Replace Phase 1 stub with real implementation.

```
POST /api/vc-pools/stripe-connect/onboard

1. Decrypt admin's stripe_secret_key (use any pool's admin or a platform key)
2. Create Connect account:
   const account = await stripe.accounts.create({
     type: 'express',
     email: user.email,
     metadata: { user_id }
   })
3. Create onboarding link:
   const link = await stripe.accountLinks.create({
     account: account.id,
     refresh_url: '{frontend}/vc-pools/stripe-connect/refresh',
     return_url: '{frontend}/vc-pools/stripe-connect/complete',
     type: 'account_onboarding'
   })
4. user.stripe_connect_account_id = account.id
5. Return { onboarding_url: link.url }

GET /api/vc-pools/stripe-connect/status
→ Check if user.stripe_connect_account_id exists and account is verified
```

---

## 5. Stripe Payouts & Refunds — Replace Manual Marking

### 5.1 Automated Payout Processing

Replace Phase 1's "mark-paid" with automated Stripe processing for Stripe members.

```
POST /admin/pools/:pool_id/payouts/process

For each pending payout WHERE member.payment_method === 'stripe':

  1. Decrypt admin's stripe_secret_key
  2. IF net_payout ≤ initial_investment + pool_fee:
       → Stripe Refund (partial or full):
         const refund = await stripe.refunds.create({
           payment_intent: original_payment_intent_id,
           amount: Math.round(net_payout * 100)
         })
       → payout.stripe_refund_id = refund.id

  3. IF net_payout > initial_investment + pool_fee (profit scenario):
       → Stripe Refund (original full amount):
         await stripe.refunds.create({ payment_intent: ..., amount: original_amount })
       → Stripe Connect Transfer (profit portion):
         const transfer = await stripe.transfers.create({
           amount: Math.round(profit_portion * 100),
           currency: 'usd',
           destination: user.stripe_connect_account_id
         })
       → payout.stripe_refund_id = refund.id
       → payout.stripe_transfer_id = transfer.id

  4. payout.status = 'completed', payout.paid_at = NOW()
  5. Discard decrypted key

For payouts WHERE member.payment_method === 'binance':
  → Same as Phase 1: admin manually transfers, then PUT mark-paid
```

### 5.2 Automated Cancellation Refunds

```
When admin approves cancellation AND member.payment_method === 'stripe':

1. Calculate refund_amount (after fee)
2. Stripe Refund:
   const refund = await stripe.refunds.create({
     payment_intent: original_payment_intent_id,
     amount: Math.round(refund_amount * 100)
   })
3. cancellation.stripe_refund_id = refund.id
4. cancellation.status = 'processed'

When member.payment_method === 'binance':
  → Same as Phase 1: manual
```

---

## 6. Binance API Trading — Replace Manual Entry

### 6.1 Execute Trade via Binance API

Replace Phase 1's manual entry with actual Binance API execution.

```
POST /admin/pools/:pool_id/trades
Body: { asset_pair, action, quantity, strategy_id?, notes? }

Phase 2 change:
1. Decrypt admin's Binance API keys
2. Execute trade on Binance API:
   - Place market order via Binance REST API
   - Get fill price and order ID from response
3. Create vc_pool_trades record:
   - entry_price_usdt = fill price from Binance (NOT manually entered)
   - binance_order_id = Binance order ID (NEW — was NULL in Phase 1)
   - is_open = true
4. Discard decrypted keys

CLOSE TRADE:
PUT /admin/pools/:pool_id/trades/:tid/close

Phase 2 change:
1. Decrypt admin's Binance API keys
2. Execute close order on Binance API
3. Update trade:
   - exit_price_usdt = fill price from Binance (NOT manually entered)
   - pnl_usdt = calculated
   - is_open = false
4. Discard decrypted keys
```

### 6.2 Binance Internal Transfer for Payouts

```
For Binance member payouts/refunds, admin can click "Send via Binance":

1. Decrypt admin's Binance API keys
2. Execute Binance Internal Transfer:
   POST /sapi/v1/asset/transfer
   {
     type: 'MAIN_UMFUTURE', // or appropriate transfer type
     asset: 'USDT',
     amount: payout.net_payout,
     toEmail: member.user_binance_uid  // or Binance email
   }
3. Store response TxID in payout.binance_tx_id
4. payout.status = 'completed'
5. Discard decrypted keys

Fallback: admin can still use Phase 1's manual "mark-paid" if preferred.
```

---

## 7. New Services to Create in Phase 2

| Service | Purpose |
|---|---|
| `stripe-payment.service.ts` | Stripe Checkout session creation, key decryption |
| `stripe-webhook.service.ts` | Webhook signature verification + event processing |
| `stripe-connect.service.ts` | Connect account creation, onboarding links, transfers |
| `stripe-payout.service.ts` | Refund API + Connect Transfer for payouts |
| `binance-trading.service.ts` | Authenticated Binance API trading (replace manual entry) |
| `binance-transfer.service.ts` | Binance Internal Transfer API for payouts |

### Updated Module Structure

```
src/modules/vc-pool/
├── ... (all Phase 1 files remain) ...
├── services/
│   ├── ... (Phase 1 services unchanged) ...
│   ├── stripe-payment.service.ts         # NEW
│   ├── stripe-connect.service.ts         # NEW
│   ├── stripe-payout.service.ts          # NEW
│   ├── binance-trading.service.ts        # NEW (replaces manual in pool-trading.service)
│   └── binance-transfer.service.ts       # NEW
├── webhooks/
│   └── stripe-webhook.controller.ts      # NEW
```

---

## 8. Phase 1 → Phase 2 Migration Checklist

| # | Task | Touches |
|---|---|---|
| 1 | `npm install stripe` | package.json |
| 2 | Implement `PUT /admin/settings/stripe` (replace stub) | admin-pool.controller, admins service |
| 3 | Extend `PUT /admin/settings/binance` (add API keys) | admin-pool.controller, admins service |
| 4 | Create `stripe-payment.service.ts` | new file |
| 5 | Update join flow: if Stripe → create real Checkout session (replace bypass) | payment-submission.service |
| 6 | Create `stripe-webhook.controller.ts` + register route | new file, vc-pool.module |
| 7 | Create `stripe-webhook.service.ts` | new file |
| 8 | Create `stripe-connect.service.ts` | new file |
| 9 | Implement Connect onboarding endpoints (replace stubs) | user-pool.controller |
| 10 | Create `stripe-payout.service.ts` | new file |
| 11 | Implement `POST /admin/pools/:id/payouts/process` for Stripe | pool-payout.service |
| 12 | Update cancellation approval: auto Stripe refund | pool-cancellation.service |
| 13 | Create `binance-trading.service.ts` | new file |
| 14 | Update trade creation: execute via Binance API (replace manual) | pool-trading.service |
| 15 | Create `binance-transfer.service.ts` | new file |
| 16 | Add Binance Internal Transfer option for payouts | pool-payout.service |
| 17 | Update pool publish validation: check Stripe keys configured | pool-management.service |
| 18 | Test end-to-end: Stripe join → webhook → payout | integration tests |
| 19 | Test end-to-end: Binance API trade → close → payout | integration tests |

---

## 9. Phase 2 Walkthrough — Stripe Full Flow

```
1. Admin configures Stripe keys at /admin/settings/stripe
   → Gets webhook URL, configures in Stripe Dashboard

2. User A clicks "Join Pool" → selects Stripe
   → Seat reserved (30 min timer)
   → Redirected to Stripe Checkout page
   → Pays 105 USD via credit card
   → Stripe webhook fires: checkout.session.completed
   → Seat auto-confirmed, User A is pool member ✓ (no admin action needed)

3. Pool fills up → admin starts → admin trades via Binance API
   → POST /admin/pools/abc/trades { asset: BTCUSDT, action: BUY, qty: 0.005 }
   → System executes on Binance → records fill price + order ID automatically

4. Admin completes pool → clicks "Process Payouts"
   → Stripe members: auto-refund + Connect transfer (automated)
   → Binance members: admin clicks "Send via Binance" or marks manually
   → All payouts completed ✓

5. If user had cancellation during active pool:
   → Admin approves → Stripe Refund API fires automatically
   → Cancellation processed ✓
```

---

*VC Pool Phase 2 — Payment gateway integration. No schema changes. Builds on top of Phase 1.*
