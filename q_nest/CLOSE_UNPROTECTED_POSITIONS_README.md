# Close Unprotected Positions Script

## Overview

This script checks for stock positions that don't have OCO sell orders (bracket orders) and automatically closes them. This is a **safety mechanism** to ensure all positions have proper exit logic (stop-loss and take-profit).

## Problem It Solves

In Alpaca paper trading, when you place a **bracket order**, it should create:
1. **Entry order** (BUY) - Main position
2. **Take-Profit leg** (SELL limit) - Exit at profit target
3. **Stop-Loss leg** (SELL stop) - Exit at loss limit

**Edge cases where this can fail:**
- System error during bracket order creation
- API timeout after BUY fills but before legs are created
- Manual trades without proper exit orders
- Network issues between order placement and confirmation

## What the Script Does

### 1. **Checks Current Positions**
- Fetches all open positions from Alpaca

### 2. **Analyzes Orders**
- Fetches all orders (including bracket order legs)
- Identifies which positions have active sell orders (TP/SL)

### 3. **Finds Unprotected Positions**
- Compares positions vs. sell orders
- Flags positions **without** any sell orders

### 4. **Closes Unprotected Positions**
- Places **market sell orders** for unprotected positions
- Logs all actions to database for audit trail

## Usage

### Option 1: Run as Standalone Script (Recommended)

**Windows (PowerShell):**
```powershell
cd backend/q_nest
.\scripts\close-unprotected-positions.ps1
```

**Linux/Mac (Bash):**
```bash
cd backend/q_nest
chmod +x scripts/close-unprotected-positions.sh
./scripts/close-unprotected-positions.sh
```

**Direct TypeScript:**
```bash
cd backend/q_nest
npx ts-node src/modules/alpaca-paper-trading/scripts/close-unprotected-positions.ts
```

### Option 2: Run via API Endpoint

**Endpoint:** `POST /strategies/close-unprotected-positions`

**Using cURL:**
```bash
curl -X POST http://localhost:3000/api/strategies/close-unprotected-positions
```

**Using Postman:**
1. Method: POST
2. URL: `http://localhost:3000/api/strategies/close-unprotected-positions`
3. Headers: (none required)
4. Body: (none required)

**Response:**
```json
{
  "success": true,
  "message": "Closed 2 unprotected position(s)",
  "total_positions": 5,
  "protected": 3,
  "unprotected": 2,
  "closed": [
    {
      "symbol": "AAPL",
      "qty": "10",
      "entry_price": "175.50",
      "close_price": "177.25",
      "pl": "17.50",
      "pl_percent": "1.00",
      "order_id": "abc-123-xyz"
    }
  ],
  "failed": []
}
```

## Example Output (Script)

```
🔍 Starting unprotected positions check...
📊 Fetching current positions...
Found 5 open position(s)
📋 Fetching all orders...
✓ AAPL has active bracket orders
✓ MSFT has active bracket orders
✓ GOOGL has active bracket orders
⚠️  UNPROTECTED: TSLA - Qty: 5, Entry: $245.30, Current: $250.10, P/L: 1.96%
⚠️  UNPROTECTED: NVDA - Qty: 8, Entry: $525.60, Current: $518.40, P/L: -1.37%

🚨 Found 2 UNPROTECTED position(s). Closing them now...

🔴 Closing TSLA - Market sell 5 shares...
✅ Closed TSLA - Order ID: order-tsla-123
🔴 Closing NVDA - Market sell 8 shares...
✅ Closed NVDA - Order ID: order-nvda-456

============================================================
📊 SUMMARY:
============================================================
Total positions checked: 5
Protected positions: 3
Unprotected positions found: 2
Successfully closed: 2
Failed to close: 0

✅ Closed positions:
   - TSLA
   - NVDA
============================================================
```

## When to Run This Script

### **Automatic (Recommended):**
Set up a **cron job** to run every 30 minutes:
```bash
# Add to crontab (Linux/Mac)
*/30 * * * * cd /path/to/backend/q_nest && ./scripts/close-unprotected-positions.sh

# Or use Windows Task Scheduler (Windows)
# Action: Start a program
# Program: powershell.exe
# Arguments: -File "C:\path\to\backend\q_nest\scripts\close-unprotected-positions.ps1"
# Triggers: Every 30 minutes
```

### **Manual (When Needed):**
- After system restarts
- After API connection issues
- When you notice positions without TP/SL on Alpaca dashboard
- Before end of trading day

## Safety Features

1. **Read-Only Check First:** Script checks positions and orders before taking action
2. **Audit Trail:** All closures logged to `auto_trade_logs` table
3. **Rate Limiting:** 500ms delay between close orders to avoid API limits
4. **Error Handling:** Failed closures are logged but don't stop the script
5. **Detailed Logging:** Full transparency of what was closed and why

## Database Logging

All position closures are logged to the database:

**Table:** `auto_trade_logs`

**Example Log Entry:**
```json
{
  "session_id": "UNPROTECTED_CLOSE_SCRIPT",
  "event_type": "POSITION_CLOSED",
  "message": "Closed unprotected position: TSLA",
  "metadata": {
    "symbol": "TSLA",
    "qty": "5",
    "entry_price": "245.30",
    "close_price": "250.10",
    "pl": "24.00",
    "pl_percent": "1.96",
    "order_id": "order-tsla-123",
    "reason": "No bracket orders or sell orders found"
  }
}
```

## Prevention Tips

To **minimize** the need for this script:

1. **Always use bracket orders** when placing trades
2. **Monitor Alpaca dashboard** for incomplete bracket orders
3. **Check auto_trade_logs** for order placement errors
4. **Test API connectivity** before starting auto-trading sessions
5. **Set up monitoring alerts** for positions without sell orders

## Technical Details

### What Counts as "Protected"?

A position is considered **protected** if it has:
- **Bracket order legs** (TP/SL) with status: `new`, `held`, `accepted`, or `pending_new`
- **OR** standalone sell orders (limit/stop) with active status

### What Gets Closed?

A position gets closed if:
- It has **no active sell orders** (no TP/SL)
- The position is **open** (qty > 0)
- No pending bracket order legs exist

### API Integration

- **Alpaca Paper Trading API:** v2/positions, v2/orders
- **Order Type:** Market sell (immediate execution)
- **Time in Force:** Day (good for current trading day)

## Troubleshooting

### Script shows "No open positions"
- Check if Alpaca account has active positions
- Verify API credentials in `.env` file

### All positions show as "protected" but you see unprotected positions on Alpaca
- Run with `nested: true` parameter to include bracket legs
- Check if sell orders are in different status (e.g., `filled`, `canceled`)

### Failed to close position
- Check Alpaca API rate limits (200 requests/minute)
- Verify position still exists (may have been closed manually)
- Check if market is open (stocks only trade during market hours)

## Files Created

1. **Main Script:** `src/modules/alpaca-paper-trading/scripts/close-unprotected-positions.ts`
2. **Bash Runner:** `scripts/close-unprotected-positions.sh`
3. **PowerShell Runner:** `scripts/close-unprotected-positions.ps1`
4. **API Endpoint:** Added to `strategies.controller.ts` (POST `/strategies/close-unprotected-positions`)
5. **Service Method:** Added `getOrders()` to `alpaca-paper-trading.service.ts`

## Support

If you encounter issues:
1. Check logs in `auto_trade_logs` table
2. Review Alpaca dashboard for order status
3. Run script with verbose logging
4. Contact support with log output and position details

---

**Last Updated:** January 30, 2026
