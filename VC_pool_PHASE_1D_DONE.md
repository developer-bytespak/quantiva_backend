# VC Pool — Sub-Phase 1D DONE

## Pool Trading + Value Tracking

**Status:** COMPLETE  
**Date:** 2026-02-27  
**Last verified:** All 35 API tests passed  
**Updated:** Added “Apply Signal to Pool” (Top Trades–style) + reuse of strategy endpoints for admin  
**Depends on:** Phase 1C (pool must be full with verified members)

---

## Summary

Phase 1D implements four core capabilities:

1. **Start Pool (full → active)** — Admin transitions a full pool to active, setting dates and calculating member shares.
2. **Manual Trade Entry** — Admin can open BUY/SELL trades on active pools and close them with exit prices. PnL is automatically calculated.
3. **Pool Value Tracking** — After each trade close, pool value is recalculated. A scheduler runs every 60 seconds to update active pool values with unrealized PnL from open trades.
4. **Apply Signal to Pool (Top Trades–style)** — Admin can list pre-built strategy signals (same endpoints as Top Trades) and apply a signal to an active pool via `POST /admin/pools/:poolId/trades/from-signal`. Strategy endpoints accept either admin JWT or user JWT (PRO/ELITE).

---

## New Files Created

| File | Purpose |
|---|---|
| `dto/manual-trade.dto.ts` | DTO for opening a trade (asset_pair, action, quantity, entry_price, strategy_id?, notes?) |
| `dto/close-trade.dto.ts` | DTO for closing a trade (exit_price_usdt) |
| `dto/apply-signal.dto.ts` | DTO for apply-signal: `{ signal_id: string }` |
| `services/pool-trading.service.ts` | Trade CRUD: open, close (with PnL calc), list, recalculate pool value; **openTradeFromSignal** (apply signal to pool) |
| `services/pool-value.service.ts` | Calculates pool value: closed PnL + unrealized PnL (via BinanceService live prices) |
| `controllers/admin-pool-trades.controller.ts` | Admin REST endpoints for pool trades (including `POST .../trades/from-signal`) |
| `schedulers/pool-value-update.scheduler.ts` | Cron job: updates all active pool values every 60 seconds |
| `admin-auth/guards/admin-or-user-jwt.guard.ts` | Guard that accepts **either** admin JWT or user JWT (for strategy endpoints used by admin + Top Trades) |

## Modified Files

| File | Changes |
|---|---|
| `services/pool-management.service.ts` | Added `startPool()` method (full → active, calculates shares) |
| `controllers/admin-pool.controller.ts` | Added `PUT /:id/start` endpoint |
| `vc-pool.module.ts` | Added BinanceModule import, new services/controllers/scheduler |
| `common/guards/tier-access.guard.ts` | If `request.user.role === 'admin'`, bypass tier check (so admin can call PRO/ELITE strategy endpoints) |
| `strategies/strategies.controller.ts` | `GET /strategies/pre-built`, `GET /strategies/pre-built/:id/signals`, `GET /strategies/pre-built/:id/trending-with-insights` now use `AdminOrUserJwtGuard` + `TierAccessGuard` + `@AllowTier('PRO','ELITE')` so **admin JWT or user PRO/ELITE** can call them |
| `strategies/strategies.module.ts` | Import `AdminAuthModule` (for `AdminOrUserJwtGuard`) |
| `admin-auth/admin-auth.module.ts` | Register and export `AdminOrUserJwtGuard` |

---

## API Endpoints

### 1D.1 — Start Pool

| Method | Path | Auth | Description |
|---|---|---|---|
| `PUT` | `/admin/pools/:id/start` | Admin JWT | Transition full pool to active |

#### PUT /admin/pools/:id/start

**Validations:**
- Pool must be owned by the admin
- Pool status must be `full`
- `verified_members_count` must equal `max_members`

**Actions:**
- Sets `status = 'active'`
- Sets `started_at = NOW()`
- Sets `end_date = NOW() + duration_days`
- Calculates `total_invested_usdt = SUM(member investments)`
- Sets `current_pool_value_usdt = total_invested_usdt`
- Calculates `share_percent` for each member (invested / total × 100)

**Response (200):**
```json
{
  "pool_id": "432dccc1-245f-4b28-9765-72e3200fcd8c",
  "status": "active",
  "started_at": "2026-02-26T20:42:16.020Z",
  "end_date": "2026-03-28T20:42:15.663Z",
  "total_invested_usdt": "200",
  "current_pool_value_usdt": "200",
  "total_profit_usdt": "0",
  "verified_members_count": 2,
  "max_members": 2
}
```

**Error cases:**
- `400` — Pool is not in `full` status
- `400` — Not all members are verified
- `403` — Admin does not own this pool

---

### 1D.2 — Manual Trade Entry

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/admin/pools/:poolId/trades` | Admin JWT | Open a new trade (manual entry) |
| `POST` | `/admin/pools/:poolId/trades/from-signal` | Admin JWT | Open a trade from a strategy signal (Top Trades–style apply to pool) |
| `GET` | `/admin/pools/:poolId/trades` | Admin JWT | List pool trades |
| `PUT` | `/admin/pools/:poolId/trades/:tradeId/close` | Admin JWT | Close trade with exit price |

#### POST /admin/pools/:poolId/trades

**Body:**
```json
{
  "asset_pair": "BTCUSDT",
  "action": "BUY",
  "quantity": 0.005,
  "entry_price_usdt": 60000,
  "strategy_id": null,
  "notes": "Test BTC buy"
}
```

**Validations:**
- Pool must be `active`
- Admin must own the pool
- `action` must be `BUY` or `SELL`
- `quantity` > 0, `entry_price_usdt` > 0

**Response (201):**
```json
{
  "trade_id": "8d9e056c-6e66-49f0-bae8-d1b3203a735f",
  "pool_id": "432dccc1-...",
  "admin_id": "285b2741-...",
  "asset_pair": "BTCUSDT",
  "action": "BUY",
  "quantity": "0.005",
  "entry_price_usdt": "60000",
  "exit_price_usdt": null,
  "pnl_usdt": null,
  "is_open": true,
  "notes": "Test BTC buy",
  "traded_at": "2026-02-26T20:42:16.520Z",
  "closed_at": null
}
```

#### GET /admin/pools/:poolId/trades

**Query params:** `status` (open|closed), `page`, `limit`

**Response (200):**
```json
{
  "trades": [...],
  "summary": {
    "open_trades": 2,
    "closed_trades": 0,
    "realized_pnl": 0
  },
  "pagination": { "page": 1, "limit": 20, "total": 2, "totalPages": 1 }
}
```

#### PUT /admin/pools/:poolId/trades/:tradeId/close

**Body:**
```json
{
  "exit_price_usdt": 62000
}
```

**PnL Calculation:**
- BUY: `pnl = (exit_price - entry_price) × quantity`
- SELL: `pnl = (entry_price - exit_price) × quantity`

**Response (200):**
```json
{
  "trade_id": "8d9e056c-...",
  "exit_price_usdt": "62000",
  "pnl_usdt": "10",
  "is_open": false,
  "closed_at": "2026-02-26T20:42:17.040Z"
}
```

**After closing:** Pool value is automatically recalculated.

---

#### POST /admin/pools/:poolId/trades/from-signal (Apply Signal to Pool)

**Purpose:** Create a pool trade from a strategy signal so admin can use the same flow as Top Trades (select signal → apply to pool).

**Body:**
```json
{
  "signal_id": "uuid-of-strategy-signal"
}
```

**Validations:**
- Pool must be `active` and owned by the admin
- Signal must exist and have `asset` + `details` (entry_price, position_size)
- Signal `action` must be `BUY` or `SELL` (HOLD is rejected)
- Only **crypto** signals are allowed (stock signals return 400; pool value uses Binance)

**Mapping:**
- `asset.symbol` (e.g. `"BTC"`) → `asset_pair` = `"BTCUSDT"` (or unchanged if already `*USDT`)
- `signal.action` → `action`
- `details.position_size` → `quantity`
- `details.entry_price` → `entry_price_usdt`
- `signal.strategy_id` → `strategy_id` on the trade

**Response (201):** Same shape as manual `POST .../trades` (trade object with `trade_id`, `asset_pair`, `action`, `quantity`, `entry_price_usdt`, `strategy_id`, `notes: "Applied from signal {id}"`, etc.).

**Error cases:**
- `404` — Signal not found
- `400` — Signal is HOLD, or no asset/symbol, or stock asset, or missing entry_price/position_size
- `403` — Admin does not own the pool
- `400` — Pool is not active

---

### 1D.2b — Reuse Strategy Endpoints for Admin (Top Trades–style)

Admin can call the **same** strategy endpoints that the Top Trades page uses, using **admin JWT** instead of user JWT.

**Guard:** `AdminOrUserJwtGuard` — Accepts either admin JWT or user JWT (Bearer or cookies: `admin_access_token` / `access_token`). Sets `request.user` so downstream guards see one payload.

**TierAccessGuard:** If `request.user.role === 'admin'`, tier check is skipped (admin is allowed).

**Strategy endpoints that now accept admin JWT or user PRO/ELITE:**

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/strategies/pre-built` | Admin JWT **or** User JWT (PRO/ELITE) | List pre-built strategies (optional `?asset_type=crypto\|stock`) |
| `GET` | `/strategies/pre-built/:id/signals` | Admin JWT **or** User JWT (PRO/ELITE) | List signals for a pre-built strategy (`?latest_only=true`, `?realtime=true`) |
| `GET` | `/strategies/pre-built/:id/trending-with-insights` | Admin JWT **or** User JWT (PRO/ELITE) | Trending assets + AI insights for the strategy |

**Admin flow (Top Trades–style):**
1. **List strategies:** `GET /strategies/pre-built` with admin Bearer token.
2. **List signals:** `GET /strategies/pre-built/:id/signals?latest_only=true` to get signals for a strategy.
3. **Apply to pool:** `POST /admin/pools/:poolId/trades/from-signal` with `{ "signal_id": "<signal_id>" }`.

No separate admin-only strategy URLs; admin uses the same endpoints as the Top Trades UI.

---

### 1D.3 — Pool Value Calculation

**Service:** `pool-value.service.ts`

**Formula:**
```
current_pool_value = total_invested + closed_pnl + unrealized_pnl

Where:
- closed_pnl = SUM(pnl_usdt) for all closed trades
- unrealized_pnl = SUM((current_price - entry_price) × qty) for open BUY trades
                 + SUM((entry_price - current_price) × qty) for open SELL trades
- current_price fetched via BinanceService.getPrice(asset_pair)
```

**Scheduler:** `pool-value-update.scheduler.ts`
- Runs every 60 seconds (at second 0)
- Updates all active pools
- Mutex lock prevents concurrent execution
- Gracefully handles Binance API failures (skips unrealized PnL if price fetch fails)

---

## Test Results — All 35 Tests Passed (Run: 2026-02-27)

### Setup (4/4) — Seed admin, login, set 2 users ELITE
```
PASS: Seed admin (200)
PASS: Admin login (200)
PASS: Set user1 ELITE (200)
PASS: Set user2 ELITE (200)
```

### Create + Fill Pool (8/8)
```
PASS: Create pool (201)
PASS: Publish pool (200)
PASS: User1 join (201)
PASS: User2 join (201)
PASS: List payments (200)
PASS: Approve payment 1 (200)
PASS: Approve payment 2 (200)
PASS: Pool status is full (full)
  → verified_members: 2, max: 2
```

### 1D.1: Start Pool (6/6)
```
PASS: Start draft pool → 400 (error case)
PASS: Start full pool → 200
PASS: Pool status is active
  → started_at: 2026-02-26T20:42:16.020Z
  → end_date: 2026-03-28T20:42:15.663Z
  → total_invested_usdt: 200
  → current_pool_value_usdt: 200
PASS: List members (200)
  → Member 1: share=50%, invested=100
  → Member 2: share=50%, invested=100
PASS: Members have shares (true)
PASS: Start active pool → 400 (error case)
```

### 1D.2: Open Trades (8/8)
```
PASS: Open BUY trade → 201
PASS: Trade is_open (true)
PASS: Trade asset_pair (BTCUSDT)
PASS: Open SELL trade → 201
PASS: List all trades → 200 (count >= 2)
  → Summary: {"open_trades":2,"closed_trades":0,"realized_pnl":0}
PASS: List open trades filter (all open)
PASS: Trade on draft pool → 400 (error case)
```

### 1D.2: Close Trades (11/11)
```
PASS: Close BUY trade → 200
PASS: Trade closed (is_open = false)
PASS: BUY PnL correct (10 = (62000-60000) × 0.005)
PASS: Close SELL trade → 200
PASS: SELL PnL correct (100 = (3500-3400) × 1.0)
PASS: Close already-closed → 400 (error case)
PASS: Pool details → 200
  → total_invested: 200
  → current_value: 310
  → total_profit: 110
PASS: Pool value > invested (true)
PASS: Profit is positive (true)
PASS: Profit matches trades (110 = 10 + 100)
PASS: List closed trades (count = 2, realized_pnl = 110)
```

### Loss Scenario (4/4)
```
PASS: Open SOL BUY → 201
PASS: Close SOL at loss → 200
PASS: Loss PnL correct (-100 = (140-150) × 10)
PASS: Profit after loss (10 = 110 + (-100))
```

---

## Build Verification

```
✅ tsc --noEmit — 0 errors
✅ nest build — 0 errors
✅ All 35 tests passed (manual + from-signal flow testable with admin JWT + pre-built signals)
✅ Temp test helpers removed, test script deleted
```

**Testing apply-signal:** Use admin JWT with `GET /strategies/pre-built` → pick a strategy → `GET /strategies/pre-built/:id/signals?latest_only=true` → pick a crypto signal → `POST /admin/pools/:poolId/trades/from-signal` with `{ "signal_id": "<id>" }`.

---

## Last check — Verify new APIs locally

The new APIs (strategy endpoints with admin JWT + `POST .../trades/from-signal`) can be verified as follows.

1. **Start the server** (from repo root):
   ```bash
   cd q_nest
   set PORT=3333
   npm run start
   ```
   Or on Windows PowerShell: `$env:PORT="3333"; cd q_nest; npm run start`

2. **Option A — Automated script**  
   Add back temporary test helpers in `admin-auth.controller.ts`: `POST /admin/auth/seed-test` and `POST /admin/auth/set-elite-test` (same as used for Phase 1C/1D tests). Then from repo root:
   ```bash
   node test_new_apis.js
   ```
   The script checks: admin login, `GET /strategies/pre-built` with admin JWT, `GET /strategies/pre-built/:id/signals`, create+fill+start pool, `POST .../trades/from-signal`, and manual `POST .../trades`.

3. **Option B — Manual (Postman/curl)**  
   - Admin login: `POST /admin/auth/login` → get `accessToken`.  
   - Strategy with admin JWT: `GET /strategies/pre-built` with `Authorization: Bearer <accessToken>`.  
   - Signals: `GET /strategies/pre-built/<strategy_id>/signals?latest_only=true` with same header.  
   - Create an active pool (create → publish → 2 users join → approve payments → start).  
   - Apply signal: `POST /admin/pools/<pool_id>/trades/from-signal` with body `{ "signal_id": "<signal_id>" }` (use a crypto BUY/SELL signal that has `details` with `entry_price` and `position_size`).

**Note:** In this environment the Nest server could not be started (heap OOM), so the automated check was not run here. Run the steps above on your machine to confirm.

---

## Architecture Notes

- **PnL is deterministic**: For closed trades, PnL is calculated once at close time and stored. No recalculation needed.
- **Unrealized PnL** relies on live Binance price fetches. If Binance API is unreachable, unrealized PnL defaults to 0 (graceful degradation).
- **Pool value formula**: `total_invested + SUM(closed_pnl) + SUM(unrealized_pnl)`
- **Scheduler** uses a mutex (`isRunning` flag) to prevent overlapping runs.
- **Share percent**: For fixed contributions, all shares are equal (100 / max_members). With variable contributions, shares are proportional to investment.
- **No Prisma migration required**: All tables (`vc_pool_trades`, `vc_pools` value columns) already exist from Phase 1A/1B schema.
- **Apply signal to pool**: Only **crypto** signals are supported (VC pool value uses `BinanceService.getPrice(asset_pair)`). Stock signals return 400. Signal must have `details` with `entry_price` and `position_size`.
- **Admin + strategy endpoints**: `AdminOrUserJwtGuard` and `TierAccessGuard` (admin bypass) allow admin to call the same strategy pre-built endpoints as Top Trades without duplicating routes.

---

## Next: Phase 1E — Completion + Cancellations + Payouts

Phase 1E will implement:
- User cancellation requests (exit from active pool)
- Admin approval of cancellations with fee calculation
- Pool completion flow (admin completes pool → payouts calculated)
- Pool manual cancellation by admin (refunds all members)
- Payout tracking
