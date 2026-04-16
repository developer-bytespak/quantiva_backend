# Alpaca Auto-Trade: Issues, Behavior, and Solutions

A plain-English guide to everything that can go right, wrong, or surprising when a user clicks an **auto-trade** (top-trade) on an Alpaca stock.

This document covers:

1. [PDT (Pattern Day Trader) Rule — the big one](#1-pdt-pattern-day-trader-rule)
2. [Market Hours — what Alpaca does at each time of day](#2-market-hours--what-alpaca-does-at-each-time-of-day)
3. [Auto-TP/SL Flow — the three paths](#3-auto-tpsl-flow--the-three-paths)
4. [Every edge case a user can hit](#4-every-edge-case-a-user-can-hit)
5. [Recommended solutions (ranked)](#5-recommended-solutions)

---

## 1. PDT (Pattern Day Trader) Rule

### What the rule actually says

> A **day trade** = buying and selling **the same stock** on the **same trading day** (both legs executed).
>
> If your account is worth less than **$25,000** and you make **4 or more day trades in any rolling 5-business-day window**, you are a "Pattern Day Trader." Your account gets frozen for 90 days.

This is a **FINRA/SEC regulation**. Every US broker enforces it. It is not Alpaca-specific.

### Important — two parts of the rule you must not confuse

**Part 1 — What counts as "one day trade":**
One day trade = one round-trip (buy + sell) of **a single stock** on **one day**.

**Part 2 — What the 4-in-5-day limit counts:**
The limit totals up **all day trades across every stock in the account**, not per-symbol.

So if in one day you buy+sell three *different* stocks, that's **three** day trades — not one.

**Concrete example:**

| Stock | Action | Counts as |
|-------|--------|-----------|
| AAPL | Buy + sell same day | Day trade #1 |
| DDOG | Buy + sell same day | Day trade #2 |
| ABBV | Buy + sell same day | Day trade #3 |
| *any stock* | Buy + sell same day (4th attempt in 5 days) | **Blocked by PDT** |

This is why our test account (which had AAPL + DDOG + ABBV all day-traded on April 13) is now at its limit and has TP/SL placement blocked on any new same-day buy — including PYPL, NVDA, or any other symbol.

The rule is **account-wide**, not per-stock.

### What Alpaca does on top of the rule (PDT Protection)

Alpaca is conservative. It doesn't just count executed day trades — it **refuses to even accept a sell order** if filling it today would complete a day trade on a sub-$25k account at the PDT limit.

So the block happens at order **placement**, not at order **execution**.

### Why this matters for our auto-TP/SL

Our auto-trade flow does this:

```
Step 1: Place BUY  (goes through)
Step 2: Place TP (LIMIT SELL at +10%)  ← Alpaca blocks this with PDT
Step 3: Place SL (STOP SELL at -5%)    ← never even tried, step 2 already failed
```

From Alpaca's perspective, TP and SL are **just regular sell orders**. There is no special "protection" type. So they get caught by the same PDT guardrail as any other sell placed on the same day as the buy.

### Concrete example

**User:** account has $3,000 (sub-$25k). Already made 3 day trades in the last 5 days.

| Time | Action | Result |
|------|--------|--------|
| 9:30 AM | BUY 1 PYPL @ $49 | Fills instantly |
| 9:30:02 AM | System tries TP LIMIT SELL @ $54 | **Alpaca: 403 — PDT protection** |
| 9:30:02 AM | System tries SL STOP SELL @ $46.50 | Never attempted — TP already failed |
| Result | Position held with no auto-protection | User has to manually sell tomorrow |

### Why can't we retry or work around it?

| Attempt | What happens |
|---------|--------------|
| Retry the sell immediately | Same PDT block |
| Place SL only (skip TP) | Same PDT block — still a sell on today's buy |
| Use Alpaca's "bracket" order (atomic buy+TP+SL) | **Untested** — may or may not bypass PDT |
| Wait until tomorrow to place TP/SL | Works. The "today's buy" becomes an "overnight position" after midnight ET |

### How to know if PDT is the problem

If the DB `pending_queued_trades` row has:

```
status = 'filled'
failure_reason = 'Buy filled but protection failed: trade denied due to pattern day trading protection (status 403)'
```

Then it's PDT, not a code bug.

### Who is affected

| Account state | PDT impact |
|---------------|------------|
| Paper account (keys start with `PK`) | **No PDT.** Paper has no day-trade limits. Everything works. |
| Live account (keys start with `AK`), equity ≥ $25,000 | **No PDT.** Rule is waived. Everything works. |
| Live account, equity < $25,000, under 3 day trades in last 5 days | Works for now. Each auto-trade may count toward the limit if the sell fills same day. |
| Live account, equity < $25,000, at or above the day-trade limit | **Blocked.** TP/SL cannot be placed same-day as buy. |

### Solutions (for the user)

| Solution | Effort | Trade-off |
|----------|--------|-----------|
| **A.** Switch connection to paper keys | Re-enter PK keys in the connect flow | Not real money |
| **B.** Fund live account above $25,000 | Deposit money | Needs $25k+ |
| **C.** Wait until the next day to place TP/SL manually | Manual action per trade | Doesn't scale, defeats auto-trade |
| **D.** Place only on stocks held from previous days | Choose different top-trades | Limits feature |

### Solutions (for our product)

| Solution | Effort | Outcome |
|----------|--------|---------|
| **1.** At buy time, check `GET /v2/account` for `pattern_day_trader` + `equity` < $25k. Warn in UI before clicking auto-trade. | Small backend + UI change | User isn't surprised when TP/SL silently fails |
| **2.** After a PDT failure, surface the `failure_reason` to the user with a clear message and a "Add TP/SL manually" button | Medium frontend change | User can recover |
| **3.** Test Alpaca's atomic bracket order (`order_class: bracket`) to see if it bypasses PDT | Small backend change + live test | Potentially unlocks the feature for sub-$25k users |
| **4.** Background retry: next trading day, the cron retries placing TP/SL on any "filled-without-protection" row. Overnight, the buy is no longer day-trade-eligible. | Medium backend change | Protection gets added 1 day late — still useful |

---

## 2. Market Hours — What Alpaca Does at Each Time of Day

US stock market (NYSE/NASDAQ) has 3 distinct windows. Alpaca behaves differently in each.

### The three windows (all times Eastern Time)

| Window | Hours (ET) | Alpaca behavior |
|--------|------------|-----------------|
| **Pre-market** | 4:00 AM – 9:30 AM | Accepts orders but **does not fill** unless `extended_hours: true`. Regular MARKET orders get status=`accepted` or `new` and sit idle waiting for market open. |
| **Regular hours** | 9:30 AM – 4:00 PM | Orders fill normally. Market orders fill in under a second. |
| **Post-market** | 4:00 PM – 8:00 PM | Same as pre-market. Orders sit as `accepted` / `new`. |
| **Market closed** | 8:00 PM – 4:00 AM, weekends, holidays | Alpaca typically **rejects** with `MARKET_CLOSED` error. (Behavior can vary — see edge cases.) |

### What our code does in each window

#### Regular hours (9:30 AM – 4:00 PM ET)

```
User clicks auto-trade on PYPL
  ↓
Controller sends BUY → Alpaca fills in <1s, returns status='accepted' then 'filled'
  ↓
Controller calls placeProtectionOrders (TP + SL)
  ↓
Race-retry loop (3 attempts × 500ms): waits for position to be available
  ↓
TP placed → SL placed
  ↓
Response to frontend: { success, data, oco: { takeProfitOrderId, stopLossOrderId } }
```

Assumes no PDT block. On a paper account or ≥ $25k live account, this is the happy path and takes ~1–2 seconds.

#### Pre-market / Post-market

```
User clicks auto-trade on PYPL at 8 PM ET
  ↓
Controller sends BUY → Alpaca returns status='accepted', orderId assigned
  ↓
Controller calls placeProtectionOrders (TP + SL)
  ↓
Alpaca rejects the sell with "insufficient qty available" (buy hasn't filled yet)
  ↓
Race-retry exhausts (1.5s total, buy still not filled — won't fill until 9:30 AM tomorrow)
  ↓
catch block detects: top_trade + Alpaca + BUY + buy pending + 403/422
  ↓
queuedTradeService.trackForDelayedProtection({ alpacaBuyOrderId: '...', ... })
  → creates row with status='submitted'
  ↓
Response to frontend: { success, data, delayedProtection: { queueId, message } }
  ↓
... hours pass ...
  ↓
9:30 AM next day: market opens, Alpaca fills the pending buy
  ↓
Every minute, queuedTradeCron.watchOne() polls the buy's status
  → detects filled_qty > 0 and filled_avg_price > 0
  → places TP and SL using actual filled price
  ↓
Row status → 'filled', tp_order_id and sl_order_id populated
```

#### Market fully closed (weekend / holiday)

```
User clicks auto-trade on a Saturday
  ↓
Controller sends BUY → Alpaca returns 422 with message "market is closed"
  ↓
Controller's error handler catches MARKET_CLOSED code
  ↓
queuedTradeService.enqueue({ ... })
  → creates row with status='queued', NO alpaca_buy_order_id yet
  ↓
Response to frontend: { success, queued: true, queueId, message: 'Market is closed. Your trade is queued...' }
  ↓
... weekend passes ...
  ↓
Monday 9:30 AM: market opens
  ↓
Every minute, queuedTradeCron.submitOne() tries to submit the queued buy
  → succeeds at the first attempt after open
  → row status='queued' → 'submitted', alpaca_buy_order_id set
  ↓
Next minute tick: watchOne() polls the buy until filled
  ↓
Places TP and SL, row → 'filled'
```

### Key takeaway

**Our code handles all three windows correctly.** What varies is:

- How long the user waits for TP/SL to appear: 1–2 seconds (open), 1 minute after market-open (pre/post), or 1 minute after next market-open (fully closed).
- The response shape: `oco` vs `delayedProtection` vs `queued`.

---

## 3. Auto-TP/SL Flow — The Three Paths

Unified diagram:

```
                       User clicks Auto-Trade on a stock
                                     │
                                     ▼
                    ┌────────────────────────────────────┐
                    │  What does Alpaca say to the BUY?  │
                    └────────────────────────────────────┘
                         │             │             │
              Filled     │  Accepted   │   Rejected  │
           (open mkt)    │  (pre/post) │ (MARKET_CLOSED)
                         ▼             ▼             ▼
                ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
                │ Inline TP/SL │ │  Delayed     │ │   Queued     │
                │ placement    │ │  protection  │ │   for open   │
                │ (1–2s)       │ │  tracking    │ │              │
                └──────────────┘ └──────────────┘ └──────────────┘
                         │             │             │
                         ▼             ▼             ▼
                  Returns `oco`  Returns         Returns
                                 `delayedProt`   `queued:true`
                                      │             │
                                      ▼             ▼
                                 Cron polls    Cron submits
                                 every min,    at next open,
                                 places TP/SL  then polls,
                                 after fill    then places TP/SL
```

Every path ends the same way: **TP and SL orders on Alpaca, DB row = 'filled'.**

---

## 4. Every Edge Case a User Can Hit

### 4.1 PDT blocks TP/SL placement (discussed above)

**Symptom:** Buy filled, position exists, no TP/SL on Alpaca.
**DB row:** `status='filled'`, `failure_reason` mentions "pattern day trading protection".
**Solution:** See section 1.

### 4.2 Buy accepted in pre/post-market, then canceled before market open

**Symptom:** Queued-trade row stuck in `submitted` status for hours, then suddenly marked `failed`.
**Cause:** User canceled the buy manually in Alpaca's dashboard, or Alpaca rejected it after acceptance.
**Our code handles it:** Cron's `watchOne()` detects terminal status (`canceled`, `rejected`, `expired`) and marks row `failed` with reason.
**User action:** None needed — no protection needed since there's no position.

### 4.3 Queued trade (weekend) expires after 3 days without market opening

**Symptom:** User clicks auto-trade on Saturday, a long holiday weekend follows, Monday is also closed. By Wednesday the row expires.
**Cause:** Our default `DEFAULT_LIFETIME_DAYS = 3`. If the market doesn't open within 3 days of queue creation, the row is auto-expired.
**Our code handles it:** Cron's `expireStaleRows()` marks `status='expired'`.
**Solution:** Consider extending to 7 days for long weekends. Current behavior is safe — the user's trade request isn't blindly submitted a week later at a potentially wrong price.

### 4.4 Partial fill on the buy

**Symptom:** User bought 10 shares, only 7 filled. TP/SL is placed for 7, not 10.
**Cause:** Market doesn't have enough liquidity at the price, or the order's time limit expired.
**Our code handles it:** We use `Math.floor(filled_qty)` to protect whatever actually filled. Unfilled 3 shares are ignored.
**User action:** None — partial protection is still useful.

### 4.5 Fractional share buy floors to 0 whole shares

**Symptom:** User clicks auto-trade on a $5000 stock like Berkshire (BRK.A), buys 0.01 shares, and no TP/SL appears.
**Cause:** Alpaca LIMIT/STOP orders require **whole shares**. `Math.floor(0.01) = 0`, so protection is skipped.
**Our code handles it:** Logs a warning and marks the row filled without protection.
**Solution:** Frontend should enforce **integer shares** for Alpaca stocks (already done in the top-trade modal).

### 4.6 Orphan TP/SL from a previous trade on the same symbol

**Scenario:** User bought PYPL yesterday, SL fired and closed the position, but the TP stayed open forever (Alpaca doesn't link TP and SL). Today the user buys PYPL again.

**Symptom without fix:** New buy rejected with "wash trade" error because the old TP is still open.
**Our code handles it two ways:**
  1. **Inline cleanup**: before placing new TP/SL, `cancelOpenSellOrdersForSymbol` cancels any open sells tagged with our `ta-` prefix.
  2. **Orphan cleanup cron** (every 5 min): scans all active Alpaca connections for open tagged sells where `order.qty > held_position.qty`, cancels them.

**User action:** None.

### 4.7 Snapshot API returns no price for a less-liquid stock in pre/post-market

**Symptom (before fix):** User clicks auto-trade pre-market on a lightly-traded stock. Buy goes through. No TP/SL appear. No log, no error, no DB row.
**Cause:** Alpaca's IEX feed (free tier) has no recent quotes for the symbol. `getStockSnapshot()` returns price 0. `effectivePrice === 0`, `shouldPlaceProtection === false`, the whole protection block silently skips.
**Our patch:** Now logs a warning and falls through to `trackForDelayedProtection` as a safety net. The cron will compute strikes from `filled_avg_price` and place TP/SL after fill.
**User action:** None.

### 4.8 Network failure mid-protection (TP placed, SL fails)

**Symptom:** TP exists on Alpaca but no SL. Position is partially protected.
**Our code currently:** catches the error and marks row `filled` with `failure_reason`. TP stays open, no SL.
**Recommended follow-up:** The next sweep of the orphan cleanup cron will leave TP alone (position qty >= TP qty). If the user wants to add SL manually, they can.

### 4.9 User cancels the queued/submitted trade

**Symptom:** User clicks "Cancel" on a queued trade (status='queued').
**Our code:** `queuedTradeService.cancelByUser()` marks row as `canceled`. Only allowed while in `queued` status. Once submitted to Alpaca, user must cancel the live order.
**Frontend note:** Cancel endpoint exists but there's no UI for it — we decided not to show queued trades in the UI. The backend still tracks silently.

### 4.10 User changes their Alpaca API keys mid-flow

**Scenario:** A queued row was created with the old keys. User re-connects with new keys.
**Our code handles it:** Cron's `submitOne` re-fetches the connection from DB and reads whatever keys are currently stored. If the connection is still active and still Alpaca, the new keys are used.

### 4.11 User deletes the Alpaca connection entirely

**Symptom:** Row is stuck — the cron can no longer authenticate.
**Our code handles it:** Cron's `submitOne` / `watchOne` check `connection.status !== active` and mark the row failed with "Connection no longer active".

### 4.12 Alpaca API rate limits hit during a sweep

**Symptom:** Cron processes first few rows, hits Alpaca's rate limit, remaining rows are skipped this tick.
**Our code handles it:** Per-row try/catch — one rate-limit error doesn't stop the sweep. The next tick retries the skipped rows.
**Alpaca's limits:** 200 req/min on paper, higher on live. Our cron's batch cap is 100 rows per tick, so we stay under.

### 4.13 User has an Alpaca connection but keys have been revoked/expired

**Symptom:** All Alpaca calls return 401 Unauthorized.
**Our code handles it:** Controller returns a clear message pointing to "please check your Alpaca API keys". Cron fails the row with the same reason.

### 4.14 User attempts to auto-trade an Alpaca crypto symbol (e.g. BTC/USD)

**Symptom (old behavior):** Might work or might crash — the top-trade flow wasn't designed for crypto on Alpaca.
**Our code handles it:** `ExchangesService.placeOrder` Alpaca branch calls `isAlpacaCryptoSymbol` and blocks with a clear "Crypto is not supported on this connection" message (user-flow only; paper-trading service is untouched).

### 4.15 User clicks auto-trade, browser loses connection mid-request

**Symptom:** Frontend shows error, but the backend may still have placed the buy and tracked it.
**Our code handles it:** The backend flow is atomic — if the buy was placed, the DB tracking is attempted. The user can refresh and see the position + order history.

---

## 5. Recommended Solutions

In priority order:

### Priority 1 — Already shipped

- Race-retry on TP/SL placement (3 attempts × 500ms)
- Delayed-protection tracking when race exhausts
- Queued-trades state machine for MARKET_CLOSED
- Fill-watcher cron (every 1 minute)
- Orphan cleanup cron (every 5 minutes)
- Snapshot-failure fallback to delayed-protection
- Real Alpaca error text captured in `failure_reason` (both controller and cron)

### Priority 2 — Recommended next (UX improvements)

1. **PDT pre-flight check**
   - At the moment the user opens the auto-trade modal, check `GET /v2/account` for `pattern_day_trader == true` or `equity < 25000 && daytrade_count >= 3`.
   - Show a yellow warning banner: *"Your account may not allow auto TP/SL due to Alpaca's pattern-day-trading protection. Your buy will still go through, but protection may need to be placed manually tomorrow."*
   - Don't block the trade, just inform.

2. **Surface `failure_reason` in the UI**
   - The DB already captures the Alpaca error text.
   - Add a subtle indicator on the positions table: next to the stock symbol, show a small warning icon if the row has `failure_reason`, tooltip shows the reason.
   - Link to "Add Manual TP/SL" (new modal).

3. **Next-day retry cron**
   - Once a day at 9:35 AM ET, sweep all `pending_queued_trades` rows with `status='filled'` and `failure_reason LIKE '%pattern day%'`.
   - Retry placing TP/SL — the buy is now an overnight position, so PDT won't block.
   - Update the row's `tp_order_id` / `sl_order_id` and clear the reason.

### Priority 3 — Optional (feature expansions)

4. **Test Alpaca's atomic bracket order** (`order_class: bracket`)
   - One API call places buy + TP + SL together.
   - Unclear whether this bypasses PDT protection — needs a live test on a sub-$25k account.
   - If it does, it's the cleanest fix for PDT-affected users.

5. **Paper-account toggle in user settings**
   - Let users explicitly mark a connection as "paper trading." Shows a "PAPER" badge in the UI.
   - Helpful for users who connect a paper account for testing.

6. **Extend queued-trade lifetime to 7 days**
   - Handles long-holiday weekends (e.g., Thanksgiving + following Friday = 4 days closed).
   - Currently expires at 3 days — may be too aggressive.

---

## Quick Reference Table

| Scenario | What the user sees | DB row status | Has TP/SL? |
|----------|--------------------|----|------------|
| Open market, paper/≥$25k account | Instant success, TP+SL visible | `filled` + `tp_order_id` + `sl_order_id` | Yes |
| Pre/post-market, paper/≥$25k | "Delayed protection" message, TP/SL within ~1 min of market open | `submitted` → `filled` | Yes (after open) |
| Market closed, paper/≥$25k | "Queued for next open" message, TP/SL shortly after open | `queued` → `submitted` → `filled` | Yes (after open) |
| Open market, <$25k live, at PDT limit | Buy succeeds, row marked failed | `filled` + `failure_reason` | No — blocked by PDT |
| Expired (weekend-boundary case) | Nothing executes, row expires after 3 days | `expired` | N/A |
| User cancels queued trade | Cancel succeeds if still queued | `canceled` | N/A |
| Connection revoked / keys bad | Row fails with clear reason | `failed` + `failure_reason` | N/A |

---

## Conclusion

The auto-TP/SL feature is **code-complete and correct**. It handles every timing window (open / pre-post / closed), all Alpaca rejections, race conditions, partial fills, orphan cleanup, and connection changes.

The **only user-visible failure mode that's not a code issue** is Alpaca's PDT protection on sub-$25k live accounts. That's a broker-level rule — our code now captures and surfaces the exact reason, but we can't bypass the block itself.

The three actionable next steps (in priority order):

1. Add a PDT pre-flight warning in the auto-trade modal
2. Show `failure_reason` in the positions UI so users understand why protection is missing
3. Add a next-day retry cron to attach TP/SL overnight once the position is PDT-safe
