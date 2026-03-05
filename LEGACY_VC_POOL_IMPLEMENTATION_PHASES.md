# VC Pool — Legacy Implementation Phases (Phase 1, 1A-1E, 2)

**LEGACY DOCUMENT:** Contains previous implementation phases (1A-1E, Phase 2). These flows have been deprecated in favor of the Binance Manual Transaction History approach. Kept for reference and historical context.

**Current Implementation:** See `VC_POOL_BINANCE_MANUAL_PAYMENT_FLOW.md` for the active payment flow.

**Date:** 2026-03-03
**Status:** SUPERSEDED

---

## Historical Context

This document combines all previous VC Pool implementation phases:
- **Phase 1A-1E:** Manual payment (screenshot + admin approval) with manual trading
- **Phase 2:** Payment gateway integration (Stripe Checkout, Stripe Connect, Binance API trading)
- **TRADES_FROM_TOP_TRADES:** Exchange order tracking (now merged into core trading flow)

These phases have been consolidated into the newer **Binance Manual Transaction History Approach** which provides:
- Automatic TX verification via Binance API (no manual screenshot review)
- Complete transaction audit trail in DB
- Better edge case handling (shortfalls, duplicate payments, etc.)

---

## 1. Phase 1 Overview (LEGACY)

**What it delivered:**
- Admin authentication (separate from users)
- Pool CRUD and lifecycle management
- Seat reservation with timer
- Manual Binance payment (screenshot + admin approval)
- Manual trading entry
- Manual payout and refund recording

**Key tables created (still in use):**
- `admins` — separate from users
- `admin_sessions` — admin authentication
- `vc_pools` — pool definitions
- `vc_pool_members` — pool memberships
- `vc_pool_seat_reservations` — temporary seat locks
- `vc_pool_payment_submissions` — payment records
- `vc_pool_trades` — trading activity
- `vc_pool_payouts` — completion payouts
- `vc_pool_cancellations` — member exits

---

## 2. Phase 1A: Schema + Admin Auth (LEGACY)

**Status:** Successfully implemented in v1. Schema is still in use.

### 2.1 Admin Auth Flow (Still in Use)

```
POST /admin/auth/login
├─ Lookup admin by email
├─ Verify password with bcrypt
├─ Create admin_sessions record
├─ Generate JWT (access + refresh) with role: 'admin'
└─ Return tokens (httpOnly cookie + body)

POST /admin/auth/logout
├─ Revoke admin session
└─ Clear cookies

POST /admin/auth/refresh
├─ Verify refresh token
└─ Issue new token pair
```

### 2.2 Schema

All tables from this phase are still active:
- `admins` table with Binance UID + fee settings
- `admin_sessions` table for session management
- All enums: PoolStatus, PaymentMethod, PaymentSubmissionStatus, etc.

---

## 3. Phase 1B-1C: Pool Management + Join Flow (LEGACY)

**What was built:**
- Pool CRUD (create, edit, publish, delete)
- Seat reservation with 30-min expiry timer
- Dual payment method support (Stripe bypass + Binance screenshot)
- Member creation on payment confirmation

**Key flow (now replaced by transaction history verification):**
```
User clicks Join
├─ Seat reserved (30 min timer)
├─ IF payment_method === 'stripe':
│   └─ Stripe Checkout (now bypassed)
└─ IF payment_method === 'binance':
    ├─ Show admin Binance UID
    ├─ User uploads screenshot
    ├─ Admin reviews screenshot
    ├─ Admin approves/rejects
    └─ ON APPROVE: member created
```

---

## 4. Phase 1D: Manual Trading (LEGACY)

**What was built:**
- Manual trade entry (admin types Binance limit order details)
- PnL calculation from manually entered prices
- Pool value update scheduler (every 60 seconds)

**Old flow (now replaced by API integration):**
```
POST /admin/pools/:poolId/trades
├─ Admin enters: symbol, qty, entry_price
├─ System calculates unrealized PnL
└─ Stored in vc_pool_trades table

PUT /admin/pools/:poolId/trades/:tradeId/close
├─ Admin enters: exit_price
├─ System calculates realized PnL
└─ Pool value updates
```

---

## 5. Phase 1E: Payouts + Cancellations (LEGACY)

**What was built:**
- Manual payout recording (admin marks paid with TX ID)
- Manual refund processing (admin marks refunded with TX ID)
- Cancellation workflow (user request → admin approve/reject)
- Fee calculation for early exit

**Old flow (payouts):**
```
Admin clicks "Complete Pool"
├─ Calculate final pool value
├─ For each member:
│   ├─ Calculate: gross payout, admin fee, net payout
│   └─ Create payout record (status: pending)
├─ Admin manually transfers on Binance
└─ Admin enters TX ID in dashboard
    └─ Payout marked as "completed"
```

**Old flow (refunds):**
```
User requests cancel
├─ Admin reviews in dashboard
├─ IF approved:
│   ├─ Calculate fee deduction
│   ├─ Calculate refund amount
│   ├─ Admin manually transfers on Binance
│   ├─ Admin enters TX ID in dashboard
│   └─ Cancellation marked as "processed"
└─ IF rejected:
    └─ User stays in pool
```

---

## 6. Phase 2: Payment Gateway Integration (LEGACY)

**Status:** Partially designed, not fully implemented due to pivot to Binance-only approach.

### 6.1 Stripe Checkout

**What was planned:**
- Real Stripe Checkout session (not bypassed)
- Webhook verification via per-admin webhook secret
- Auto-confirmation on successful payment

**Never fully implemented because:**
- Complexity of managing per-admin Stripe accounts
- User verification challenges (KYC alignment)
- Focus shifted to simpler Binance TX verification

### 6.2 Binance API Trading

**What was planned:**
- Admin provides Binance API keys (encrypted storage)
- Backend executes trades directly via Binance API
- Automatic order ID recording

**Replaced by:**
- Current transaction history tracking approach
- Simpler manual entry with TX verification

### 6.3 Stripe Connect Payouts

**What was planned:**
- Users onboard Stripe Connect account
- Profits transferred to user's connected bank account
- Refunds go back to original payment method

**Never fully implemented because:**
- Complex onboarding flow
- Compliance requirements
- Binance-only simplification

---

## 7. TRADES_FROM_TOP_TRADES: Exchange Order Tracking (LEGACY)

**What was designed:**
- Model: `vc_pool_exchange_orders` to track orders separately from user orders
- Admin places pool-specific orders using personal Binance keys
- Orders tagged per pool for accurate pool PnL calculation

**Now replaced by:**
- Direct `vc_pool_trades` with Binance order ID tracking
- Transaction history approach eliminates ambiguity

---

## 8. Admin API Endpoints (Phase 1-2) (LEGACY)

| Method | Path | Status |
|---|---|---|
| POST | `/admin/auth/login` | **IN USE** |
| POST | `/admin/auth/logout` | **IN USE** |
| POST | `/admin/auth/refresh` | **IN USE** |
| PUT | `/admin/settings/binance` | **IN USE** |
| PUT | `/admin/settings/fees` | **IN USE** |
| PUT | `/admin/settings/stripe` | DEPRECATED |
| GET | `/admin/pools` | **IN USE** |
| POST | `/admin/pools` | **IN USE** |
| PUT | `/admin/pools/:id` | **IN USE** |
| PUT | `/admin/pools/:id/publish` | **IN USE** |
| PUT | `/admin/pools/:id/start` | **IN USE** |
| PUT | `/admin/pools/:id/complete` | **IN USE** |
| PUT | `/admin/pools/:id/cancel` | **IN USE** |
| GET | `/admin/pools/:id/members` | **IN USE** |
| GET | `/admin/pools/:id/payments` | MODIFIED (now includes TX verification) |
| PUT | `/admin/pools/:id/payments/:sid/approve` | MODIFIED (uses API verification) |
| PUT | `/admin/pools/:id/payments/:sid/reject` | **IN USE** |
| POST | `/admin/pools/:id/trades` | **IN USE** (manual entry still supported) |
| PUT | `/admin/pools/:id/trades/:tid/close` | **IN USE** |
| PUT | `/admin/pools/:id/payouts/:pid/mark-paid` | **IN USE** (with TX tracking) |
| PUT | `/admin/pools/:id/cancellations/:cid/approve` | **IN USE** (with TX tracking) |

---

## 9. User API Endpoints (Phase 1-2) (LEGACY)

| Method | Path | Status |
|---|---|---|
| GET | `/api/vc-pools/available` | **IN USE** |
| POST | `/api/vc-pools/:id/join` | MODIFIED (simplified to Binance only) |
| POST | `/api/vc-pools/:id/upload-screenshot` | DEPRECATED (replaced by TX ID submission) |
| GET | `/api/vc-pools/:id/payment-status` | MODIFIED |
| POST | `/api/vc-pools/:id/submit-binance-tx` | **NEW** (replaces screenshot upload) |
| POST | `/api/vc-pools/:id/cancel-membership` | **IN USE** |
| GET | `/api/vc-pools/my-pools` | **IN USE** |

---

## 10. Migration Path (From Phase 1 to Current)

**What changed:**
1. ❌ Removed: Screenshot upload endpoint
2. ❌ Removed: Admin screenshot review dashboard
3. ✅ Added: TX ID submission endpoint
4. ✅ Added: Automatic TX verification via Binance API
5. ✅ Added: Transaction audit trail table (`vc_pool_transactions`)
6. ✅ Added: Auto-confirmation via cron jobs
7. ✅ Added: Shortfall detection and handling

**Data migration:**
- Existing `vc_pool_payment_submissions` records remain unchanged
- New column: `binance_tx_id` to store TX IDs
- New table: `vc_pool_transactions` for comprehensive audit trail

---

## 11. Key Learnings from Previous Phases

### 11.1 Problems with Phase 1 (Manual Screenshot Review)

1. **Slow:** Admin must manually review each screenshot
2. **Error-prone:** Admin could approve wrong screenshot or invalid transfer
3. **Not auditable:** No permanent record of which TX actually came through
4. **Trust issues:** Money sits in admin's account pending manual approval
5. **No double-spend protection:** Screenshot could be duplicated

### 11.2 Problems with Phase 2 (Stripe/Binance API)

1. **Complex:** Per-admin Stripe accounts, webhook routing, encryption
2. **Compliance:** KYC requirements with Stripe Connect
3. **User friction:** Connect onboarding adds friction
4. **Interoperability:** Requires user to enable withdrawal permission on API key

### 11.3 Why Binance Manual TX Verification Works Better

1. **Simple:** User submits TX ID, backend verifies it exists
2. **Auditable:** Full TX history stored in DB
3. **Fast:** Auto-verified via API, no manual work
4. **Trustworthy:** Matches admin's actual received funds
5. **Detects edge cases:** Shortfalls, duplicates, late payments
6. **Recovery:** Can detect and handle failed/orphaned transfers

---

## 12. References

- **Current implementation:** `VC_POOL_BINANCE_MANUAL_PAYMENT_FLOW.md`
- **DB Schema:** `VC_pool_FINAL_prisma_changes.md`
- **Issues & Solutions:** `VC_POOL_PAYMENT_SHORTFALL_HANDLING.md`

---

**End of Legacy Documentation**
