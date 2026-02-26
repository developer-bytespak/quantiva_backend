# VC Pool — Sub-Phase 1D DONE

## Pool Trading + Value Tracking

**Status:** COMPLETE  
**Date:** 2026-02-27  
**Last verified:** All 35 API tests passed  
**Depends on:** Phase 1C (pool must be full with verified members)

---

## Summary

Phase 1D implements three core capabilities:

1. **Start Pool (full → active)** — Admin transitions a full pool to active, setting dates and calculating member shares.
2. **Manual Trade Entry** — Admin can open BUY/SELL trades on active pools and close them with exit prices. PnL is automatically calculated.
3. **Pool Value Tracking** — After each trade close, pool value is recalculated. A scheduler runs every 60 seconds to update active pool values with unrealized PnL from open trades.

---

## New Files Created

| File | Purpose |
|---|---|
| `dto/manual-trade.dto.ts` | DTO for opening a trade (asset_pair, action, quantity, entry_price, strategy_id?, notes?) |
| `dto/close-trade.dto.ts` | DTO for closing a trade (exit_price_usdt) |
| `services/pool-trading.service.ts` | Trade CRUD: open, close (with PnL calc), list (with filters + summary), recalculate pool value |
| `services/pool-value.service.ts` | Calculates pool value: closed PnL + unrealized PnL (via BinanceService live prices) |
| `controllers/admin-pool-trades.controller.ts` | Admin REST endpoints for pool trades |
| `schedulers/pool-value-update.scheduler.ts` | Cron job: updates all active pool values every 60 seconds |

## Modified Files

| File | Changes |
|---|---|
| `services/pool-management.service.ts` | Added `startPool()` method (full → active, calculates shares) |
| `controllers/admin-pool.controller.ts` | Added `PUT /:id/start` endpoint |
| `vc-pool.module.ts` | Added BinanceModule import, new services/controllers/scheduler |

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
| `POST` | `/admin/pools/:poolId/trades` | Admin JWT | Open a new trade |
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
✅ All 41 tests passed
✅ Temp test helpers removed, test script deleted
```

---

## Architecture Notes

- **PnL is deterministic**: For closed trades, PnL is calculated once at close time and stored. No recalculation needed.
- **Unrealized PnL** relies on live Binance price fetches. If Binance API is unreachable, unrealized PnL defaults to 0 (graceful degradation).
- **Pool value formula**: `total_invested + SUM(closed_pnl) + SUM(unrealized_pnl)`
- **Scheduler** uses a mutex (`isRunning` flag) to prevent overlapping runs.
- **Share percent**: For fixed contributions, all shares are equal (100 / max_members). With variable contributions, shares are proportional to investment.
- **No Prisma migration required**: All tables (`vc_pool_trades`, `vc_pools` value columns) already exist from Phase 1A/1B schema.

---

## Next: Phase 1E — Completion + Cancellations + Payouts

Phase 1E will implement:
- User cancellation requests (exit from active pool)
- Admin approval of cancellations with fee calculation
- Pool completion flow (admin completes pool → payouts calculated)
- Pool manual cancellation by admin (refunds all members)
- Payout tracking
