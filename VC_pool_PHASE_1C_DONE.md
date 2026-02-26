# VC Pool — Sub-Phase 1C: COMPLETED ✅

**Phase:** 1C — Joining + Seat Reservation + Payments
**Completed:** February 26, 2026
**Depends on:** Phase 1B (pools must exist and be open)
**Build status:** `tsc --noEmit` — 0 errors | `nest build` — 0 errors

---

## Summary

Phase 1C implements the complete user join flow, seat reservation system, Binance screenshot upload with Cloudinary, admin payment review (approve/reject), auto pool-full transition, and a seat expiry scheduler.

---

## Files Created / Modified

### New Files (7)

| File | Purpose |
|---|---|
| `src/modules/vc-pool/dto/join-pool.dto.ts` | Validates `payment_method` (stripe/binance) + optional `user_binance_uid` |
| `src/modules/vc-pool/services/seat-reservation.service.ts` | Join flow, eligibility checks, seat reservation, payment submission, payment status |
| `src/modules/vc-pool/services/screenshot-upload.service.ts` | Validates reservation + uploads screenshot to Cloudinary |
| `src/modules/vc-pool/services/payment-review.service.ts` | Admin: list payments/reservations/members, approve, reject |
| `src/modules/vc-pool/controllers/admin-pool-payments.controller.ts` | 5 admin endpoints for payment management |
| `src/modules/vc-pool/schedulers/seat-expiry.scheduler.ts` | Cron job every 30s — expires stale reservations |
| (this file) `VC_pool_PHASE_1C_DONE.md` | Documentation |

### Modified Files (2)

| File | Change |
|---|---|
| `src/modules/vc-pool/controllers/user-pool.controller.ts` | Added 3 new endpoints: join, upload-screenshot, payment-status |
| `src/modules/vc-pool/vc-pool.module.ts` | Imported `StorageModule`, `ScheduleModule`; registered new services, controllers, scheduler |

---

## API Endpoints

### User Endpoints (require JWT + ELITE tier)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/vc-pools/:id/join` | Reserve seat + select payment method |
| `GET` | `/api/vc-pools/:id/payment-status` | Check reservation + payment status |
| `POST` | `/api/vc-pools/:id/upload-screenshot` | Upload Binance payment screenshot (multipart) |

### Admin Endpoints (require admin JWT)

| Method | Path | Description |
|---|---|---|
| `GET` | `/admin/pools/:poolId/payments` | List payment submissions (filterable: `?status=`, `?payment_method=`, `?page=`, `?limit=`) |
| `GET` | `/admin/pools/:poolId/reservations` | List seat reservations |
| `GET` | `/admin/pools/:poolId/members` | List pool members |
| `PUT` | `/admin/pools/:poolId/payments/:submissionId/approve` | Approve payment → create member |
| `PUT` | `/admin/pools/:poolId/payments/:submissionId/reject` | Reject payment → release seat |

---

## Endpoint Details & Responses

### POST /api/vc-pools/:id/join

**Request:**
```json
{
  "payment_method": "binance",
  "user_binance_uid": "USER_BIN_123"
}
```

**Response (binance — 201):**
```json
{
  "reservation_id": "f661ad25-...",
  "submission_id": "107f94f9-...",
  "total_amount": 105,
  "investment_amount": 100,
  "pool_fee_amount": 5,
  "coin": "USDT",
  "admin_binance_uid": "TEST_BINANCE_UID_123",
  "deadline": "2026-02-27T00:02:42.000Z",
  "minutes_remaining": 29,
  "payment_method": "binance",
  "instructions": [
    "1. Open Binance → Transfer → Internal Transfer",
    "2. Enter recipient UID: TEST_BINANCE_UID_123",
    "3. Send exactly 105 USDT",
    "4. Take screenshot of completed transfer",
    "5. Upload screenshot before timer expires"
  ]
}
```

**Response (stripe bypass — 201):**
```json
{
  "reservation_id": "...",
  "submission_id": "...",
  "total_amount": 105,
  "investment_amount": 100,
  "pool_fee_amount": 5,
  "coin": "USDT",
  "deadline": "...",
  "minutes_remaining": 29,
  "payment_method": "stripe",
  "message": "Join request submitted. Awaiting admin approval."
}
```

### GET /api/vc-pools/:id/payment-status

**Response (200):**
```json
{
  "pool_id": "...",
  "membership": { "exists": false },
  "reservation": {
    "reservation_id": "...",
    "status": "reserved",
    "expires_at": "...",
    "payment_method": "binance",
    "minutes_remaining": 28
  },
  "payment": {
    "submission_id": "...",
    "payment_method": "binance",
    "status": "pending",
    "total_amount": "105.00000000",
    "investment_amount": "100.00000000",
    "pool_fee_amount": "5.00000000",
    "screenshot_url": null,
    "rejection_reason": null,
    "payment_deadline": "...",
    "verified_at": null
  }
}
```

### POST /api/vc-pools/:id/upload-screenshot

**Request:** `multipart/form-data` with field `screenshot` (image file, max 10MB)

**Response (201):**
```json
{
  "message": "Screenshot uploaded successfully. Awaiting admin approval.",
  "submission_id": "...",
  "screenshot_url": "https://res.cloudinary.com/.../quantiva/vc-pool/payment-screenshots/..."
}
```

### PUT /admin/pools/:poolId/payments/:submissionId/approve

**Response (200):**
```json
{
  "message": "Payment approved. User is now a pool member.",
  "submission_id": "...",
  "member_id": "...",
  "status": "verified"
}
```

### PUT /admin/pools/:poolId/payments/:submissionId/reject

**Request:**
```json
{ "rejection_reason": "Screenshot unclear" }
```

**Response (200):**
```json
{
  "message": "Payment rejected. Seat has been released.",
  "submission_id": "...",
  "status": "rejected"
}
```

---

## Test Results

### Test Suite 1: Core Flow (30 tests)

| # | Test | Expected | Actual | Result |
|---|---|---|---|---|
| 1 | Seed test admin | 200 | 200 | ✅ |
| 2 | Admin login | 200 | 200 | ✅ |
| 3 | Set User1 ELITE | 200 | 200 | ✅ |
| 4 | Set User2 ELITE | 200 | 200 | ✅ |
| 5 | Create pool | 201 | 201 | ✅ |
| 6 | Publish pool | 200 | 200 | ✅ |
| 7 | Join without auth | 401 | 401 | ✅ |
| 8 | User1 join (binance) | 201 | 201 | ✅ |
| 9 | Duplicate join | 409 | 409 | ✅ |
| 10 | Payment status | 200 | 200 | ✅ |
| 11 | Upload without file | 400 | 400 | ✅ |
| 12 | Upload screenshot (Cloudinary) | 201 | 201 | ✅ |
| 13 | Admin list payments | 200 | 200 | ✅ |
| 14 | Admin list reservations | 200 | 200 | ✅ |
| 15 | Admin list members (empty) | 200 | 200 | ✅ |
| 16 | Admin approve binance (after screenshot) | 200 | 200 | ✅ |
| 17 | Admin reject already-approved | 400 | 400 | ✅ |
| 18 | Admin payments no auth | 401 | 401 | ✅ |
| 19 | User2 join (stripe bypass) | 201 | 201 | ✅ |
| 20 | Admin approve stripe | 200 | 200 | ✅ |
| 21 | Admin list members (2 members) | 200 | 200 | ✅ |
| 22 | Pool status = full | 200 | 200 | ✅ |
| 29 | Filter payments by status | 200 | 200 | ✅ |
| 30 | Filter payments by method | 200 | 200 | ✅ |

### Test Suite 2: Full Pool + Edge Cases (13 tests)

| # | Test | Expected | Actual | Result |
|---|---|---|---|---|
| 1 | Create pool (max=2) | 201 | 201 | ✅ |
| 2 | User1 join (stripe) | 201 | 201 | ✅ |
| 3 | User2 join (stripe) | 201 | 201 | ✅ |
| 4 | Pool open, reserved=2 | 200 | 200 | ✅ |
| 5 | Approve User1 | 200 | 200 | ✅ |
| 6 | Approve User2 → auto-full | 200 | 200 | ✅ |
| 7 | Pool auto-transitioned to 'full' | full | full | ✅ |
| 8 | Pool has exactly 2 members | 2 | 2 | ✅ |
| 9 | Join full pool → rejected | 400 | 400 | ✅ |
| 10 | Available pools list | 200 | 200 | ✅ |
| 11 | User1 join pool3 (stripe) | 201 | 201 | ✅ |
| 12 | Admin reject submission | 200 | 200 | ✅ |
| 13 | Re-join after rejection | 201 | 201 | ✅ |

**Total: 43 tests | 43 passed | 0 failed**

---

## Business Logic Verified

### Join Flow
- ✅ ELITE tier + KYC approved required
- ✅ Pool must be `open` status
- ✅ Seat availability checked (max - reserved - verified)
- ✅ Atomic transaction: reservation + submission created together
- ✅ Payment calculated: `contribution_amount + (contribution × pool_fee_percent / 100)`
- ✅ Binance: returns admin UID + instructions + timer
- ✅ Stripe (Phase 1 bypass): returns awaiting-approval message

### Screenshot Upload
- ✅ Only for binance payment method
- ✅ Reservation must be active and not expired
- ✅ Submission status moves: `pending` → `processing` after upload
- ✅ Cloudinary upload with folder `quantiva/vc-pool/payment-screenshots`
- ✅ Image validation (jpeg, png, gif, webp only, max 10MB)

### Admin Approve/Reject
- ✅ Only `processing` submissions can be approved/rejected
- ✅ Approve: creates member, confirms reservation, decrements reserved, increments verified
- ✅ Reject: releases seat, decrements reserved, records reason
- ✅ Pool auto-transitions to `full` when verified_members_count === max_members
- ✅ Ownership validation: admin must own the pool

### Re-join After Rejection
- ✅ Stale reservations and linked submissions are cleaned up
- ✅ User can re-join after rejection with fresh reservation

### Seat Expiry Scheduler
- ✅ Runs every 30 seconds via `@nestjs/schedule` Cron
- ✅ Expires reservations where `status = 'reserved'` and `expires_at < NOW()`
- ✅ Decrements `reserved_seats_count` on pool
- ✅ Also expires linked payment submissions (pending/processing)
- ✅ Mutex prevents concurrent runs

---

## Infrastructure Reused

| Component | From | Usage |
|---|---|---|
| `CloudinaryService` | `src/storage/cloudinary.service.ts` | Screenshot upload to Cloudinary |
| `StorageModule` | `src/storage/storage.module.ts` | Provides CloudinaryService |
| `@nestjs/schedule` Cron | Already in `app.module.ts` | Seat expiry scheduler |
| `FileInterceptor` + `memoryStorage` | Pattern from KYC controller | Multer file upload handling |
| `KYC check` | Inline via `prisma.users.findUnique` | Verifies `kyc_status === 'approved'` |

---

## Module Structure After Phase 1C

```
src/modules/vc-pool/
├── controllers/
│   ├── admin-pool.controller.ts         # Pool CRUD (Phase 1B)
│   ├── admin-pool-payments.controller.ts # Payment review (Phase 1C) ← NEW
│   └── user-pool.controller.ts          # Browse + Join + Upload (1B + 1C)
├── dto/
│   ├── create-pool.dto.ts               # Phase 1B
│   ├── update-pool.dto.ts               # Phase 1B
│   └── join-pool.dto.ts                 # Phase 1C ← NEW
├── services/
│   ├── pool-management.service.ts       # Phase 1B
│   ├── seat-reservation.service.ts      # Phase 1C ← NEW
│   ├── screenshot-upload.service.ts     # Phase 1C ← NEW
│   └── payment-review.service.ts        # Phase 1C ← NEW
├── schedulers/
│   └── seat-expiry.scheduler.ts         # Phase 1C ← NEW
└── vc-pool.module.ts                    # Updated
```

---

## Bug Fix During Development

**Issue:** Re-join after rejection caused a 500 error due to a foreign key constraint.

**Root cause:** When a user's payment was rejected, the old reservation had status `released` but the linked `vc_pool_payment_submissions` record still referenced it. When the user tried to re-join, deleting the old reservation failed because of the foreign key.

**Fix:** Added `tx.vc_pool_payment_submissions.deleteMany()` before deleting the stale reservation in `seat-reservation.service.ts`, ensuring all linked submissions are cleaned up first.

---

## Next Phase: 1D — Pool Trading + Value Tracking

Phase 1D adds:
- `PUT /admin/pools/:id/start` — full → active transition
- `POST /admin/pools/:id/trades` — manual trade entry
- `GET /admin/pools/:id/trades` — list pool trades
- `PUT /admin/pools/:id/trades/:tid/close` — close trade with PnL
- Pool value auto-update after trades
