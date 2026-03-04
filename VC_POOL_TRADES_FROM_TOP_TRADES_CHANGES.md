# VC Pool Trades from Top Trades — Backend Changes (Tracking)

**Date:** 2026-03-02  
**Scope:** Wire VC pools to real exchange orders (Top Trades–style), tag orders per pool, compute pool PnL from those orders. **Admin-only flow:** pool orders are placed by the pool admin using their own Binance API keys; no link between admin and user.

---

## 1. Schema (Prisma)

**File:** `q_nest/prisma/schema.prisma`

- **New model `vc_pool_exchange_orders`**
  - `order_id` (PK), `pool_id` (FK → vc_pools), **`admin_id`** (FK → admins)
  - `symbol`, `side`, `order_type`, `quantity`, `entry_price_usdt`, `exchange_order_id`
  - `is_open`, `exit_price_usdt`, `realized_pnl_usdt`, `opened_at`, `closed_at`, `created_at`
  - Indexes: `[pool_id]`, `[pool_id, is_open]`, `[admin_id]`

- **`vc_pools`**
  - New relation: `exchange_orders vc_pool_exchange_orders[]`

- **`admins`**
  - New relation: `pool_exchange_orders vc_pool_exchange_orders[]`
  - **No** `user_id` — admin and user are not linked. Pool orders use admin’s own Binance keys (`binance_api_key_encrypted`, `binance_api_secret_encrypted`).

- **`users`**
  - **No** `admin_profile` or admin reference.

**Migration:** Run yourself, e.g.:

```bash
cd q_nest
npx prisma migrate dev --name add_vc_pool_exchange_orders_admin
npx prisma generate
```

---

## 2. Admin-only: place pool order (same exchange flow, admin credentials)

**File:** `q_nest/src/modules/vc-pool/dto/place-pool-order.dto.ts` (new)

- DTO: `symbol`, `side` (BUY|SELL), `type` (MARKET|LIMIT), `quantity`, `price?` (required for LIMIT).

**File:** `q_nest/src/modules/vc-pool/services/pool-trading.service.ts`

- Injected: `BinanceService` (from `../../exchanges/integrations/binance.service`), `EncryptionService` (from `../../exchanges/services/encryption.service`).
- **`placePoolOrder(adminId, poolId, dto)`**: Validates pool (admin owns, status active). Loads admin’s `binance_api_key_encrypted` and `binance_api_secret_encrypted`; if missing, throws `BadRequestException`. Decrypts keys, calls `binanceService.placeOrder(...)`, then creates `vc_pool_exchange_orders` with `pool_id`, `admin_id`, symbol, side, order_type, quantity, entry_price_usdt, exchange_order_id, `is_open: true`. Returns created record and exchange response.

**File:** `q_nest/src/modules/vc-pool/controllers/admin-pool-trades.controller.ts`

- **`POST admin/pools/:poolId/orders/place`** — Body: `PlacePoolOrderDto`. Uses admin JWT; places order on Binance with admin’s keys and records to `vc_pool_exchange_orders`.

**File:** `q_nest/src/modules/vc-pool/vc-pool.module.ts`

- Added `ExchangesModule` to `imports` so `PoolTradingService` can use `BinanceService` and `EncryptionService`.

**User place-order:** No `vcPoolId`; user-facing `POST connections/:connectionId/orders/place` is unchanged and does not write to `vc_pool_exchange_orders`.

---

## 3. Pool value from exchange orders

**File:** `q_nest/src/modules/vc-pool/services/pool-value.service.ts`

- **Realized PnL:** Sum `realized_pnl_usdt` from `vc_pool_exchange_orders` where `pool_id` and `is_open: false`; add to existing closed manual-trade PnL.
- **Unrealized PnL:** For `vc_pool_exchange_orders` with `pool_id` and `is_open: true`, resolve symbol to a Binance pair, get current price from `BinanceService`, compute unrealized PnL by side (BUY/SELL) and add to pool unrealized PnL.
- `current_pool_value_usdt` and `total_profit_usdt` now include both manual `vc_pool_trades` and pool-tagged `vc_pool_exchange_orders`.

---

## 4. Pool completion and exchange orders

**File:** `q_nest/src/modules/vc-pool/services/pool-payout.service.ts`

- Before completing pool: check for open `vc_pool_exchange_orders` for the pool; if any exist, throw `BadRequestException` with message to close all open pool exchange positions.
- Final pool value: add realized PnL from closed `vc_pool_exchange_orders` (sum `realized_pnl_usdt`) to the value used for member payouts.

---

## 5. Admin: list and close pool exchange orders

**File:** `q_nest/src/modules/vc-pool/dto/close-exchange-order.dto.ts`

- DTO: `exit_price_usdt: number` (required, min 0).

**File:** `q_nest/src/modules/vc-pool/services/pool-trading.service.ts`

- **`listExchangeOrders(adminId, poolId, filters?)`:** Returns paginated `vc_pool_exchange_orders` for the pool (response includes `admin_id`), with summary (open/closed counts, realized PnL).
- **`closeExchangeOrder(adminId, poolId, orderId, exitPriceUsdt)`:** Validates pool ownership and that the order is open; sets `is_open: false`, `exit_price_usdt`, `realized_pnl_usdt`, `closed_at`.

**File:** `q_nest/src/modules/vc-pool/controllers/admin-pool-trades.controller.ts`

- **`GET admin/pools/:poolId/exchange-trades`** — Lists pool-tagged exchange orders (query: `status`, `page`, `limit`).
- **`PUT admin/pools/:poolId/exchange-orders/:orderId/close`** — Body: `CloseExchangeOrderDto`. Records close and realized PnL.

---

## 6. Summary of API changes

| Method | Path | Description |
|--------|------|-------------|
| POST | `/admin/pools/:poolId/orders/place` | **Admin only.** Body: symbol, side, type, quantity, price?. Places order on Binance using admin’s API keys and stores in `vc_pool_exchange_orders`. |
| GET | `/admin/pools/:poolId/exchange-trades` | List pool-tagged exchange orders (optional `status`, `page`, `limit`). |
| PUT | `/admin/pools/:poolId/exchange-orders/:orderId/close` | Record close with `exit_price_usdt`; computes and stores `realized_pnl_usdt`. |

User endpoint `POST /exchanges/connections/:connectionId/orders/place` is unchanged and does **not** accept or use `vcPoolId`.

---

## 7. Behaviour summary

- **Place pool order:** Admin calls `POST admin/pools/:poolId/orders/place` with order details. Backend uses the pool admin’s Binance API keys (stored on `admins`), places the order on Binance, and creates a row in `vc_pool_exchange_orders` with `pool_id` and `admin_id`. No user or user connection is involved.
- **Pool value:** Scheduler and any logic using `PoolValueService.calculatePoolValue` include both manual trades and pool-tagged exchange orders (realized + unrealized).
- **Completion:** Blocked until there are no open pool exchange orders; final value and payouts include realized PnL from closed pool exchange orders.
- **Closing a pool position:** Admin calls the close endpoint with `exit_price_usdt`; backend updates the `vc_pool_exchange_orders` row (close is recorded only in our DB; no exchange close call).

---

## 8. Files touched (list)

- `q_nest/prisma/schema.prisma` — New model `vc_pool_exchange_orders` with `admin_id`; relations on `vc_pools` and `admins`; **no** `admins.user_id` or `users.admin_profile`
- `q_nest/src/modules/exchanges/dto/place-order.dto.ts` — No `vcPoolId` (reverted)
- `q_nest/src/modules/exchanges/exchanges.controller.ts` — No `vcPoolId` passed to service (reverted)
- `q_nest/src/modules/exchanges/exchanges.service.ts` — No pool/connection validation or `vc_pool_exchange_orders` create (reverted)
- `q_nest/src/modules/vc-pool/dto/place-pool-order.dto.ts` — **New** DTO for admin place pool order
- `q_nest/src/modules/vc-pool/services/pool-trading.service.ts` — `placePoolOrder`, `listExchangeOrders` (response uses `admin_id`), `closeExchangeOrder`; inject BinanceService + EncryptionService
- `q_nest/src/modules/vc-pool/controllers/admin-pool-trades.controller.ts` — `POST :poolId/orders/place`, GET exchange-trades, PUT close exchange order
- `q_nest/src/modules/vc-pool/vc-pool.module.ts` — Import `ExchangesModule`
- `q_nest/src/modules/vc-pool/services/pool-value.service.ts` — Include exchange orders in PnL
- `q_nest/src/modules/vc-pool/services/pool-payout.service.ts` — Block completion if open exchange orders; include their realized PnL in final value
- `q_nest/src/modules/vc-pool/dto/close-exchange-order.dto.ts` — Close DTO

Migration is left for you to run locally.
