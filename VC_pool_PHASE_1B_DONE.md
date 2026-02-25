# VC Pool — Phase 1B Complete: Pool Management + User Browse

**Status:** IMPLEMENTED & VERIFIED (all 16 tests pass)
**Build:** Zero TypeScript errors, zero linter errors

---

## What Was Done

### 1. VC Pool Module

Created `src/modules/vc-pool/` — the core pool management module with admin CRUD and user browse.

**Files created:**

```
src/modules/vc-pool/
├── vc-pool.module.ts                    # Module wiring
├── controllers/
│   ├── admin-pool.controller.ts         # 6 admin endpoints
│   └── user-pool.controller.ts          # 2 user browse endpoints
├── services/
│   └── pool-management.service.ts       # All pool CRUD + browse logic
└── dto/
    ├── create-pool.dto.ts               # Pool creation validation
    └── update-pool.dto.ts               # Pool edit validation (all optional)
```

### 2. App Module Registration

`VcPoolModule` registered in `app.module.ts` imports array.

### 3. Bug Fix: TierAccessGuard Scope

During testing, discovered that `@AllowTier('ELITE')` applied at **class level** was not detected by the existing `TierAccessGuard` (which only checks `context.getHandler()`). Fixed by applying `@AllowTier('ELITE')` at **method level** on each endpoint, consistent with how the strategies controller uses it.

---

## API Endpoints — Admin Pool Management

Base URL: `http://localhost:<PORT>/admin/pools`
**Auth required:** Admin JWT (`Authorization: Bearer <admin_access_token>`)

---

### POST `/admin/pools` — Create Draft Pool

Creates a new pool in `draft` status. Fees default to admin's configured defaults if not provided.

```json
// Request
{
  "name": "BTC Alpha Fund",
  "description": "Bitcoin trading pool for Q1 2026",
  "coin_type": "USDT",
  "contribution_amount": 100,
  "max_members": 5,
  "duration_days": 30,
  "pool_fee_percent": 5,
  "admin_profit_fee_percent": 20,
  "cancellation_fee_percent": 5,
  "payment_window_minutes": 30
}

// Response 201
{
  "pool_id": "3ead86cb-5f81-4ad0-b596-f0537b76c595",
  "admin_id": "285b2741-c559-4ed9-ae76-5105787363fb",
  "name": "BTC Alpha Fund",
  "description": "Bitcoin trading pool for Q1 2026",
  "coin_type": "USDT",
  "contribution_amount": "100",
  "max_members": 5,
  "pool_fee_percent": "5",
  "admin_profit_fee_percent": "20",
  "cancellation_fee_percent": "5",
  "payment_window_minutes": 30,
  "duration_days": 30,
  "status": "draft",
  "started_at": null,
  "end_date": null,
  "is_replica": false,
  "original_pool_id": null,
  "verified_members_count": 0,
  "reserved_seats_count": 0,
  "total_invested_usdt": null,
  "current_pool_value_usdt": null,
  "total_profit_usdt": null,
  "total_pool_fees_usdt": null,
  "admin_fee_earned_usdt": null,
  "is_archived": false,
  "created_at": "2026-02-25T19:25:34.900Z",
  "updated_at": "2026-02-25T19:25:34.900Z",
  "completed_at": null,
  "cancelled_at": null
}
```

**Required fields:** `name`, `contribution_amount` (min 0.00000001), `max_members` (min 2), `duration_days` (min 1)

**Optional fields (default to admin settings):** `pool_fee_percent`, `admin_profit_fee_percent`, `cancellation_fee_percent`, `payment_window_minutes`

---

### GET `/admin/pools` — List Admin's Pools

Returns paginated list of admin's pools with optional status filter.

```
GET /admin/pools?status=draft&page=1&limit=20
```

```json
// Response 200
{
  "pools": [
    {
      "pool_id": "efed0784-6c6d-48a4-b42e-24382d53f8ce",
      "name": "BTC Alpha Fund v2 (Copy)",
      "status": "draft",
      "coin_type": "USDT",
      "contribution_amount": "200",
      "max_members": 10,
      "verified_members_count": 0,
      "reserved_seats_count": 0,
      "duration_days": 30,
      "pool_fee_percent": "5",
      "is_replica": true,
      "started_at": null,
      "end_date": null,
      "total_invested_usdt": null,
      "current_pool_value_usdt": null,
      "total_profit_usdt": null,
      "created_at": "2026-02-25T19:25:39.620Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 1,
    "totalPages": 1
  }
}
```

**Query params:** `status` (draft|open|full|active|completed|cancelled), `page`, `limit` (max 50)

---

### GET `/admin/pools/:id` — Pool Details

Returns full pool details with relation counts.

```json
// Response 200
{
  "pool_id": "3ead86cb-...",
  "admin_id": "285b2741-...",
  "name": "BTC Alpha Fund v2",
  "description": "Bitcoin trading pool for Q1 2026",
  "status": "open",
  "contribution_amount": "200",
  "max_members": 10,
  "pool_fee_percent": "5",
  "admin_profit_fee_percent": "20",
  "cancellation_fee_percent": "5",
  "payment_window_minutes": 30,
  "duration_days": 30,
  "verified_members_count": 0,
  "reserved_seats_count": 0,
  "_count": {
    "members": 0,
    "seat_reservations": 0,
    "trades": 0
  },
  "...": "all other pool fields"
}
```

---

### PUT `/admin/pools/:id` — Edit Draft Pool

Update any pool field. **Only works on `draft` status pools.**

```json
// Request (all fields optional)
{
  "name": "BTC Alpha Fund v2",
  "contribution_amount": 200,
  "max_members": 10
}

// Response 200 — updated pool object
```

**Error cases:**
- 404 — Pool not found
- 403 — Pool belongs to different admin
- 400 — "Only draft pools can be edited" (if pool is not `draft`)

---

### PUT `/admin/pools/:id/publish` — Publish Pool (draft → open)

Transitions pool from `draft` to `open`, making it visible to ELITE users.

```json
// Response 200 — pool with status: "open"
{
  "pool_id": "3ead86cb-...",
  "status": "open",
  "...": "all pool fields"
}
```

**Validations before publish:**
- Pool must be in `draft` status
- Pool must belong to current admin
- `name`, `contribution_amount`, `max_members`, `duration_days` must be set
- Admin must have `binance_uid` configured in settings

**Error cases:**
- 400 — "Only draft pools can be published"
- 400 — "Pool must have name, contribution_amount, max_members, and duration_days set"
- 400 — "You must configure your Binance UID in admin settings before publishing"

---

### POST `/admin/pools/:id/clone` — Clone Pool

Creates a copy of any pool (any status) as a new `draft`.

```json
// Response 201
{
  "pool_id": "efed0784-...",
  "name": "BTC Alpha Fund v2 (Copy)",
  "status": "draft",
  "is_replica": true,
  "original_pool_id": "3ead86cb-...",
  "verified_members_count": 0,
  "reserved_seats_count": 0,
  "...": "all copied settings"
}
```

**Copies:** name + " (Copy)", description, coin_type, contribution_amount, max_members, duration_days, all fees, payment_window_minutes

**Resets:** status = draft, counters = 0, dates = null

---

## API Endpoints — User Pool Browse

Base URL: `http://localhost:<PORT>/api/vc-pools`
**Auth required:** User JWT (`Authorization: Bearer <user_access_token>`)
**Tier required:** ELITE only — FREE and PRO users get 403

---

### GET `/api/vc-pools/available` — Browse Open Pools

Returns paginated list of `open` (non-archived) pools visible to ELITE users.

```json
// Response 200
{
  "pools": [
    {
      "pool_id": "3ead86cb-5f81-4ad0-b596-f0537b76c595",
      "name": "BTC Alpha Fund v2",
      "description": "Bitcoin trading pool for Q1 2026",
      "coin_type": "USDT",
      "contribution_amount": "200",
      "max_members": 10,
      "available_seats": 10,
      "duration_days": 30,
      "pool_fee_percent": "5",
      "payment_window_minutes": 30,
      "admin_binance_uid": "12345678",
      "created_at": "2026-02-25T19:25:34.900Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 1,
    "totalPages": 1
  }
}
```

**Computed fields:**
- `available_seats` = max_members - reserved_seats_count - verified_members_count
- `admin_binance_uid` — shown so users know where to send Binance transfers

---

### GET `/api/vc-pools/:id` — Pool Details

Returns details for a specific pool (any non-draft status).

```json
// Response 200
{
  "pool_id": "3ead86cb-5f81-4ad0-b596-f0537b76c595",
  "name": "BTC Alpha Fund v2",
  "description": "Bitcoin trading pool for Q1 2026",
  "coin_type": "USDT",
  "contribution_amount": "200",
  "max_members": 10,
  "verified_members_count": 0,
  "reserved_seats_count": 0,
  "duration_days": 30,
  "pool_fee_percent": "5",
  "payment_window_minutes": 30,
  "status": "open",
  "started_at": null,
  "end_date": null,
  "created_at": "2026-02-25T19:25:34.900Z",
  "available_seats": 10,
  "admin_binance_uid": "12345678"
}
```

**Draft pools return 404** — users cannot see unpublished pools.

---

## Test Results (All 16 Pass)

### Admin Endpoint Tests

| # | Test | Result |
|---|---|---|
| 1 | `POST /admin/pools` — create draft pool | PASS — Pool created with status `draft`, fees default from admin settings |
| 2 | `GET /admin/pools` — list pools | PASS — Returns paginated list with pool summaries |
| 3 | `GET /admin/pools/:id` — pool details | PASS — Full pool with `_count` for members, reservations, trades |
| 4 | `PUT /admin/pools/:id` — edit draft | PASS — Updated name, contribution_amount, max_members |
| 5 | `PUT /admin/pools/:id/publish` — draft → open | PASS — Status changed to `open` |
| 6 | `PUT /admin/pools/:id` — edit after publish | PASS — Blocked with 400 "Only draft pools can be edited" |
| 7 | `POST /admin/pools/:id/clone` — clone pool | PASS — New draft with `is_replica: true`, `original_pool_id` set |
| 8 | `GET /admin/pools?status=draft` — filter by status | PASS — Returns only draft pools |

### User Endpoint Tests

| # | Test | Result |
|---|---|---|
| 9–10 | No auth → `/api/vc-pools/*` | PASS — 401 Unauthorized |
| 11 | No auth → `/api/vc-pools/available` | PASS — 401 Unauthorized |
| 12 | FREE tier → `/api/vc-pools/available` | PASS — 403 "This feature requires one of: ELITE. You have FREE." |
| 13 | FREE tier → `/api/vc-pools/:id` | PASS — 403 Forbidden |
| 14 | ELITE tier → `/api/vc-pools/available` | PASS — Returns open pools with `available_seats`, `admin_binance_uid` |
| 15 | ELITE tier → `/api/vc-pools/:id` | PASS — Returns pool details for published pool |
| 16 | ELITE tier → draft pool | PASS — 404 "Pool not found" (draft hidden from users) |

---

## Architecture Notes

### Module Dependencies

```
VcPoolModule
├── imports: PrismaModule, AdminAuthModule
├── controllers: AdminPoolController, UserPoolController
├── providers: PoolManagementService, FeatureAccessService, TierAccessGuard
└── exports: PoolManagementService
```

### Guard Stack

| Controller | Guards | Access Control |
|---|---|---|
| `AdminPoolController` | `AdminJwtAuthGuard` (class-level) | Admin JWT with `role: 'admin'` |
| `UserPoolController` | `JwtAuthGuard` + `TierAccessGuard` (class-level), `@AllowTier('ELITE')` (method-level) | User JWT + ELITE tier check |

### Fee Defaults Logic

When creating a pool, omitted fee fields automatically copy from the admin's configured defaults:

```
pool.pool_fee_percent          = dto.pool_fee_percent          ?? admin.default_pool_fee_percent
pool.admin_profit_fee_percent  = dto.admin_profit_fee_percent  ?? admin.default_admin_profit_fee_percent
pool.cancellation_fee_percent  = dto.cancellation_fee_percent  ?? admin.default_cancellation_fee_percent
pool.payment_window_minutes    = dto.payment_window_minutes    ?? admin.default_payment_window_minutes
```

### Pool Visibility Rules

| Status | Admin sees? | ELITE user sees? |
|---|---|---|
| `draft` | Yes (via `/admin/pools`) | No (404) |
| `open` | Yes | Yes (in browse + detail) |
| `full` | Yes | Yes (detail only, not in browse) |
| `active` | Yes | Yes (detail only) |
| `completed` | Yes | Yes (detail only) |
| `cancelled` | Yes | Yes (detail only) |

### Pagination

- Default: 20 items per page
- Maximum: 50 items per page
- Sorted by `created_at DESC` (newest first)

---

## How to Test

### 1. Start the server

```bash
cd q_nest
npm run start:dev
```

### 2. Login as admin

```bash
curl -X POST http://localhost:3000/admin/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@quantiva.io","password":"your_password"}'
```

Save the `accessToken` from the response.

### 3. Create a pool

```bash
curl -X POST http://localhost:3000/admin/pools \
  -H "Authorization: Bearer <adminToken>" \
  -H "Content-Type: application/json" \
  -d '{"name":"My First Pool","contribution_amount":100,"max_members":5,"duration_days":30}'
```

### 4. Edit the pool

```bash
curl -X PUT http://localhost:3000/admin/pools/<pool_id> \
  -H "Authorization: Bearer <adminToken>" \
  -H "Content-Type: application/json" \
  -d '{"name":"Updated Pool Name","max_members":10}'
```

### 5. Publish the pool

```bash
curl -X PUT http://localhost:3000/admin/pools/<pool_id>/publish \
  -H "Authorization: Bearer <adminToken>"
```

### 6. Clone the pool

```bash
curl -X POST http://localhost:3000/admin/pools/<pool_id>/clone \
  -H "Authorization: Bearer <adminToken>"
```

### 7. List pools with filters

```bash
curl http://localhost:3000/admin/pools?status=open&page=1&limit=10 \
  -H "Authorization: Bearer <adminToken>"
```

### 8. Browse as ELITE user

```bash
curl http://localhost:3000/api/vc-pools/available \
  -H "Authorization: Bearer <userToken>"
```

### 9. Get pool details as user

```bash
curl http://localhost:3000/api/vc-pools/<pool_id> \
  -H "Authorization: Bearer <userToken>"
```

---

## Next: Phase 1C

Joining + Seat Reservation + Payments — users can join pools, upload Binance screenshots, admin approves/rejects, seat expiry scheduler.

---

*Phase 1B — Pool Management + User Browse — DONE*
