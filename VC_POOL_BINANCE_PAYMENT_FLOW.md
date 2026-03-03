# VC Pool — Binance Payment Flow (New Flow)

**Document purpose:** Describe the new VC pool payment flow where **all money movement is via Binance** (admin’s deposit address for joining; admin sends to members’ Binance for payouts and refunds). No code changes in this doc — implementation plan and open questions only.

**Date:** 2026-03-03

---

## 1. High-Level New Flow

| Phase | Who | What happens |
|-------|-----|--------------|
| **Join** | User | Clicks Join → seat reserved → sees **admin’s Binance deposit details** on the pool page → user sends the required amount from **their Binance account** to admin’s Binance address → user submits **Binance TX ID** (or system verifies automatically) → once verified, user is a member. |
| **Payout (pool completed)** | Admin | Admin **transfers** each member’s net payout from **admin’s Binance** to **each member’s Binance** (each member has their own Binance receive address). System records `binance_tx_id` per payout. |
| **Exit / Refund (mid-pool or after join)** | Admin | Fee is deducted → admin **transfers** the refund amount from admin’s Binance to **member’s Binance** address. System records `binance_refund_tx_id`. |

**Core idea:** One place holds funds (admin’s Binance). Users pay **in** to that place (to admin’s deposit address). Users get money **out** when admin sends from that place to each user’s Binance address.

---

## 2. Current State (Brief)

- **Join:** User can choose `stripe` or `binance`. For Stripe: checkout session, webhook, auto-verify. For Binance: reservation + payment submission in `pending`; user was expected to pay somehow; admin could approve after screenshot/manual check. `vc_pool_payment_submissions` has Stripe fields; no Binance TX ID for the **join** payment yet. Seat reservation and ~30 min payment window exist (`payment_window_minutes`).
- **Payout / Refund:** Payouts and cancellations are calculated; admin marks paid/refunded and can pass `binance_tx_id` / `binance_refund_tx_id`. No automated Binance transfer; admin does it externally and records the TX ID.
- **Member:** `vc_pool_members` has `user_binance_uid` (optional). No “member Binance deposit address” for receiving payouts/refunds stored today.

---

## 3. New Flow — Detailed

### 3.1 Join Flow (User Pays to Join Pool)

1. User clicks **Join** on a VC pool.
2. Backend reserves a seat and creates a **payment submission** with:
   - `payment_method = binance`
   - `total_amount` = investment + pool fee
   - `payment_deadline` = now + pool’s `payment_window_minutes` (e.g. 30 min).
3. User is shown **admin’s Binance payment details** on the pool page:
   - **Deposit address** (e.g. USDT ERC-20 or BEP-20, as configured by admin).
   - **Amount** (exact USDT or agreed coin/network).
   - **Network** (e.g. ERC-20, BEP-20) so user sends on the correct chain.
   - Optional: QR code for the address.
4. User goes to **their own Binance account** and sends that amount to the admin’s address (same coin/network). User receives a **Binance TX ID** (transaction hash) from Binance.
5. **Payment verification** (one of the two below; to be decided):
   - **Option A — User submits TX ID:** User enters the TX ID in the app. Backend (or admin) verifies the transaction (e.g. via admin’s Binance API “deposit history” or a blockchain explorer). If valid and amount matches → mark payment as verified → create member, confirm reservation.
   - **Option B — Automated transfer via user’s API:** User has connected their Binance API (with withdrawal permission). Backend uses user’s API to **withdraw** the required amount from user’s Binance to admin’s deposit address. Success → we get TX ID automatically → mark payment verified → create member. (Higher risk: user must enable withdrawals on their API key.)
6. Once payment is **verified**:
   - Payment submission status → `verified`.
   - Reservation → `confirmed`.
   - **Member** is created with `invested_amount_usdt`, `payment_method = binance`, and optionally **member’s Binance deposit address** (for future payouts/refunds).
   - Pool’s `verified_members_count` incremented.

**Required for join:**

- Store **admin’s Binance deposit address** (and optionally network/coin) per pool or per admin (e.g. USDT ERC-20, USDT BEP-20). Either in DB or fetched via admin’s Binance API when needed.
- **Payment verification path:** either “user submits TX ID + verify” or “backend does transfer from user’s Binance to admin’s address” (see open questions).
- If user submits TX ID: store **TX ID** on the payment submission (new field if not present) and use it when marking verified.

---

### 3.2 Pool Completion — Payout to Members

1. Admin **completes** the pool (existing logic: close trades, compute final value, create payout rows).
2. For each member, a **payout** row exists with `net_payout` (and already has `binance_tx_id` in schema).
3. **Each member has a Binance receive address** (stored when they joined or in profile). Admin (or system) **sends** `net_payout` from **admin’s Binance** to **member’s Binance address**.
4. Admin records the **Binance TX ID** for each payout (existing `markPayoutPaid(poolId, payoutId, binanceTxId?, notes?)`). Optionally: backend could call Binance Withdraw API with admin’s key and store the returned TX ID automatically (see open questions).

**Required:**

- **Member’s Binance deposit address** (and optionally network/coin) must be stored: e.g. on `vc_pool_members` or on `users`. Needed for: completion payouts and exit refunds.
- Admin’s Binance API must have **Enable Withdrawals** to send to external addresses.
- Existing payout creation and `markPayoutPaid` with `binance_tx_id` already support “admin did the transfer, here’s the TX ID.”

---

### 3.3 Exit / Cancellation — Refund to Member

1. User requests **exit** (cancel membership). Backend creates a **cancellation** request (existing logic: fee calculation, `refund_amount`).
2. Admin **approves** the cancellation (existing flow).
3. Admin **transfers** `refund_amount` from **admin’s Binance** to **member’s Binance address**.
4. Admin calls **mark refunded** with the **Binance TX ID** (existing `markRefunded(..., binance_refund_tx_id)`). Schema already has `binance_refund_tx_id` on `vc_pool_cancellations`.

**Required:**

- Same as payouts: **member’s Binance deposit address** must be available so admin (or system) knows where to send the refund.
- No schema change for cancellation; only ensuring we have member’s address when doing the transfer.

---

## 4. What Needs to Change (Summary)

### 4.1 Data / Schema

| Item | Purpose |
|------|--------|
| **Admin’s Binance deposit address(es)** | Show on pool page so user knows where to send the join payment. Optionally: coin + network (e.g. USDT, ERC-20). Could be stored on `admins` or `vc_pools` (e.g. `admin_binance_deposit_address_usdt`, `admin_binance_deposit_network`). Or fetched via Binance API from admin’s API key (e.g. GET deposit address). |
| **Member’s Binance deposit address** | Where to send completion payouts and exit refunds. Store on `vc_pool_members` (e.g. `binance_deposit_address`, `binance_deposit_network`) or on `users` (one address per user for all pools). Must be collected at join (when payment_method = binance) or in user profile. |
| **Join payment TX ID** | When user pays to admin’s address, we need to store the transaction id for verification and audit. Add to `vc_pool_payment_submissions` e.g. `binance_tx_id` (or `user_payment_tx_id`). |
| **Optional:** Remove or reduce Stripe-specific fields if the product is Binance-only for VC pools; or keep both and support both (Stripe + Binance). |

### 4.2 Backend / API

| Area | Change |
|------|--------|
| **Join – reserve seat** | Unchanged: reserve seat + create payment submission with `payment_method: binance`, deadline. |
| **Get admin deposit info** | New (or extend pool details): API that returns the **admin’s Binance deposit address** (and amount, network, coin) for a given pool so the frontend can show it after user clicks Join. |
| **Submit / verify join payment** | **Option A:** New endpoint: user submits `binance_tx_id` (and maybe amount) for their payment submission. Backend verifies (e.g. via admin’s Binance API deposit history, or external explorer). If valid → approve payment (same as current “approve payment” flow) and create member. **Option B:** Endpoint that uses **user’s** Binance API to perform withdrawal to admin’s address; on success, backend marks payment verified and creates member. |
| **Store member deposit address** | When user joins with Binance, they must provide (or we fetch) their Binance deposit address for future payouts. Add to join payload (e.g. `binance_deposit_address`, `binance_deposit_network`) and save on `vc_pool_members` (or user). Validate format (address length, network). |
| **Payout** | Already: create payout rows, admin transfers externally, then `markPayoutPaid(payoutId, binanceTxId)`. Optional: new endpoint that calls Binance Withdraw API (admin’s key) to send `net_payout` to member’s address and stores the returned TX ID. |
| **Refund** | Already: approve cancellation, admin transfers externally, then `markRefunded(cancellationId, binanceRefundTxId)`. Optional: same as payout — endpoint to trigger withdrawal to member’s address and store TX ID. |
| **Screenshot / manual approval** | If moving to “TX ID verification” or “automated transfer,” the old “upload screenshot and admin approves” flow can be deprecated or kept as fallback. |

### 4.3 Frontend (Reference Only)

- **Pool page (join):** After Join, show admin’s Binance address, amount, network, and (if Option A) a form to paste **Binance TX ID** and submit.
- **Join form:** When payment method is Binance, collect and send **member’s Binance deposit address** (and network) for future payouts/refunds.
- **Admin:** When marking payout paid or refunded, optionally pre-fill or show member’s Binance address and allow pasting the TX ID (or trigger automated transfer if implemented).

---

## 5. Open Questions for You

1. **Join payment verification**
   - **Option A:** User sends from their Binance to admin’s address manually, then submits the **TX ID**. We verify (admin’s Binance API deposit history or explorer) and then approve. No need for user’s API key with withdrawal.
   - **Option B:** User connects Binance API with withdrawal; backend **initiates** the transfer from user’s account to admin’s deposit address and gets TX ID automatically. Requires user to trust the app with withdrawal permission.
   - Which do you want (A, B, or both)?

2. **Admin’s deposit address**
   - Should we **store** it in DB (e.g. admin sets “USDT deposit address” and network in settings)?
   - Or **fetch** it each time via admin’s Binance API (e.g. “get deposit address” for USDT)? (Requires admin to have API key configured.)

3. **Member’s Binance address**
   - Collected **only at join** (for that pool) and stored on `vc_pool_members`?
   - Or **one per user** in user profile (e.g. “my Binance USDT address for receiving payouts”) and reused for all pools? If one per user, we might store it on `users` or a `user_binance_payout_address` table.

4. **Coin and network**
   - Join and payouts: always **USDT**? Or do we support multiple coins (e.g. BUSD, USDC)? Same network for everyone (e.g. BEP-20) or different networks per user (ERC-20 vs BEP-20)? This affects how we store “deposit address” and “network” and how we validate.

5. **Stripe**
   - Keep Stripe as an alternative for joining (user can choose Stripe or Binance), or **Binance-only** for VC pools from now on?

6. **Automated transfers**
   - Should the backend **call Binance Withdraw API** (admin’s key) to send payout/refund to member’s address and then store the TX ID automatically? Or admin always does the transfer in Binance UI and only pastes the TX ID in our app (current “mark as paid” flow)?

---

## 6. Implementation Order (Suggested)

1. **Schema:** Add admin deposit address (or decide to use API); add member deposit address (and where it lives); add `binance_tx_id` to payment submissions for join.
2. **APIs:** Get admin deposit info for pool; submit TX ID (and verify) for join; store member address on join.
3. **Join flow:** Wire frontend to show admin address and amount; collect member address and TX ID; backend verification and member creation.
4. **Payout / Refund:** Ensure member address is available when listing payouts/cancellations; optional: automate Binance withdrawal and TX ID recording.
5. **Cleanup:** Deprecate or keep screenshot/manual approval path; Stripe vs Binance support per product decision.

---

## 7. No Code in This Doc

This document does **not** change any code. It is the specification and plan. Implementation (Prisma migrations, services, controllers, DTOs) should follow this flow and the decisions you provide to the open questions above.
