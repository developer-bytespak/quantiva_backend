# Binance P2P Payment Flow — API Documentation

> **What's New:** Binance P2P exact-match payment verification for VC Pools
> 
> This document covers ONLY the new endpoints and features added for the Binance payment flow. It does not cover previously existing VC Pool APIs (join, screenshot upload, admin approve/reject, etc.)

---

## Frontend Developer Guide — What This Feature Does

### The Problem We're Solving

Previously, when a user joined a VC Pool via Binance, they had to:
1. Send money on Binance
2. Take a screenshot
3. Upload the screenshot
4. Wait for an admin to manually review and approve/reject

**Now with this update:** The user sends money on Binance P2P, submits the TX ID in our app, and the backend **automatically verifies** the payment with Binance's API. No admin involvement needed.

### How It Works (User Journey)

```
User already joined a pool (existing flow)
          ↓
User pays on Binance P2P (sends EXACT amount to admin UID)
          ↓
Binance gives user a TX ID
          ↓
User enters TX ID in our app          ← NEW API
          ↓
Backend auto-verifies every 5 min     ← NEW CRON JOB
          ↓
   ┌── Amount matches exactly → APPROVED (member created)
   └── Any variance at all   → REJECTED (refund initiated)
          ↓
User polls status to see result        ← NEW APIs
```

### Exact Match Rule (Critical for Frontend)

```
Expected = Contribution + (Contribution × Pool Fee %)
Example:  100 + (100 × 5%) = 105 USDT

105.00 USDT sent → ✓ APPROVED
104.99 USDT sent → ✗ REJECTED + refund
105.01 USDT sent → ✗ REJECTED + refund
```

**There is zero tolerance.** Frontend must display the exact amount prominently with a warning.

### What Frontend Needs to Build

1. **TX ID Input Form** — After user pays on Binance, show a form with:
   - Text input for Binance TX ID (required)
   - Datetime picker for transaction timestamp (required)
   - Display the exact amount expected (from join response)
   - Warning: "Amount must be exactly {amount} USDT"

2. **Verification Status UI** — After submitting TX ID, poll and show:
   | `binance_payment_status` | UI | Color | Message |
   |---|---|---|---|
   | `pending` | Spinner | Yellow | "Verifying with Binance..." |
   | `verified` | ✓ Checkmark | Green | "Payment confirmed! You're a member." |
   | `rejected` | ✗ X icon | Red | Show `refund_reason` + "Seat released. Refund processing." |
   | `refunded` | ℹ Info | Blue | "Refund processed." |

3. **My Submissions List** — A page showing all user's payment submissions across pools

4. **Transaction History** — Audit log of all payment events

---

## New API Endpoints (4 Total)

### API 1: Submit Binance TX ID

```
POST /api/vc-pools/:id/submit-binance-tx
Authorization: Bearer <jwt_token>
```

**When to call:** After user has joined a pool (via existing `POST /:id/join`) and completed payment on Binance P2P.

**Path Params:**
| Param | Type | Description |
|-------|------|-------------|
| id | UUID | Pool ID |

**Request Body:**
```json
{
  "binance_tx_id": "TX98765432100123",
  "binance_tx_timestamp": "2026-03-06T10:15:00.000Z"
}
```

| Field | Type | Required | Validation | Description |
|-------|------|----------|------------|-------------|
| binance_tx_id | string | Yes | max 255 chars, not empty | Binance P2P order/transaction ID |
| binance_tx_timestamp | string | Yes | ISO 8601 date | When the transaction was made |

**Success Response (201):**
```json
{
  "message": "Binance TX ID submitted. Verification in progress...",
  "submission_id": "s1s2s3-e4f5-6789-abcd-ef0123456789",
  "binance_tx_id": "TX98765432100123",
  "exact_amount_expected": 105,
  "status": "processing",
  "binance_payment_status": "pending"
}
```

**All Possible Errors:**
| Code | Error | Message | When |
|------|-------|---------|------|
| 400 | BadRequestException | `binance_tx_id is required` | Empty/missing TX ID |
| 400 | BadRequestException | `binance_tx_timestamp must be a valid ISO date string` | Invalid date |
| 400 | BadRequestException | `Seat reservation is {status}, cannot submit payment` | Reservation not `reserved` |
| 400 | BadRequestException | `Reservation has expired. Please join the pool again.` | Timer expired |
| 400 | BadRequestException | `Payment is already {status}. Cannot update TX ID.` | Payment not `pending` |
| 404 | NotFoundException | `No reservation found for this pool` | No reservation exists |
| 404 | NotFoundException | `No payment submission found for this reservation` | No payment record |
| 404 | NotFoundException | `Pool not found` | Invalid pool ID |
| 409 | ConflictException | `This Binance TX ID has already been used` | Duplicate TX ID |

---

### API 2: Get My Payment Submissions

```
GET /api/vc-pools/payments/my-submissions
Authorization: Bearer <jwt_token>
```

**When to call:** To show a list of all user's payment submissions (all pools). Good for a "My Payments" page.

**Success Response (200):**
```json
[
  {
    "submission_id": "s1s2s3-...",
    "pool_id": "a1b2c3d4-...",
    "pool_name": "BTC Growth Pool",
    "coin_type": "USDT",
    "payment_method": "binance",
    "total_amount": "105.00000000",
    "investment_amount": "100.00000000",
    "pool_fee_amount": "5.00000000",
    "binance_tx_id": "TX98765432100123",
    "status": "processing",
    "binance_payment_status": "pending",
    "exact_amount_expected": "105.00000000",
    "exact_amount_received": null,
    "refund_reason": null,
    "rejection_reason": null,
    "verified_at": null,
    "submitted_at": "2026-03-06T10:00:00.000Z",
    "payment_deadline": "2026-03-06T10:30:00.000Z"
  }
]
```

**Rejected submission example (amount mismatch):**
```json
{
  "submission_id": "r1r2r3-...",
  "pool_id": "q1q2q3-...",
  "pool_name": "SOL Pool",
  "coin_type": "USDT",
  "payment_method": "binance",
  "total_amount": "52.50000000",
  "investment_amount": "50.00000000",
  "pool_fee_amount": "2.50000000",
  "binance_tx_id": "TX11122233344",
  "status": "rejected",
  "binance_payment_status": "rejected",
  "exact_amount_expected": "52.50000000",
  "exact_amount_received": "52.00000000",
  "refund_reason": "Shortfall: received 52.00000000 instead of 52.50000000",
  "rejection_reason": "Shortfall: received 52.00000000 instead of 52.50000000",
  "verified_at": null,
  "submitted_at": "2026-03-06T09:00:00.000Z",
  "payment_deadline": "2026-03-06T09:30:00.000Z"
}
```

---

### API 3: Get Payment Submission Detail

```
GET /api/vc-pools/payments/submissions/:submissionId
Authorization: Bearer <jwt_token>
```

**When to call:** To show detailed info about a single payment (includes admin Binance UID and reservation details).

**Path Params:**
| Param | Type | Description |
|-------|------|-------------|
| submissionId | UUID | Payment submission ID |

**Success Response (200):**
```json
{
  "submission_id": "s1s2s3-...",
  "pool_id": "a1b2c3d4-...",
  "pool_name": "BTC Growth Pool",
  "coin_type": "USDT",
  "payment_method": "binance",
  "total_amount": "105.00000000",
  "investment_amount": "100.00000000",
  "pool_fee_amount": "5.00000000",
  "binance_tx_id": "TX98765432100123",
  "status": "processing",
  "binance_payment_status": "pending",
  "exact_amount_expected": "105.00000000",
  "exact_amount_received": null,
  "refund_reason": null,
  "rejection_reason": null,
  "verified_at": null,
  "submitted_at": "2026-03-06T10:00:00.000Z",
  "payment_deadline": "2026-03-06T10:30:00.000Z",
  "screenshot_url": null,
  "reservation_status": "reserved",
  "reservation_expires_at": "2026-03-06T10:30:00.000Z",
  "admin_binance_uid": "987654321"
}
```

**Errors:**
| Code | Message | When |
|------|---------|------|
| 400 | Validation failed | Invalid UUID format |
| 404 | Submission not found | Doesn't exist or belongs to another user |

---

### API 4: Get My Transactions

```
GET /api/vc-pools/payments/my-transactions
Authorization: Bearer <jwt_token>
```

**When to call:** To show audit/history log of all payment events. Returns max 50 most recent.

**Success Response (200):**
```json
[
  {
    "transaction_id": "t1t2t3-...",
    "pool_id": "a1b2c3d4-...",
    "pool_name": "BTC Growth Pool",
    "transaction_type": "payment_submitted",
    "amount_usdt": "105.00000000",
    "binance_tx_id": "TX98765432100123",
    "expected_amount": "105.00000000",
    "actual_amount_received": null,
    "status": "pending",
    "description": "User submitted Binance P2P TX ID: TX98765432100123",
    "created_at": "2026-03-06T10:00:00.000Z",
    "resolved_at": null
  },
  {
    "transaction_id": "t4t5t6-...",
    "pool_id": "a1b2c3d4-...",
    "pool_name": "BTC Growth Pool",
    "transaction_type": "payment_verified",
    "amount_usdt": "105.00000000",
    "binance_tx_id": "TX98765432100123",
    "expected_amount": "105.00000000",
    "actual_amount_received": "105.00000000",
    "status": "verified",
    "description": "Payment verified via Binance P2P. Exact match: 105.00000000 USDT",
    "created_at": "2026-03-06T10:05:00.000Z",
    "resolved_at": "2026-03-06T10:05:00.000Z"
  }
]
```

**Transaction Types:**
| Type | Description |
|------|-------------|
| `payment_submitted` | User submitted TX ID |
| `payment_verified` | Exact match confirmed, member created |
| `payment_rejected` | Amount mismatch, refund initiated |

---

## Background: Auto-Verification Cron Job

> **Not an API — runs automatically every 5 minutes**

The backend has a cron job that:
1. Finds all payments where `binance_payment_status = "pending"` and `binance_tx_id` is not null
2. Calls Binance API to get the actual transaction details
3. Compares actual amount vs expected amount
4. **Exact match → Approve** (creates pool member, confirms reservation)
5. **Any variance → Reject** (releases seat, sets refund reason)

Frontend doesn't need to trigger this — just poll the status APIs after submitting TX ID.

**Polling recommendation:** Poll `GET /api/vc-pools/:id/payment-status` every 5-10 seconds after TX submission. Stop when `binance_payment_status` changes from `pending`.

---

## New Prisma Schema Fields (For Reference)

Added to `vc_pool_payment_submissions`:
```
binance_tx_id                 String?   @unique    — Binance P2P transaction ID
binance_tx_timestamp          DateTime?            — When TX happened on Binance
binance_amount_received_usdt  Decimal?             — Actual amount received
exact_amount_expected         Decimal?             — What we expected
exact_amount_received         Decimal?             — What Binance confirmed
binance_payment_status        BinancePaymentStatus — pending/verified/rejected/refunded
refund_initiated_at           DateTime?            — When refund was triggered
refund_reason                 String?              — Why payment was rejected
```

New enum:
```
BinancePaymentStatus: pending | verified | rejected | refunded
```

New table `vc_pool_transactions` — audit log for all payment events.

New table `user_credits` — for future admin refund/credit transfers.

---

## New Backend Files Created

| File | Purpose |
|------|---------|
| `services/payment-submission.service.ts` | Submit TX ID, get submissions & transactions |
| `services/binance-verification.service.ts` | Verify exact match via Binance API, approve/reject |
| `schedulers/payment-verification.scheduler.ts` | Cron every 5 min to auto-verify |
| `dto/submit-binance-tx.dto.ts` | Request validation for TX submission |

---

## Error Response Format

All errors follow:
```json
{
  "statusCode": 400,
  "message": "Human-readable error message",
  "error": "Bad Request"
}
```

| HTTP Code | When |
|-----------|------|
| 400 | Validation failure, wrong state |
| 401 | Missing/expired JWT |
| 403 | Wrong tier (need ELITE) |
| 404 | Resource not found |
| 409 | Duplicate TX ID |
