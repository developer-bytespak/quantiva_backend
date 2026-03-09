# VC Pool - Complete API Documentation

> **Base URL:** `/api/vc-pools` (User) | `/admin/pools` (Admin)
> 
> **Auth:** All endpoints require JWT Bearer token in `Authorization` header
> 
> **User Tier:** All user endpoints require `ELITE` tier

---

## Frontend Developer Guide — What We're Building & Why

### What is a VC Pool?

A VC Pool is a **group investment feature** where an admin (professional trader) creates a pool and multiple users contribute money into it. The admin then trades on behalf of the pool. Profits and losses are shared among all members based on their share percentage.

Think of it like a **mini fund** — one expert trader, multiple investors, shared results.

### The Complete User Journey (What the Frontend Needs to Support)

**The user goes through 6 screens/states in order:**

#### Screen 1: Browse Available Pools
- User sees a list of open pools with details: pool name, contribution amount, fee %, duration, seats remaining
- Each pool card shows how many seats are left (`max_members - verified_members_count - reserved_seats_count`)
- User picks a pool and clicks "Join"
- **API:** `GET /api/vc-pools/available`

#### Screen 2: Join Pool & See Payment Instructions
- User clicks "Join" on a pool
- Backend reserves a seat for 30 minutes (configurable per pool)
- Frontend receives the **exact amount** to pay (contribution + pool fee) and the **admin's Binance UID**
- Frontend shows a countdown timer (30 min) — if it runs out, the seat is released automatically
- Payment instructions are shown step by step
- **API:** `POST /api/vc-pools/:id/join` with `{ "payment_method": "binance" }`

#### Screen 3: User Pays on Binance (Outside Our App)
- User opens the Binance app separately
- Goes to P2P → Internal Transfer
- Enters the admin's Binance UID (shown on our screen)
- Sends **exactly** the amount shown (e.g., 105 USDT — not 104.99, not 105.01)
- Binance completes the transfer and shows a **TX ID** (transaction/order number)
- User copies this TX ID

> **IMPORTANT FOR FRONTEND:** Display the exact amount prominently with a warning that it must be exact. Any variance = automatic rejection + refund. Show admin Binance UID clearly with a copy button.

#### Screen 4: Submit TX ID (Back in Our App)
- User comes back to our app
- Enters the Binance TX ID and the timestamp of the transaction
- Frontend validates: TX ID is not empty, timestamp is valid ISO date
- Submits to backend
- Backend moves payment to `processing` status
- Frontend shows "Verifying with Binance..." message
- **API:** `POST /api/vc-pools/:id/submit-binance-tx`

> **ALTERNATIVE PATH (Screenshot):** If the admin hasn't set up Binance API keys for auto-verification, the user can instead upload a screenshot of the completed transfer. The admin then manually approves/rejects it.
> - **API:** `POST /api/vc-pools/:id/upload-screenshot`

#### Screen 5: Payment Status Page (Polling)
- After submitting TX ID, frontend should **poll every 5-10 seconds** to check verification status
- Show one of three states:
  - **Pending/Processing** — yellow spinner, "Verifying with Binance..."
  - **Verified** — green checkmark, "Payment confirmed! You are now a pool member."
  - **Rejected** — red X, show the `refund_reason` (e.g., "Shortfall: received 104.99 instead of 105.00"), show "Refund will be processed" message
- **API:** `GET /api/vc-pools/:id/payment-status` (for specific pool) or `GET /api/vc-pools/payments/my-submissions` (all pools)

> **FRONTEND TIP:** Use `binance_payment_status` field for the Binance-specific verification status. The general `status` field covers both Binance and Stripe flows.

#### Screen 6: Pool Dashboard (After Becoming a Member)
- Once verified, user is a pool member
- They can see: their invested amount, share %, pool performance, trades made by admin
- They can request cancellation if pool hasn't started trading yet
- **APIs:** `GET /api/vc-pools/my-pools`, `POST /api/vc-pools/:id/cancel-membership`

### Payment Validation Logic (Exact Match Only)

This is the core rule frontend developers need to understand:

```
Expected Amount = Contribution Amount + (Contribution Amount × Pool Fee %)

Example: Pool with 100 USDT contribution and 5% fee
Expected = 100 + (100 × 0.05) = 105 USDT

User sends 105.00 → ✓ APPROVED (member created instantly)
User sends 104.99 → ✗ REJECTED (refund initiated)
User sends 105.01 → ✗ REJECTED (refund initiated)
User sends 100.00 → ✗ REJECTED (refund initiated)
```

**There is NO tolerance.** The amount must be exactly equal. This is intentional to prevent fraud and simplify accounting.

### What the Frontend Should Display at Each Payment State

| `binance_payment_status` | UI Element | Color | Message |
|--------------------------|-----------|-------|---------|
| `pending` | Spinner | Yellow/Amber | "Verifying your payment with Binance..." |
| `verified` | Checkmark | Green | "Payment confirmed! You're now a pool member." |
| `rejected` | X icon | Red | Show `refund_reason` + "Your seat has been released. Refund will be processed." |
| `refunded` | Info icon | Blue | "Refund of {amount} USDT has been processed." |

### Key Frontend Considerations

1. **Countdown Timer:** When a user joins a pool, they have `payment_window_minutes` (default 30 min) to complete payment. Show a visible countdown. When it expires, the seat is released and they must join again.

2. **Copy Buttons:** Add copy-to-clipboard for admin Binance UID and the exact payment amount. Users will switch to the Binance app and need to paste these.

3. **Exact Amount Warning:** Show a prominent warning box: "Send exactly {amount} USDT. Any different amount will be automatically rejected."

4. **Polling Strategy:** After TX ID submission, poll `GET /api/vc-pools/:id/payment-status` every 5-10 seconds. Stop polling when `binance_payment_status` changes from `pending` to `verified` or `rejected`.

5. **Error Handling:** All API errors return `{ statusCode, message, error }`. Show the `message` field to the user — it's human-readable.

6. **Route Order Matters:** The routes `payments/my-submissions`, `payments/submissions/:id`, and `payments/my-transactions` are non-parameterized and placed BEFORE the `:id` route in the backend. The frontend just needs to call the correct URLs.

7. **Auth Token:** Every request needs `Authorization: Bearer <token>` header. If 401 is returned, redirect to login.

8. **UUID Validation:** All IDs (pool_id, submission_id) are UUIDs. If an invalid format is sent, the backend returns 400 immediately.

### Admin Side (If Building Admin Dashboard)

Admins have a separate set of endpoints under `/admin/pools/`:
- See all payment submissions for their pools (with user info)
- Manually approve screenshots (for pools without Binance API auto-verification)
- Manually reject payments with a reason
- View all reservations and members

The auto-verification cron handles most Binance payments automatically. Admin manual review is only needed for screenshot-based payments or edge cases.

---

## Table of Contents

1. [User Pool APIs](#1-user-pool-apis)
   - [Get Available Pools](#11-get-available-pools)
   - [Get My Pools](#12-get-my-pools)
   - [Get Pool Details](#13-get-pool-details)
   - [Join Pool](#14-join-pool)
   - [Get Payment Status](#15-get-payment-status)
   - [Upload Screenshot](#16-upload-screenshot)
   - [Submit Binance TX ID](#17-submit-binance-tx-id)
   - [Get My Payment Submissions](#18-get-my-payment-submissions)
   - [Get Payment Submission Detail](#19-get-payment-submission-detail)
   - [Get My Transactions](#110-get-my-transactions)
   - [Cancel Membership](#111-cancel-membership)
   - [Get My Cancellation](#112-get-my-cancellation)
2. [Admin Payment APIs](#2-admin-payment-apis)
   - [List Payments](#21-list-payments)
   - [List Reservations](#22-list-reservations)
   - [List Members](#23-list-members)
   - [Approve Payment](#24-approve-payment)
   - [Reject Payment](#25-reject-payment)
3. [Automated Background Jobs](#3-automated-background-jobs)
4. [Enums & Status Values](#4-enums--status-values)
5. [Complete Payment Flow](#5-complete-payment-flow)

---

## 1. User Pool APIs

### 1.1 Get Available Pools

```
GET /api/vc-pools/available?page=1&limit=20
```

**Headers:**
```
Authorization: Bearer <jwt_token>
```

**Query Params:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| page | number | No | 1 | Page number |
| limit | number | No | 20 | Items per page |

**Success Response (200):**
```json
{
  "pools": [
    {
      "pool_id": "a1b2c3d4-...",
      "name": "BTC Growth Pool",
      "description": "Long-term BTC strategy",
      "coin_type": "USDT",
      "contribution_amount": "100.00000000",
      "max_members": 10,
      "pool_fee_percent": "5.00",
      "admin_profit_fee_percent": "20.00",
      "payment_window_minutes": 30,
      "duration_days": 90,
      "status": "open",
      "verified_members_count": 3,
      "reserved_seats_count": 1,
      "available_seats": 6,
      "created_at": "2026-03-06T10:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 5,
    "totalPages": 1
  }
}
```

**Errors:**
| Code | Message | When |
|------|---------|------|
| 401 | Unauthorized | Invalid/missing JWT token |
| 403 | Forbidden | User tier is not ELITE |

---

### 1.2 Get My Pools

```
GET /api/vc-pools/my-pools
```

**Headers:**
```
Authorization: Bearer <jwt_token>
```

**Success Response (200):**
```json
[
  {
    "pool_id": "a1b2c3d4-...",
    "pool_name": "BTC Growth Pool",
    "status": "open",
    "membership": {
      "member_id": "m1m2m3-...",
      "is_active": true,
      "invested_amount_usdt": "100.00000000",
      "share_percent": "10.00000",
      "joined_at": "2026-03-06T12:00:00.000Z"
    },
    "cancellation": null
  }
]
```

---

### 1.3 Get Pool Details

```
GET /api/vc-pools/:id
```

**Path Params:**
| Param | Type | Description |
|-------|------|-------------|
| id | UUID | Pool ID |

**Success Response (200):**
```json
{
  "pool_id": "a1b2c3d4-...",
  "name": "BTC Growth Pool",
  "description": "Long-term BTC strategy",
  "coin_type": "USDT",
  "contribution_amount": "100.00000000",
  "max_members": 10,
  "pool_fee_percent": "5.00",
  "admin_profit_fee_percent": "20.00",
  "payment_window_minutes": 30,
  "duration_days": 90,
  "status": "open",
  "verified_members_count": 3,
  "reserved_seats_count": 1,
  "created_at": "2026-03-06T10:00:00.000Z"
}
```

**Errors:**
| Code | Message | When |
|------|---------|------|
| 400 | Validation failed | Invalid UUID format |
| 404 | Pool not found | Pool doesn't exist |

---

### 1.4 Join Pool

```
POST /api/vc-pools/:id/join
```

**Path Params:**
| Param | Type | Description |
|-------|------|-------------|
| id | UUID | Pool ID |

**Request Body:**
```json
{
  "payment_method": "binance",
  "user_binance_uid": "123456789"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| payment_method | string | Yes | `"binance"` or `"stripe"` |
| user_binance_uid | string | No | User's Binance UID (max 100 chars) |

**Success Response (201) — Binance:**
```json
{
  "reservation_id": "r1r2r3-...",
  "submission_id": "s1s2s3-...",
  "total_amount": 105,
  "investment_amount": 100,
  "pool_fee_amount": 5,
  "coin": "USDT",
  "admin_binance_uid": "987654321",
  "deadline": "2026-03-06T10:30:00.000Z",
  "minutes_remaining": 30,
  "payment_method": "binance",
  "instructions": [
    "1. Open Binance → Transfer → Internal Transfer",
    "2. Enter recipient UID: 987654321",
    "3. Send exactly 105 USDT",
    "4. Take screenshot of completed transfer",
    "5. Upload screenshot before timer expires"
  ]
}
```

**Success Response (201) — Stripe:**
```json
{
  "reservation_id": "r1r2r3-...",
  "submission_id": "s1s2s3-...",
  "total_amount": 105,
  "investment_amount": 100,
  "pool_fee_amount": 5,
  "coin": "USDT",
  "deadline": "2026-03-06T10:30:00.000Z",
  "minutes_remaining": 30,
  "payment_method": "stripe",
  "message": "Join request submitted. Awaiting admin approval."
}
```

**Errors:**
| Code | Message | When |
|------|---------|------|
| 400 | Pool is not open for joining | Pool status ≠ `open` |
| 400 | Admin has not configured Binance UID | Binance method but admin has no UID |
| 400 | payment_method must be stripe or binance | Invalid payment method |
| 403 | KYC verification required | User KYC not approved |
| 404 | Pool not found | Pool doesn't exist |
| 404 | User not found | User doesn't exist |
| 409 | You are already a member of this pool | Already a member |
| 409 | You already have an active reservation | Reservation exists |
| 409 | No seats available | Pool is full |

---

### 1.5 Get Payment Status

```
GET /api/vc-pools/:id/payment-status
```

**Path Params:**
| Param | Type | Description |
|-------|------|-------------|
| id | UUID | Pool ID |

**Success Response (200):**
```json
{
  "pool_id": "a1b2c3d4-...",
  "membership": {
    "exists": false
  },
  "reservation": {
    "reservation_id": "r1r2r3-...",
    "status": "reserved",
    "expires_at": "2026-03-06T10:30:00.000Z",
    "payment_method": "binance",
    "minutes_remaining": 25
  },
  "payment": {
    "submission_id": "s1s2s3-...",
    "payment_method": "binance",
    "status": "processing",
    "total_amount": "105.00000000",
    "investment_amount": "100.00000000",
    "pool_fee_amount": "5.00000000",
    "screenshot_url": null,
    "rejection_reason": null,
    "payment_deadline": "2026-03-06T10:30:00.000Z",
    "verified_at": null
  }
}
```

**When user is already a member:**
```json
{
  "pool_id": "a1b2c3d4-...",
  "membership": {
    "exists": true,
    "is_active": true,
    "joined_at": "2026-03-06T12:00:00.000Z",
    "payment_method": "binance"
  },
  "reservation": null,
  "payment": null
}
```

**Errors:**
| Code | Message | When |
|------|---------|------|
| 404 | Pool not found | Pool doesn't exist |

---

### 1.6 Upload Screenshot

```
POST /api/vc-pools/:id/upload-screenshot
Content-Type: multipart/form-data
```

**Path Params:**
| Param | Type | Description |
|-------|------|-------------|
| id | UUID | Pool ID |

**Form Data:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| screenshot | file | Yes | Image file (jpeg, png, gif, webp). Max 10MB |

**Success Response (201):**
```json
{
  "message": "Screenshot uploaded successfully. Awaiting admin approval.",
  "submission_id": "s1s2s3-...",
  "screenshot_url": "https://res.cloudinary.com/..."
}
```

**Errors:**
| Code | Message | When |
|------|---------|------|
| 400 | Screenshot file is required | No file uploaded |
| 400 | Only image files (jpeg, png, gif, webp) are allowed | Wrong file type |
| 400 | Reservation is expired/released, not eligible | Reservation not active |
| 400 | Reservation has expired. Please join again. | Timer expired |
| 400 | Screenshot upload is only for Binance payments | Non-binance payment |
| 400 | Payment is processing/verified, cannot upload screenshot | Already processing |
| 404 | No reservation found for this pool | No reservation |
| 404 | Payment submission not found | No submission |

---

### 1.7 Submit Binance TX ID

> **NEW — Binance P2P Exact-Match Payment**

```
POST /api/vc-pools/:id/submit-binance-tx
```

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
| binance_tx_id | string | Yes | max 255 chars | Binance P2P order/transaction ID |
| binance_tx_timestamp | string (ISO) | Yes | ISO 8601 date | When the transaction was made on Binance |

> Note: `pool_id` comes from the URL path param `:id`

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

**Errors:**
| Code | Error | Message | When |
|------|-------|---------|------|
| 400 | BadRequestException | `binance_tx_id is required` | Empty or missing TX ID |
| 400 | BadRequestException | `binance_tx_timestamp must be a valid ISO date string` | Invalid date format |
| 400 | BadRequestException | `Seat reservation is {status}, cannot submit payment` | Reservation not in `reserved` state |
| 400 | BadRequestException | `Reservation has expired. Please join the pool again.` | Reservation timer expired |
| 400 | BadRequestException | `Payment is already {status}. Cannot update TX ID.` | Payment not in `pending` state |
| 404 | NotFoundException | `No reservation found for this pool` | User has no reservation |
| 404 | NotFoundException | `No payment submission found for this reservation` | No pending payment |
| 404 | NotFoundException | `Pool not found` | Pool doesn't exist |
| 409 | ConflictException | `This Binance TX ID has already been used` | TX ID used by another submission |

**Flow:**
1. User calls `POST /:id/join` with `payment_method: "binance"` → gets `reservation_id` + `submission_id`
2. User makes payment on Binance P2P
3. User calls `POST /:id/submit-binance-tx` with the TX ID
4. Backend updates submission to `processing` status
5. Cron job (every 5 min) verifies with Binance API
6. If exact match → `verified` (user becomes member)
7. If amount mismatch → `rejected` (refund initiated)

---

### 1.8 Get My Payment Submissions

```
GET /api/vc-pools/payments/my-submissions
```

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
  },
  {
    "submission_id": "x1y2z3-...",
    "pool_id": "p1p2p3-...",
    "pool_name": "ETH Swing Pool",
    "coin_type": "USDT",
    "payment_method": "binance",
    "total_amount": "210.00000000",
    "investment_amount": "200.00000000",
    "pool_fee_amount": "10.00000000",
    "binance_tx_id": "TX55566677788",
    "status": "verified",
    "binance_payment_status": "verified",
    "exact_amount_expected": "210.00000000",
    "exact_amount_received": "210.00000000",
    "refund_reason": null,
    "rejection_reason": null,
    "verified_at": "2026-03-06T10:10:00.000Z",
    "submitted_at": "2026-03-06T10:00:00.000Z",
    "payment_deadline": "2026-03-06T10:30:00.000Z"
  }
]
```

**Rejected submission example:**
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

### 1.9 Get Payment Submission Detail

```
GET /api/vc-pools/payments/submissions/:submissionId
```

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

### 1.10 Get My Transactions

```
GET /api/vc-pools/payments/my-transactions
```

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

**Max results:** 50 (most recent)

---

### 1.11 Cancel Membership

```
POST /api/vc-pools/:id/cancel-membership
```

**Path Params:**
| Param | Type | Description |
|-------|------|-------------|
| id | UUID | Pool ID |

**Success Response (201):**
```json
{
  "message": "Cancellation request submitted",
  "cancellation_id": "c1c2c3-...",
  "refund_amount": "95.00000000",
  "fee_amount": "5.00000000",
  "status": "pending"
}
```

**Errors:**
| Code | Message | When |
|------|---------|------|
| 404 | Pool not found | Pool doesn't exist |
| 400 | Not an active member | No active membership |
| 409 | Cancellation already exists | Already requested cancellation |

---

### 1.12 Get My Cancellation

```
GET /api/vc-pools/:id/my-cancellation
```

**Path Params:**
| Param | Type | Description |
|-------|------|-------------|
| id | UUID | Pool ID |

**Success Response (200):**
```json
{
  "cancellation_id": "c1c2c3-...",
  "status": "pending",
  "invested_amount": "100.00000000",
  "refund_amount": "95.00000000",
  "fee_amount": "5.00000000",
  "requested_at": "2026-03-06T14:00:00.000Z",
  "reviewed_at": null,
  "rejection_reason": null
}
```

---

## 2. Admin Payment APIs

> **Base URL:** `/admin/pools`
> 
> **Auth:** Admin JWT token required (`AdminJwtAuthGuard`)

### 2.1 List Payments

```
GET /admin/pools/:poolId/payments?status=pending&payment_method=binance&page=1&limit=20
```

**Path Params:**
| Param | Type | Description |
|-------|------|-------------|
| poolId | UUID | Pool ID |

**Query Params:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| status | string | No | Filter: `pending`, `processing`, `verified`, `rejected`, `expired` |
| payment_method | string | No | Filter: `binance`, `stripe` |
| page | number | No | Page number (default: 1) |
| limit | number | No | Items per page (default: 20, max: 50) |

**Success Response (200):**
```json
{
  "submissions": [
    {
      "submission_id": "s1s2s3-...",
      "pool_id": "a1b2c3d4-...",
      "user_id": "u1u2u3-...",
      "reservation_id": "r1r2r3-...",
      "payment_method": "binance",
      "investment_amount": "100.00000000",
      "pool_fee_amount": "5.00000000",
      "total_amount": "105.00000000",
      "status": "processing",
      "binance_tx_id": "TX98765432100123",
      "binance_payment_status": "pending",
      "exact_amount_expected": "105.00000000",
      "exact_amount_received": null,
      "screenshot_url": "https://res.cloudinary.com/...",
      "rejection_reason": null,
      "verified_at": null,
      "submitted_at": "2026-03-06T10:00:00.000Z",
      "payment_deadline": "2026-03-06T10:30:00.000Z",
      "user": {
        "user_id": "u1u2u3-...",
        "email": "user@example.com",
        "username": "trader123"
      },
      "reservation": {
        "status": "reserved",
        "expires_at": "2026-03-06T10:30:00.000Z"
      }
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 3,
    "totalPages": 1
  }
}
```

**Errors:**
| Code | Message | When |
|------|---------|------|
| 403 | You do not own this pool | Admin doesn't own this pool |
| 404 | Pool not found | Pool doesn't exist |

---

### 2.2 List Reservations

```
GET /admin/pools/:poolId/reservations
```

**Success Response (200):**
```json
{
  "reservations": [
    {
      "reservation_id": "r1r2r3-...",
      "pool_id": "a1b2c3d4-...",
      "user_id": "u1u2u3-...",
      "payment_method": "binance",
      "status": "reserved",
      "reserved_at": "2026-03-06T10:00:00.000Z",
      "expires_at": "2026-03-06T10:30:00.000Z",
      "user": {
        "user_id": "u1u2u3-...",
        "email": "user@example.com",
        "username": "trader123"
      }
    }
  ]
}
```

---

### 2.3 List Members

```
GET /admin/pools/:poolId/members
```

**Success Response (200):**
```json
{
  "members": [
    {
      "member_id": "m1m2m3-...",
      "pool_id": "a1b2c3d4-...",
      "user_id": "u1u2u3-...",
      "payment_method": "binance",
      "invested_amount_usdt": "100.00000000",
      "share_percent": "10.00000",
      "user_binance_uid": "123456789",
      "is_active": true,
      "joined_at": "2026-03-06T12:00:00.000Z",
      "exited_at": null,
      "user": {
        "user_id": "u1u2u3-...",
        "email": "user@example.com",
        "username": "trader123"
      }
    }
  ]
}
```

---

### 2.4 Approve Payment

```
PUT /admin/pools/:poolId/payments/:submissionId/approve
```

**Path Params:**
| Param | Type | Description |
|-------|------|-------------|
| poolId | UUID | Pool ID |
| submissionId | UUID | Payment submission ID |

**Request Body:**
```json
{
  "admin_notes": "Verified payment screenshot manually"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| admin_notes | string | No | Optional admin notes |

**Success Response (200):**
```json
{
  "message": "Payment approved. User is now a pool member.",
  "submission_id": "s1s2s3-...",
  "member_id": "m1m2m3-...",
  "status": "verified"
}
```

**Side Effects:**
- Payment submission → `verified`
- Reservation → `confirmed`
- New pool member created
- Pool `verified_members_count` incremented
- Pool `reserved_seats_count` decremented
- If all seats filled → pool status changes to `full`

**Errors:**
| Code | Message | When |
|------|---------|------|
| 400 | Payment is {status}, only 'processing' submissions can be approved | Status ≠ `processing` |
| 403 | You do not own this pool | Not the pool owner |
| 404 | Pool not found | Pool doesn't exist |
| 404 | Payment submission not found | Submission not in this pool |

---

### 2.5 Reject Payment

```
PUT /admin/pools/:poolId/payments/:submissionId/reject
```

**Path Params:**
| Param | Type | Description |
|-------|------|-------------|
| poolId | UUID | Pool ID |
| submissionId | UUID | Payment submission ID |

**Request Body:**
```json
{
  "rejection_reason": "Screenshot does not match the expected amount"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| rejection_reason | string | **Yes** | Reason for rejection (max 500 chars) |

**Success Response (200):**
```json
{
  "message": "Payment rejected. Seat has been released.",
  "submission_id": "s1s2s3-...",
  "status": "rejected"
}
```

**Side Effects:**
- Payment submission → `rejected`
- Reservation → `released`
- Pool `reserved_seats_count` decremented

**Errors:**
| Code | Message | When |
|------|---------|------|
| 400 | rejection_reason is required | Missing reason |
| 400 | Payment is {status}, only 'processing' submissions can be rejected | Status ≠ `processing` |
| 403 | You do not own this pool | Not the pool owner |
| 404 | Pool not found | Pool doesn't exist |
| 404 | Payment submission not found | Submission not in this pool |

---

## 3. Automated Background Jobs

### 3.1 Payment Verification Cron (Every 5 Minutes)

> **Not an API** — runs automatically in the backend

**What it does:**
1. Finds all `vc_pool_payment_submissions` where `binance_payment_status = pending` AND `binance_tx_id IS NOT NULL` AND `payment_method = binance`
2. For each, queries Binance P2P API with the TX ID
3. Compares actual amount vs expected amount (exact match)
4. If **exact match** → approves payment, creates member
5. If **any variance** → rejects payment, initiates refund

**Approval actions (exact match):**
- `vc_pool_payment_submissions.status` → `verified`
- `vc_pool_payment_submissions.binance_payment_status` → `verified`
- `vc_pool_seat_reservations.status` → `confirmed`
- Creates `vc_pool_members` record
- Increments `vc_pools.verified_members_count`
- Decrements `vc_pools.reserved_seats_count`
- Creates `vc_pool_transactions` audit log

**Rejection actions (any variance):**
- `vc_pool_payment_submissions.status` → `rejected`
- `vc_pool_payment_submissions.binance_payment_status` → `rejected`
- `vc_pool_seat_reservations.status` → `released`
- Sets `refund_reason` and `refund_initiated_at`
- Decrements `vc_pools.reserved_seats_count`
- Creates `vc_pool_transactions` audit log

### 3.2 Seat Expiry Cron (Every 30 Seconds)

Expires reservations where `expires_at < now()` and releases seats.

---

## 4. Enums & Status Values

### Payment Submission Status (`PaymentSubmissionStatus`)
| Value | Description |
|-------|-------------|
| `pending` | Submitted, awaiting TX ID or screenshot |
| `processing` | TX ID/screenshot uploaded, awaiting verification |
| `verified` | Payment confirmed, member created |
| `rejected` | Payment rejected |
| `expired` | Reservation timer ran out |

### Binance Payment Status (`BinancePaymentStatus`)
| Value | Description |
|-------|-------------|
| `pending` | TX ID submitted, waiting for Binance API verification |
| `verified` | Binance confirmed exact match |
| `rejected` | Amount mismatch detected |
| `refunded` | Refund has been processed |

### Seat Reservation Status (`SeatReservationStatus`)
| Value | Description |
|-------|-------------|
| `reserved` | Seat held, awaiting payment |
| `confirmed` | Payment verified, seat secured |
| `released` | Released (rejection or cancellation) |
| `expired` | Timer expired without payment |

### Payment Method (`VcPaymentMethod`)
| Value | Description |
|-------|-------------|
| `binance` | Binance P2P transfer (USD) |
| `stripe` | Stripe payment |

### Transaction Types (in `vc_pool_transactions`)
| Value | Description |
|-------|-------------|
| `payment_submitted` | User submitted Binance TX ID |
| `payment_verified` | Exact match confirmed |
| `payment_rejected` | Amount mismatch |
| `refund_initiated` | Refund sent to user |
| `member_created` | Pool membership created |

---

## 5. Complete Payment Flow

```
Step 1: JOIN POOL
──────────────────────────────────────────────
POST /api/vc-pools/:poolId/join
Body: { "payment_method": "binance" }
Response: { reservation_id, submission_id, total_amount, admin_binance_uid, instructions }

         ↓ User sees the exact amount + admin Binance UID

Step 2: PAY ON BINANCE
──────────────────────────────────────────────
User opens Binance → P2P → sends exact amount to admin UID
Binance provides TX ID automatically

         ↓ User copies TX ID

Step 3: SUBMIT TX ID
──────────────────────────────────────────────
POST /api/vc-pools/:poolId/submit-binance-tx
Body: { "binance_tx_id": "TX123...", "binance_tx_timestamp": "2026-..." }
Response: { submission_id, exact_amount_expected, status: "processing" }

         ↓ Backend queues for verification

Step 4: AUTO-VERIFICATION (every 5 minutes)
──────────────────────────────────────────────
Cron queries Binance API with TX ID
Compares: actual_amount === exact_amount_expected

         ↓    ┌─── EXACT MATCH ──→ APPROVED (member created)
              └─── ANY VARIANCE ──→ REJECTED (refund initiated)

Step 5: CHECK STATUS
──────────────────────────────────────────────
GET /api/vc-pools/:poolId/payment-status
   OR
GET /api/vc-pools/payments/my-submissions

Response includes: status, binance_payment_status, exact_amount_received, refund_reason
```

### Example: Successful Payment
```
1. User joins pool → total_amount = 105 USDT
2. User sends exactly 105 USDT on Binance P2P
3. User submits TX ID → status = "processing"
4. Cron verifies: received 105.00 = expected 105.00 ✓
5. Status → "verified", user is now a pool member
```

### Example: Failed Payment (Amount Mismatch)
```
1. User joins pool → total_amount = 105 USDT
2. User accidentally sends 104.99 USDT on Binance
3. User submits TX ID → status = "processing"
4. Cron verifies: received 104.99 ≠ expected 105.00 ✗
5. Status → "rejected", refund_reason = "Shortfall: received 104.99 instead of 105.00"
6. Seat released, user must join again with correct amount
```

---

## Global Error Format

All errors follow this format:
```json
{
  "statusCode": 400,
  "message": "Error description here",
  "error": "Bad Request"
}
```

| HTTP Code | Error Type | Common Causes |
|-----------|-----------|---------------|
| 400 | Bad Request | Validation failure, invalid state |
| 401 | Unauthorized | Missing/expired JWT token |
| 403 | Forbidden | Wrong tier, not pool owner |
| 404 | Not Found | Resource doesn't exist |
| 409 | Conflict | Duplicate TX ID, already a member |
| 500 | Internal Server Error | Unexpected server error |
