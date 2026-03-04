# VC Pool — Fully Automated Binance Payment — Implementation Plan

**Goal:** Implement the fully automated Binance flow: (1) User joins by authorizing a transfer from their Binance to admin’s; (2) On pool completion, admin clicks one button to send all payouts to members’ Binance; (3) On cancel/exit, after admin approval, refund is sent to member’s Binance automatically.

**Date:** 2026-03-03

---

## 1. Overview

| Flow | Trigger | Source | Destination | API Used |
|------|--------|--------|-------------|----------|
| **Join** | User clicks Join + confirms | User’s Binance (user’s API) | Admin’s Binance deposit address | `POST /sapi/v1/capital/withdraw/apply` (user’s key) |
| **Payout** | Admin clicks “Pay all” | Admin’s Binance (admin’s API) | Each member’s Binance deposit address | Same (admin’s key) |
| **Refund** | Admin approves cancellation | Admin’s Binance (admin’s API) | Exiting member’s Binance deposit address | Same (admin’s key) |

All movements use Binance **Withdraw API**. No internal “transfer between users” API; we withdraw to the other account’s **deposit address**.

---

## 2. Prerequisites (No Code)

- **User:** Has connected Binance in the app (exchange connection with **Enable Withdrawals**). We use their connection for the join transfer only.
- **Admin:** Has Binance API keys on `admins` with **Enable Withdrawals**. Used for payouts and refunds.
- **Admin deposit address:** Either stored in DB (admin settings) or fetched via Binance “get deposit address” using admin’s API.
- **Member deposit address:** Stored when user joins (for payouts/refunds). Must be provided in the join request when payment method is Binance.
- **Coin/network:** Assume USDT; one network per pool or per admin (e.g. BEP-20). Configurable later if needed.

---

## 3. Phase 1 — Schema & Config

### 3.1 Prisma schema changes

**File:** `q_nest/prisma/schema.prisma`

| Model | Change | Purpose |
|-------|--------|--------|
| **admins** | Add `binance_deposit_address_usdt String? @db.VarChar(255)`, `binance_deposit_network String? @db.VarChar(30)` (e.g. `BEP20`, `ERC20`). | Store admin’s USDT deposit address and network for join payments. Optional: fetch via API instead and skip these. |
| **vc_pool_payment_submissions** | Add `binance_tx_id String? @db.VarChar(255)`, `user_binance_deposit_address String? @db.VarChar(255)`, `user_binance_deposit_network String? @db.VarChar(30)`. | Store withdrawal id when user pays via automated withdraw; store user’s deposit address (copied to member on verification). |
| **vc_pool_members** | Add `binance_deposit_address String? @db.VarChar(255)`, `binance_deposit_network String? @db.VarChar(30)`. Keep `user_binance_uid` if still useful. | Where to send completion payouts and exit refunds. |

**Migration:** One migration after schema edit (e.g. `add_binance_automated_payment_fields`).

### 3.2 Config / constants

- Default withdraw coin: `USDT`.
- Default network if not set: e.g. `BEP20` (or from admin/pool settings).
- Optional: `BINANCE_VC_WITHDRAW_COIN`, `BINANCE_VC_WITHDRAW_NETWORK` in env.

---

## 4. Phase 2 — Binance Withdraw & Deposit Address

### 4.1 BinanceService (exchanges module)

**File:** `q_nest/src/modules/exchanges/integrations/binance.service.ts`

Add:

1. **`getDepositAddress(apiKey, apiSecret, coin: string, network?: string): Promise<{ address: string; network: string; tag?: string }>`**  
   - Call Binance `GET /sapi/v1/capital/config/getall` (or the deposit-address endpoint) to get deposit address for the given coin/network.  
   - Used to show admin’s address on pool page (if not stored in DB) or to validate admin’s stored address.

2. **`withdraw(apiKey, apiSecret, params: { coin: string; network?: string; address: string; amount: number; withdrawOrderId?: string; addressTag?: string }): Promise<{ id: string }>`**  
   - Call `POST /sapi/v1/capital/withdraw/apply`.  
   - Return the withdrawal `id` (and optionally tx id when available from history).  
   - Handle errors (insufficient balance, invalid address, withdrawal not allowed, etc.).

**Reference:** Binance docs — [Withdraw](https://developers.binance.com/docs/wallet/capital/withdraw), deposit address endpoint.

### 4.2 Optional: Get deposit address via API

If admin’s address is not stored in DB, add an endpoint or internal method that uses **admin’s** Binance API to fetch deposit address for USDT (and chosen network). Cache or return to frontend for the pool join screen.

---

## 5. Phase 3 — Join Flow (Automated)

### 5.1 Join request payload

**User must send:**

- `payment_method: 'binance'`
- **`binance_deposit_address`** — User’s Binance deposit address (where they want to receive payouts/refunds later).
- **`binance_deposit_network`** — e.g. `BEP20`, `ERC20` (same as pool’s network for consistency).

**Optional:** `connection_id` or rely on “user’s active Binance connection” (e.g. `getActiveConnectionByType(userId, 'crypto')` and ensure exchange is Binance).

### 5.2 Backend flow (high level)

1. **Reserve seat + create payment submission** (existing logic)  
   - `payment_method = binance`, `total_amount`, `payment_deadline`.  
   - Store **member’s** `binance_deposit_address` and `binance_deposit_network` on the **reservation** or submission (we need them when creating the member; they can live on submission as “future member address” or we pass them to member creation). Easiest: store on submission (new columns) or pass via join DTO and save when creating member. So we need submission to hold “user’s deposit address for this payment” — e.g. add `user_binance_deposit_address`, `user_binance_deposit_network` on `vc_pool_payment_submissions`, and when we create the member we copy to `vc_pool_members.binance_deposit_address` / `binance_deposit_network`.

   **Simpler:** Add `binance_deposit_address`, `binance_deposit_network` on **vc_pool_members** only. When creating the member (after payment verified), we need these values — so they must be sent at join and stored somewhere before member exists. Options: (a) Store on payment submission (add fields), then copy to member on approval. (b) Store on reservation. Recommendation: **add to vc_pool_payment_submissions**: `user_binance_deposit_address`, `user_binance_deposit_network`. When we verify and create member, copy to `vc_pool_members`.

   So schema:

- **vc_pool_payment_submissions:** add `user_binance_deposit_address String?`, `user_binance_deposit_network String?`, `binance_tx_id String?`.

2. **New endpoint: “Execute join payment” (automated)**  
   - **POST** e.g. `/api/vc-pools/:poolId/join/execute-payment` or `/api/vc-pools/:poolId/payment/execute-binance`.  
   - Auth: User JWT.  
   - Body: none (or confirm: `{ "confirm": true }`).  
   - Logic:
     - Load pool, reservation, payment submission for this user and pool (status pending, not expired).
     - Get **admin’s** deposit address (from `admins.binance_deposit_address_usdt` + network, or fetch via admin’s Binance API).
     - Get **user’s** active Binance connection (ExchangesService.getActiveConnectionByType(userId, 'crypto') and ensure exchange name is Binance). Decrypt user’s API keys.
     - Call **BinanceService.withdraw** with **user’s** keys: coin USDT, network pool’s/admin’s, address = admin’s deposit address, amount = submission.total_amount, withdrawOrderId = submission_id.
     - On success: get withdrawal `id`. Update submission: set `binance_tx_id = id`, status → `processing` or directly to `verified` (see below). Then run **same logic as “approve payment”**: create member, confirm reservation, increment pool, copy `user_binance_deposit_address` / `user_binance_deposit_network` from submission to member. If you prefer to wait for withdrawal to complete, you could set status `processing` and have a cron or webhook that checks withdraw history and then marks verified and creates member; for simplicity the plan assumes we treat “withdraw submitted successfully” as enough to create the member (risk: withdrawal could later fail; optional: poll withdraw status and then verify).

   So: one new endpoint that (1) validates reservation/submission, (2) gets admin address and user connection, (3) calls withdraw with user’s key, (4) on success updates submission and creates member (and confirms reservation).

3. **Get “admin deposit info” for pool**  
   - **GET** e.g. `/api/vc-pools/:poolId/deposit-info` (user-scoped) or include in pool details.  
   - Returns: `{ address, network, coin, amount, payment_deadline }` so the frontend can show “Send X USDT to this address (network) before deadline.” Used when we don’t do automated withdraw (e.g. fallback) or for display. For fully automated flow, frontend may only need amount and deadline; address is for manual fallback.

### 5.3 DTOs

- **JoinPoolDto** (existing): add `binance_deposit_address`, `binance_deposit_network` (required when `payment_method === 'binance'`).
- **ExecutePaymentDto**: optional `{ confirm: true }` for idempotency or confirmation.

### 5.4 SeatReservationService / PaymentReviewService

- **Join:** When creating payment submission for binance, save `user_binance_deposit_address` and `user_binance_deposit_network` from DTO. Validate format (length, regex for address).
- **When creating member** (in execute-payment flow or in approve): set `vc_pool_members.binance_deposit_address` and `binance_deposit_network` from submission (or from reservation if stored there). So member has the address for future payouts/refunds.

### 5.5 Edge cases

- User has no Binance connection or connection is not Binance → 400 “Connect Binance in Settings”.
- User’s connection has no withdrawal permission → 400 “Enable Withdrawals on your Binance API key”.
- Insufficient balance → Binance error; return clear message.
- Submission already verified → 409 or 200 no-op.
- Reservation expired → 400 “Reservation expired”.

---

## 6. Phase 4 — Payout (Pool Completed) — One-Click “Pay All”

### 6.1 Flow

1. Pool is already **completed** (existing flow: admin completes pool, payout rows created with `net_payout` per member, status `pending`).
2. New endpoint: **POST** `/admin/pools/:poolId/payouts/execute-all` (or similar).  
   - Auth: Admin JWT.  
   - Logic:
     - Load pool (must be completed), all payouts for pool with status `pending`.
     - Load admin’s Binance API keys and deposit-address config (we only need to withdraw from admin; no address needed for admin here). For each payout: load member’s `binance_deposit_address` and `binance_deposit_network`. If any member has no address, return 400 listing which members are missing address.
     - Loop over each payout (or batch if Binance allows): call **BinanceService.withdraw** with **admin’s** keys: coin USDT, network from pool/member, address = member’s deposit address, amount = payout.net_payout, withdrawOrderId = payout_id.
     - For each successful withdraw: update payout with `binance_tx_id = id`, status = `completed`, `paid_at = now()`.
     - If one fails: optionally continue and return partial result, or fail entire request (recommend: fail fast and return which one failed so admin can fix address/balance).
   - Return: list of payouts with status and tx id.

### 6.2 Optional: “Execute single payout”

- **POST** `/admin/pools/:poolId/payouts/:payoutId/execute` — same logic for one payout. Useful if “execute all” fails for one member and admin fixes address then retries that one.

### 6.3 Idempotency

- If payout already has status `completed`, skip or return success. Do not double-withdraw.

---

## 7. Phase 5 — Refund (Cancel/Exit) — Automated

### 7.1 Flow

1. User requests cancel → cancellation row created (existing).  
2. Admin approves → cancellation status `approved`, `refund_amount` set (existing).  
3. New endpoint: **POST** `/admin/pools/:poolId/cancellations/:cancellationId/execute-refund` (or merge into “approve + execute” in one step).  
   - Auth: Admin JWT.  
   - Logic:
     - Load cancellation (must be approved, not yet processed). Load member’s `binance_deposit_address` and `binance_deposit_network`. If missing, 400.
     - Call **BinanceService.withdraw** with **admin’s** keys: amount = cancellation.refund_amount, address = member’s deposit address, coin USDT, network from member.
     - On success: update cancellation with `binance_refund_tx_id = id`, status = `processed`, `refunded_at = now()`; deactivate member; recalculate remaining members’ share_percent (existing logic in markRefunded). Decrement pool’s verified_members_count.
   - Return: refund tx id and status.

**Alternative:** Combine “approve” and “execute refund” into one admin action: when admin clicks “Approve and refund”, backend approves, then immediately runs the withdraw and marks processed. Same logic, one less endpoint.

### 7.2 Idempotency

- If cancellation is already `processed`, return success or 409.

---

## 8. Phase 6 — Admin Deposit Address (For Join)

### 8.1 Option A — Stored in DB

- Admin settings (existing or new): admin sets “Binance USDT deposit address” and “Network” (e.g. BEP20). Save to `admins.binance_deposit_address_usdt` and `admins.binance_deposit_network`.
- **GET** `/admin/pools/:poolId/deposit-info` (admin) or **GET** `/api/vc-pools/:poolId/deposit-info` (user): return address, network, coin, and for a given reservation the amount and deadline. User-facing endpoint only returns after user has a reservation (so they see amount + admin’s address).

### 8.2 Option B — Fetched via API

- Admin has Binance API keys. When pool page needs deposit info, backend calls **BinanceService.getDepositAddress(adminKey, adminSecret, 'USDT', network)** and returns it. No new columns; requires admin’s keys to be set.

Recommendation: **Option A** (store in DB) so we don’t depend on admin API at display time; optional fallback to Option B.

---

## 9. Phase 7 — Services & Module Wiring

### 9.1 New or extended services

| Service | Responsibility |
|---------|----------------|
| **SeatReservationService** | Already creates reservation + submission. Extend to accept and store `binance_deposit_address`, `binance_deposit_network` on submission; validate when payment_method is binance. |
| **PaymentReviewService** or new **VcPoolBinancePaymentService** | Execute join payment (user’s withdraw to admin), execute all payouts (admin’s withdraw to each member), execute refund (admin’s withdraw to member). Depends on Prisma, BinanceService, EncryptionService, and for join: ExchangesService (to get user’s Binance connection and decrypt keys). |
| **PoolPayoutService** | Already creates payout rows and markPayoutPaid. Extend with “execute all” and “execute one” that call Binance withdraw and then mark paid with tx id. Or move “execute” into a dedicated service that uses PoolPayoutService + Binance. |
| **PoolCancellationService** | Already has approve and markRefunded. Add “execute refund” (withdraw then markRefunded) or merge into approve. |

Recommendation: add **VcPoolBinancePaymentService** that encapsulates: (1) executeJoinPayment(userId, poolId), (2) executeAllPayouts(adminId, poolId), (3) executeRefund(adminId, poolId, cancellationId). It uses BinanceService, EncryptionService, ExchangesService (for user connection on join), and Prisma. Other services (SeatReservation, PaymentReview, Payout, Cancellation) stay as-is or are called from this service to avoid duplication (e.g. “create member” logic can be reused from PaymentReviewService).

### 9.2 Module dependencies

- **VcPoolModule** already imports **ExchangesModule** (for pool order placement). Use ExchangesService to get user’s Binance connection and BinanceService for withdraw. If BinanceService doesn’t expose withdraw yet, add it in ExchangesModule’s BinanceService. EncryptionService is already in ExchangesModule; use it to decrypt admin’s and user’s keys.

### 9.3 Permissions

- User’s Binance connection must have **Enable Withdrawals** for join. Document this and optionally check connection metadata (if Binance returns permissions) and reject with a clear message if withdrawals are not allowed.
- Admin’s Binance API (on admins table) must have **Enable Withdrawals** for payouts and refunds.

---

## 10. Phase 8 — API Summary (New/Changed)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/vc-pools/:poolId/join` | User | Extend body: when binance, require `binance_deposit_address`, `binance_deposit_network`. Reserve seat + create submission; store user’s deposit address on submission. |
| POST | `/api/vc-pools/:poolId/join/execute-payment` | User | Execute automated withdraw from user’s Binance to admin’s address; on success create member and confirm reservation. |
| GET | `/api/vc-pools/:poolId/deposit-info` | User (with active reservation) | Return admin’s deposit address, network, coin, amount, deadline (for display or manual fallback). |
| POST | `/admin/pools/:poolId/payouts/execute-all` | Admin | Withdraw each pending payout from admin’s Binance to each member’s address; update payouts with binance_tx_id and mark paid. |
| POST | `/admin/pools/:poolId/payouts/:payoutId/execute` | Admin | Same for one payout. |
| POST | `/admin/pools/:poolId/cancellations/:cancellationId/execute-refund` | Admin | Withdraw refund_amount from admin’s Binance to member’s address; mark cancellation processed and deactivate member (or merge with approve). |

Optional: **PUT** admin settings to set `binance_deposit_address_usdt` and `binance_deposit_network` if using Option A for admin address.

---

## 11. Phase 9 — Security & Validation

- **Address format:** Validate deposit addresses (length, character set) before storing and before calling withdraw. Binance may return invalid-address errors; fail fast with a clear message.
- **Amounts:** Use decimal types; avoid floating point for money. Ensure withdrawal amount matches submission total (join) or payout net (payout/refund).
- **Double-spend:** Idempotency: do not create member twice; do not withdraw twice for the same submission/payout/cancellation. Use submission/payout/cancellation status and optional `binance_tx_id` presence.
- **Admin keys:** Never log or expose admin’s API secret. Decrypt only in memory when calling Binance.
- **User keys:** Same for user’s connection; use ExchangesService so decryption stays in one place.

---

## 12. Phase 10 — Error Handling & Logging

- Log every withdraw attempt (pool id, user/member id, amount, destination address hash or last 4 chars, success/failure). Do not log full API keys or full addresses in plain text if logs are shared.
- Map Binance errors to user-friendly messages: insufficient balance, withdrawal disabled, invalid address, network congestion, etc.
- Consider retries only for transient errors (e.g. network timeout), not for “insufficient balance” or “invalid address”.

---

## 13. Implementation Order (Checklist)

1. [ ] **Phase 1:** Schema + migration (admins deposit fields, submission deposit + tx id, members deposit address).
2. [ ] **Phase 2:** BinanceService: `getDepositAddress`, `withdraw`; add tests if possible.
3. [ ] **Phase 3:** Join: extend JoinPoolDto and reservation/submission creation; add `execute-payment` endpoint; wire VcPoolBinancePaymentService (or equivalent) with user connection and admin address; create member on success.
4. [ ] **Phase 4:** Deposit info endpoint (admin’s address + amount + deadline for pool).
5. [ ] **Phase 5:** Admin settings (optional): save/update admin’s Binance deposit address and network.
6. [ ] **Phase 6:** Payout: execute-all and execute-one endpoints; validate all members have deposit address; call withdraw and mark paid.
7. [ ] **Phase 7:** Refund: execute-refund endpoint (or merge with approve); deactivate member and recalculate shares.
8. [ ] **Phase 8:** Error handling, logging, idempotency, and permission checks (withdraw enabled).
9. [ ] **Phase 9:** Frontend: join form (deposit address + network), “Confirm and pay” button calling execute-payment; admin: “Pay all” and “Execute refund” buttons; display deposit info where needed.

---

## 14. Optional Enhancements (Later)

- **Withdraw status polling:** After calling withdraw, poll Binance withdraw history by `withdrawOrderId` and only then mark payout/refund as completed (more accurate than “submitted”).
- **Webhook:** If Binance supports withdraw-completed webhooks, use them to update status.
- **Multi-coin:** Support more than USDT (e.g. BUSD) and multiple networks; store per-coin/network for admin and member.
- **Stripe:** Keep Stripe join path as alternative; only Binance path uses the new execute-payment and deposit-address storage.

This plan is implementation-ready: follow phases in order and wire endpoints and services as described.
