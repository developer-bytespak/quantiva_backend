# VC Pool — Phase 1A Complete: Schema + Admin Auth + Settings

**Status:** IMPLEMENTED & VERIFIED
**Migration:** Applied
**Build:** Zero TypeScript errors, zero linter errors

---

## What Was Done

### 1. Prisma Schema Changes

Applied the full VC Pool schema to `q_nest/prisma/schema.prisma`:

**7 new enums:**
- `PoolStatus` — draft, open, full, active, completed, cancelled
- `VcPaymentMethod` — stripe, binance
- `SeatReservationStatus` — reserved, confirmed, released, expired
- `PaymentSubmissionStatus` — pending, processing, verified, rejected, expired
- `ExitRequestStatus` — pending, approved, rejected, processed
- `PoolPayoutStatus` — pending, processing, completed, failed
- `PayoutType` — completion, pool_cancelled

**9 new models:**

| Model | Purpose |
|---|---|
| `admins` | Admin users (email, password, Stripe keys, Binance UID/keys, default fees) |
| `admin_sessions` | Admin JWT sessions (mirrors user_sessions) |
| `vc_pools` | Pool definitions (name, amounts, fees, status, counters, financials) |
| `vc_pool_seat_reservations` | Seat lock + timer when user clicks Join |
| `vc_pool_payment_submissions` | Stripe checkout data OR Binance screenshot + admin review |
| `vc_pool_members` | Verified pool members with locked payment method + share % |
| `vc_pool_trades` | Admin-executed trades linked to strategy |
| `vc_pool_cancellations` | User exit requests with fee calculation |
| `vc_pool_payouts` | Pool completion payouts + pool-cancelled refunds |

**2 modified models:**
- `users` — added `stripe_connect_account_id`, `pool_memberships`, `pool_seat_reservations`, `pool_payment_submissions`
- `strategies` — added `vc_pool_trades` relation

### 2. Admin Auth Module

Created `src/modules/admin-auth/` with full JWT-based authentication, completely separate from user auth.

**Files created:**

```
src/modules/admin-auth/
├── admin-auth.module.ts                    # Module wiring
├── controllers/
│   └── admin-auth.controller.ts            # 8 endpoints
├── services/
│   ├── admin-auth.service.ts               # Login, refresh, logout, getById
│   ├── admin-token.service.ts              # JWT generation with role:'admin'
│   ├── admin-session.service.ts            # Session CRUD + hourly cleanup
│   └── admin-settings.service.ts           # Binance UID + fee defaults
├── strategies/
│   └── admin-jwt.strategy.ts               # Passport strategy 'admin-jwt'
├── guards/
│   └── admin-jwt-auth.guard.ts             # AuthGuard('admin-jwt')
├── decorators/
│   └── current-admin.decorator.ts          # @CurrentAdmin() param decorator
└── dto/
    ├── admin-login.dto.ts                  # email + password validation
    └── update-admin-settings.dto.ts        # Binance UID + fee settings validation
```

### 3. App Module Registration

`AdminAuthModule` registered in `app.module.ts` imports array.

---

## API Endpoints

Base URL: `http://localhost:<PORT>/admin`

### Auth Endpoints (Public — no JWT required)

#### POST `/admin/auth/login`

Login and receive JWT tokens.

```json
// Request
{
  "email": "admin@quantiva.io",
  "password": "your_password"
}

// Response 200
{
  "admin": {
    "admin_id": "uuid",
    "email": "admin@quantiva.io",
    "full_name": "Quantiva Admin"
  },
  "accessToken": "eyJhbG...",
  "refreshToken": "eyJhbG...",
  "sessionId": "uuid",
  "message": "Admin authentication successful"
}
```

**Cookies set automatically:**
- `admin_access_token` — httpOnly, 45 min TTL
- `admin_refresh_token` — httpOnly, 7 day TTL

---

#### POST `/admin/auth/refresh`

Refresh expired access token. Reads `admin_refresh_token` cookie automatically.

```json
// No body required (uses cookie)

// Response 200
{
  "message": "Admin tokens refreshed successfully",
  "accessToken": "eyJhbG...",
  "refreshToken": "eyJhbG..."
}
```

---

#### POST `/admin/auth/logout`

Logout — deletes session from DB and clears cookies. Send the access token via `Authorization: Bearer <token>` header or it reads from cookie.

```json
// Response 200
{
  "message": "Admin logged out successfully"
}
```

---

### Protected Endpoints (Require `Authorization: Bearer <accessToken>`)

#### GET `/admin/auth/me`

Get current admin info.

```json
// Response 200
{
  "admin_id": "uuid",
  "email": "admin@quantiva.io",
  "full_name": "Quantiva Admin",
  "binance_uid": null,
  "default_pool_fee_percent": "5.00",
  "default_admin_profit_fee_percent": "20.00",
  "default_cancellation_fee_percent": "5.00",
  "default_payment_window_minutes": 30,
  "created_at": "2026-02-25T..."
}
```

---

#### GET `/admin/settings`

Get current admin settings (same data as `/auth/me`).

```json
// Response 200 (same shape as /auth/me)
```

---

#### PUT `/admin/settings/binance`

Set Binance UID (displayed to users for manual payment transfers).

```json
// Request
{
  "binance_uid": "12345678"
}

// Response 200
{
  "message": "Binance settings updated",
  "binance_uid": "12345678"
}
```

**Validation:**
- `binance_uid` — required, string

---

#### PUT `/admin/settings/fees`

Update default fee percentages and payment window for new pools.

```json
// Request
{
  "default_pool_fee_percent": 5,
  "default_admin_profit_fee_percent": 20,
  "default_cancellation_fee_percent": 5,
  "default_payment_window_minutes": 30
}

// Response 200
{
  "message": "Fee settings updated",
  "admin_id": "uuid",
  "default_pool_fee_percent": "5.00",
  "default_admin_profit_fee_percent": "20.00",
  "default_cancellation_fee_percent": "5.00",
  "default_payment_window_minutes": 30
}
```

**Validation:**
- All percent fields: number, min 0, max 100
- `default_payment_window_minutes`: integer, min 1, max 1440

---

#### PUT `/admin/settings/stripe`

Stub — returns "Phase 2" message.

```json
// Response 200
{
  "message": "Stripe integration coming in Phase 2",
  "status": "not_available"
}
```

---

## How to Seed First Admin

Before you can use the API, you need to create an admin record. The password must be bcrypt-hashed.

### Option A: Using Node.js Script

Create a file `q_nest/scripts/seed-admin.ts`:

```typescript
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash('your_secure_password', 10);

  const admin = await prisma.admins.create({
    data: {
      email: 'admin@quantiva.io',
      password_hash: passwordHash,
      full_name: 'Quantiva Admin',
    },
  });

  console.log('Admin created:', admin.admin_id, admin.email);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
```

Run it:
```bash
cd q_nest
npx ts-node scripts/seed-admin.ts
```

### Option B: Using SQL + bcrypt hash

Generate a hash first:
```bash
node -e "const bcrypt = require('bcrypt'); bcrypt.hash('your_password', 10).then(h => console.log(h))"
```

Then run in your database:
```sql
INSERT INTO admins (admin_id, email, password_hash, full_name)
VALUES (
  gen_random_uuid(),
  'admin@quantiva.io',
  '$2b$10$...paste_hash_here...',
  'Quantiva Admin'
);
```

### Option C: Using Prisma Studio

```bash
cd q_nest
npx prisma studio
```
Open the `admins` table and manually add a record (you'll need to pre-hash the password).

---

## How to Test

### 1. Start the server

```bash
cd q_nest
npm run start:dev
```

### 2. Test with cURL

**Login:**
```bash
curl -X POST http://localhost:3000/admin/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@quantiva.io","password":"your_password"}'
```

**Get profile (use token from login response):**
```bash
curl http://localhost:3000/admin/auth/me \
  -H "Authorization: Bearer <accessToken>"
```

**Update Binance UID:**
```bash
curl -X PUT http://localhost:3000/admin/settings/binance \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{"binance_uid":"12345678"}'
```

**Update fees:**
```bash
curl -X PUT http://localhost:3000/admin/settings/fees \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{"default_pool_fee_percent":5,"default_admin_profit_fee_percent":20,"default_cancellation_fee_percent":5,"default_payment_window_minutes":30}'
```

**Refresh token:**
```bash
curl -X POST http://localhost:3000/admin/auth/refresh \
  --cookie "admin_refresh_token=<refreshToken>"
```

**Logout:**
```bash
curl -X POST http://localhost:3000/admin/auth/logout \
  -H "Authorization: Bearer <accessToken>"
```

### 3. Test with Postman

1. Create a new collection "VC Pool Admin"
2. Add the 8 endpoints above
3. For login: save the `accessToken` from the response into a collection variable
4. For protected endpoints: set Authorization header to `Bearer {{accessToken}}`

---

## Architecture Notes

### Admin vs User Auth — Completely Separate

| Aspect | User Auth | Admin Auth |
|---|---|---|
| Table | `users` | `admins` |
| Sessions table | `user_sessions` | `admin_sessions` |
| JWT strategy name | `jwt` | `admin-jwt` |
| JWT payload | `{ sub, email, username }` | `{ sub, email, role: 'admin' }` |
| Access cookie | `access_token` | `admin_access_token` |
| Refresh cookie | `refresh_token` | `admin_refresh_token` |
| Guard class | `JwtAuthGuard` | `AdminJwtAuthGuard` |
| Decorator | `@CurrentUser()` | `@CurrentAdmin()` |
| Route prefix | `/auth/*` | `/admin/auth/*` |

### JWT Token Payload (Admin)

```json
{
  "sub": "admin_uuid",
  "email": "admin@quantiva.io",
  "role": "admin",
  "session_id": "session_uuid",
  "iat": 1740000000,
  "exp": 1740002700
}
```

The `role: 'admin'` field is checked in `AdminJwtStrategy.validate()` — user tokens will be rejected.

### Session Validation

On every protected request, `AdminJwtStrategy` checks:
1. Token has `role === 'admin'`
2. `admin_id` exists in `admins` table
3. Session exists in `admin_sessions`, is not revoked, and not expired

### Automatic Cleanup

`AdminSessionService` has a `@Cron(EVERY_HOUR)` job that deletes expired sessions from `admin_sessions`.

---

## Database Tables Created

Verify via Prisma Studio:
```bash
cd q_nest
npx prisma studio
```

You should see these new tables (all empty except `admins` after seeding):

| Table | Records After Seed |
|---|---|
| `admins` | 1 (your seeded admin) |
| `admin_sessions` | 0 (created on login) |
| `vc_pools` | 0 |
| `vc_pool_seat_reservations` | 0 |
| `vc_pool_payment_submissions` | 0 |
| `vc_pool_members` | 0 |
| `vc_pool_trades` | 0 |
| `vc_pool_cancellations` | 0 |
| `vc_pool_payouts` | 0 |

---

## Next: Phase 1B

Pool CRUD + User Browse — admin can create/edit/publish/clone pools, ELITE users can browse open pools.

---

*Phase 1A — Schema + Admin Auth + Settings — DONE*
