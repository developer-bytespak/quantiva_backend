# Quick Start Guide - Close Unprotected Positions

## 🚀 Quick Run

### Windows (PowerShell):
```powershell
cd backend\q_nest
.\scripts\close-unprotected-positions.ps1
```

### Linux/Mac (Bash):
```bash
cd backend/q_nest
chmod +x scripts/close-unprotected-positions.sh
./scripts/close-unprotected-positions.sh
```

### Direct TypeScript:
```bash
cd backend/q_nest
npx ts-node src/modules/alpaca-paper-trading/scripts/close-unprotected-positions.ts
```

---

## 🌐 API Endpoint (Alternative)

**Run via HTTP POST:**

```bash
# Using cURL
curl -X POST http://localhost:3000/api/strategies/close-unprotected-positions

# Using PowerShell
Invoke-RestMethod -Method POST -Uri "http://localhost:3000/api/strategies/close-unprotected-positions"
```

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
      "order_id": "abc-123"
    }
  ],
  "failed": []
}
```

---

## 📊 What It Does

1. ✅ Checks all open stock positions
2. ✅ Identifies positions WITHOUT bracket orders (TP/SL)
3. ✅ Closes unprotected positions with market sell orders
4. ✅ Logs all actions to database

---

## ⚙️ Setup Automatic Check (Optional)

### Windows Task Scheduler:
1. Open Task Scheduler
2. Create Basic Task
3. Name: "Close Unprotected Positions"
4. Trigger: Every 30 minutes
5. Action: Start a program
   - Program: `powershell.exe`
   - Arguments: `-File "C:\Users\AS\Desktop\QH\backend\q_nest\scripts\close-unprotected-positions.ps1"`

### Linux/Mac Cron:
```bash
# Edit crontab
crontab -e

# Add this line (runs every 30 minutes)
*/30 * * * * cd /path/to/backend/q_nest && ./scripts/close-unprotected-positions.sh
```

---

## 🛡️ Safety Features

- ✅ Read-only check before closing
- ✅ Database audit trail (auto_trade_logs)
- ✅ Rate limiting (500ms between orders)
- ✅ Error handling (continues on failure)
- ✅ Detailed logging

---

## 📝 Example Output

```
🔍 Starting unprotected positions check...
📊 Fetching current positions...
Found 5 open position(s)

✓ AAPL has active bracket orders
✓ MSFT has active bracket orders
⚠️  UNPROTECTED: TSLA - Qty: 5, Entry: $245.30

🔴 Closing TSLA - Market sell 5 shares...
✅ Closed TSLA - Order ID: order-123

============================================================
📊 SUMMARY:
Total positions checked: 5
Protected positions: 4
Unprotected positions found: 1
Successfully closed: 1
Failed to close: 0
============================================================
```

---

For full documentation, see: `CLOSE_UNPROTECTED_POSITIONS_README.md`
