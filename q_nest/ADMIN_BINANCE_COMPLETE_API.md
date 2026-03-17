# 🏦 Admin Binance APIs - Complete Reference

**Base URL:** `http://localhost:3000` (dev) | `https://api.quantiva.com` (prod)

---

## 📋 API Overview

| # | Endpoint | Method | Auth | Purpose |
|---|----------|--------|------|---------|
| 1 | `/admin/binance/health` | GET | ❌ Public | Health check (no auth) |
| 2 | `/admin/binance/stream-status` | GET | ✅ Admin | Detailed stream status |
| 3 | `/admin/binance/account` | GET | ✅ Admin | Account balance & info |
| 4 | `/admin/binance/deposits` | GET | ✅ Admin | Deposit history |
| 5 | `/admin/binance/withdrawals` | GET | ✅ Admin | Withdrawal history |
| 6 | `/admin/binance/trades/:symbol` | GET | ✅ Admin | Trade history |
| 7 | `/admin/binance/summary` | GET | ✅ Admin | Account summary |

---

## 🔌 API #1 - Health Check (Public)

### Endpoint
```http
GET /admin/binance/health
```

**Auth:** ❌ **NOT required** (public endpoint)

### Request
```bash
curl -X GET "http://localhost:3000/admin/binance/health"
```

### Response (200 OK)
```json
{
  "marketStream": {
    "connected": true,
    "symbolsTracked": 150,
    "samplePrices": {
      "BTCUSDT": "43250.50",
      "ETHUSDT": "2100.75",
      "BNBUSDT": "610.30"
    }
  },
  "userDataStream": {
    "activeConnections": 5
  },
  "timestamp": "2026-03-17T10:30:45.123Z"
}
```

**Status Codes:**
- `200` - Success
- `500` - Server error

---

## 📊 API #2 - Stream Status (Admin Only)

### Endpoint
```http
GET /admin/binance/stream-status
```

**Auth:** ✅ **REQUIRED** - Admin JWT Token

### Headers
```
Authorization: Bearer {admin_jwt_token}
Content-Type: application/json
```

### Request
```bash
curl -X GET "http://localhost:3000/admin/binance/stream-status" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

### Response (200 OK)
```json
{
  "success": true,
  "data": {
    "marketStream": {
      "connected": true,
      "symbolsTracked": 150,
      "samplePrices": {
        "BTCUSDT": "43250.50",
        "ETHUSDT": "2100.75",
        "BNBUSDT": "610.30"
      }
    },
    "userDataStream": {
      "activeConnections": 5,
      "connections": [
        {
          "admin_id": "admin-uuid-1",
          "connected_since": "2026-03-17T10:15:00.000Z",
          "last_activity": "2026-03-17T10:30:45.000Z"
        }
      ]
    },
    "timestamp": "2026-03-17T10:30:45.123Z"
  }
}
```

**Status Codes:**
- `200` - Success
- `401` - Unauthorized
- `403` - Forbidden (not admin)

---

## 💰 API #3 - Account Info

### Endpoint
```http
GET /admin/binance/account
```

**Auth:** ✅ **REQUIRED** - Admin JWT Token

### Headers
```
Authorization: Bearer {admin_jwt_token}
Content-Type: application/json
```

### Query Parameters
```
None
```

### Request
```bash
curl -X GET "http://localhost:3000/admin/binance/account" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

### Response (200 OK)
```json
{
  "success": true,
  "data": {
    "account_id": "admin-uuid-1",
    "email": "admin@quantiva.com",
    "balances": [
      {
        "asset": "USDT",
        "free": "5000.50",
        "locked": "1000.00",
        "total": "6000.50"
      },
      {
        "asset": "BTC",
        "free": "0.5",
        "locked": "0.1",
        "total": "0.6"
      },
      {
        "asset": "ETH",
        "free": "10.5",
        "locked": "2.0",
        "total": "12.5"
      }
    ],
    "account_info": {
      "maker_commission": "0.001",
      "taker_commission": "0.001",
      "buy_commission": "0.001",
      "sell_commission": "0.001",
      "can_trade": true,
      "can_deposit": true,
      "can_withdraw": true
    }
  },
  "last_updated": "2026-03-17T10:30:45.123Z"
}
```

**Status Codes:**
- `200` - Success
- `400` - Bad Request
- `401` - Unauthorized

---

## 📥 API #4 - Deposit History

### Endpoint
```http
GET /admin/binance/deposits
```

**Auth:** ✅ **REQUIRED** - Admin JWT Token

### Headers
```
Authorization: Bearer {admin_jwt_token}
Content-Type: application/json
```

### Query Parameters (All Optional)

| Parameter | Type | Default | Max | Description |
|-----------|------|---------|-----|-------------|
| `coin` | string | - | - | Filter by coin (e.g., USDT, BTC) |
| `status` | integer | - | - | Status code (0=pending, 1=success) |
| `offset` | integer | 0 | - | Pagination offset |
| `limit` | integer | 100 | 1000 | Items per page |
| `startTime` | timestamp | - | - | Start timestamp (milliseconds) |
| `endTime` | timestamp | - | - | End timestamp (milliseconds) |

### Examples

**Example 1: Get USDT deposits**
```bash
curl -X GET "http://localhost:3000/admin/binance/deposits?coin=USDT" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

**Example 2: Get pending deposits with pagination**
```bash
curl -X GET "http://localhost:3000/admin/binance/deposits?status=0&offset=0&limit=50" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

**Example 3: Get deposits in date range**
```bash
curl -X GET "http://localhost:3000/admin/binance/deposits?startTime=1710691200000&endTime=1710777600000" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

### Response (200 OK)
```json
{
  "success": true,
  "data": [
    {
      "id": "deposit-uuid-1",
      "coin": "USDT",
      "amount": "1000.00",
      "address": "0x742d35Cc6634C0532925a3b844Bc9e7595f123456",
      "addressTag": null,
      "txId": "0xabc123def456ghi789jkl012mno345pqr456stu789vwx",
      "insertTime": 1710691200000,
      "status": 1,
      "statusText": "Success",
      "confirmTimes": "10/10",
      "unlockConfirm": 10,
      "network": "BSC"
    },
    {
      "id": "deposit-uuid-2",
      "coin": "BTC",
      "amount": "0.5",
      "address": "1A1z7agoat5cf6fBBn5gKvGqbsBn5Xg6FW",
      "addressTag": null,
      "txId": "abc123def456ghi789jkl012mno345pqr456s",
      "insertTime": 1710604800000,
      "status": 0,
      "statusText": "Pending",
      "confirmTimes": "5/6",
      "unlockConfirm": 6,
      "network": "BTC"
    }
  ],
  "count": 2,
  "last_updated": "2026-03-17T10:30:45.123Z"
}
```

**Status Codes:**
- `200` - Success
- `400` - Bad Request
- `401` - Unauthorized

---

## 📤 API #5 - Withdrawal History

### Endpoint
```http
GET /admin/binance/withdrawals
```

**Auth:** ✅ **REQUIRED** - Admin JWT Token

### Headers
```
Authorization: Bearer {admin_jwt_token}
Content-Type: application/json
```

### Query Parameters (All Optional)

| Parameter | Type | Default | Max | Description |
|-----------|------|---------|-----|-------------|
| `coin` | string | - | - | Filter by coin (e.g., USDT, BTC) |
| `status` | integer | - | - | Status code (0=pending, 1=success, 2=failed) |
| `offset` | integer | 0 | - | Pagination offset |
| `limit` | integer | 100 | 1000 | Items per page |
| `startTime` | timestamp | - | - | Start timestamp (milliseconds) |
| `endTime` | timestamp | - | - | End timestamp (milliseconds) |

### Examples

**Example 1: Get USDT withdrawals**
```bash
curl -X GET "http://localhost:3000/admin/binance/withdrawals?coin=USDT" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

**Example 2: Get successful withdrawals**
```bash
curl -X GET "http://localhost:3000/admin/binance/withdrawals?status=1&limit=50" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

**Example 3: Get withdrawals in date range**
```bash
curl -X GET "http://localhost:3000/admin/binance/withdrawals?startTime=1710691200000&endTime=1710777600000" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

### Response (200 OK)
```json
{
  "success": true,
  "data": [
    {
      "id": "withdrawal-uuid-1",
      "coin": "USDT",
      "withdrawOrderId": "withdraw-order-123456",
      "network": "BSC",
      "address": "0x742d35Cc6634C0532925a3b844Bc9e7595f123456",
      "addressTag": null,
      "txId": "0xabc123def456ghi789jkl012mno345pqr456stu789vwx",
      "amount": "500.00",
      "transactionFee": "1.00",
      "status": 1,
      "statusText": "Success",
      "completeTime": 1710695400000,
      "insertTime": 1710691200000
    },
    {
      "id": "withdrawal-uuid-2",
      "coin": "BTC",
      "withdrawOrderId": "withdraw-order-123457",
      "network": "BTC",
      "address": "1A1z7agoat5cf6fBBn5gKvGqbsBn5Xg6FW",
      "addressTag": null,
      "txId": "fff456def789ghi012xyz345pqr678stu901v",
      "amount": "0.25",
      "transactionFee": "0.0005",
      "status": 2,
      "statusText": "Failed",
      "failedReason": "Insufficient balance",
      "completeTime": 1710604800000,
      "insertTime": 1710601200000
    }
  ],
  "count": 2,
  "last_updated": "2026-03-17T10:30:45.123Z"
}
```

**Status Codes:**
- `200` - Success
- `400` - Bad Request
- `401` - Unauthorized

---

## 🏷️ API #6 - Trade History

### Endpoint
```http
GET /admin/binance/trades/:symbol
```

**Auth:** ✅ **REQUIRED** - Admin JWT Token

### Headers
```
Authorization: Bearer {admin_jwt_token}
Content-Type: application/json
```

### Path Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `symbol` | string | Yes | Trading pair (e.g., BTCUSDT, ETHUSDT) |

### Query Parameters

| Parameter | Type | Default | Max | Description |
|-----------|------|---------|-----|-------------|
| `limit` | integer | 50 | 1000 | Number of trades to return |

### Examples

**Example 1: Get BTC/USDT trades**
```bash
curl -X GET "http://localhost:3000/admin/binance/trades/BTCUSDT" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

**Example 2: Get ETH/USDT trades with limit**
```bash
curl -X GET "http://localhost:3000/admin/binance/trades/ETHUSDT?limit=100" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

### Response (200 OK)
```json
{
  "success": true,
  "data": [
    {
      "symbol": "BTCUSDT",
      "id": "trade-uuid-1",
      "orderId": "order-123456",
      "price": "43250.50",
      "qty": "0.1",
      "commission": "0.43",
      "commissionAsset": "USDT",
      "time": 1710695400000,
      "isBuyer": true,
      "isMaker": false,
      "isBestMatch": true
    },
    {
      "symbol": "BTCUSDT",
      "id": "trade-uuid-2",
      "orderId": "order-123457",
      "price": "43200.00",
      "qty": "0.05",
      "commission": "0.216",
      "commissionAsset": "USDT",
      "time": 1710691200000,
      "isBuyer": false,
      "isMaker": true,
      "isBestMatch": true
    }
  ],
  "count": 2,
  "symbol": "BTCUSDT",
  "last_updated": "2026-03-17T10:30:45.123Z"
}
```

**Status Codes:**
- `200` - Success
- `400` - Bad Request (missing symbol)
- `401` - Unauthorized

---

## 📈 API #7 - Account Summary

### Endpoint
```http
GET /admin/binance/summary
```

**Auth:** ✅ **REQUIRED** - Admin JWT Token

### Headers
```
Authorization: Bearer {admin_jwt_token}
Content-Type: application/json
```

### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `coin` | string | Optional - Filter summary by specific coin |

### Examples

**Example 1: Get overall summary**
```bash
curl -X GET "http://localhost:3000/admin/binance/summary" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

**Example 2: Get summary for USDT only**
```bash
curl -X GET "http://localhost:3000/admin/binance/summary?coin=USDT" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

### Response (200 OK)
```json
{
  "success": true,
  "data": {
    "account_summary": {
      "total_balance_usdt": "50000.00",
      "total_deposits_count": 15,
      "total_deposits_amount": "35000.00",
      "total_withdrawals_count": 5,
      "total_withdrawals_amount": "10000.00",
      "net_amount": "25000.00"
    },
    "deposits": {
      "total_count": 15,
      "total_amount": "35000.00",
      "pending_count": 1,
      "pending_amount": "1000.00",
      "completed_count": 14,
      "completed_amount": "34000.00",
      "success_rate_percent": "93.33"
    },
    "withdrawals": {
      "total_count": 5,
      "total_amount": "10000.00",
      "pending_count": 0,
      "pending_amount": "0.00",
      "completed_count": 5,
      "completed_amount": "10000.00",
      "failed_count": 0,
      "failed_amount": "0.00",
      "success_rate_percent": "100.00"
    },
    "asset_breakdown": [
      {
        "asset": "USDT",
        "free_balance": "5000.50",
        "locked_balance": "1000.00",
        "total_balance": "6000.50",
        "deposit_amount": "30000.00",
        "withdrawal_amount": "8000.00"
      },
      {
        "asset": "BTC",
        "free_balance": "0.5",
        "locked_balance": "0.1",
        "total_balance": "0.6",
        "deposit_amount": "5000.00",
        "withdrawal_amount": "2000.00"
      }
    ],
    "trading_stats": {
      "total_trades": 45,
      "total_volume": "125750.00",
      "average_trade_size": "2794.44",
      "win_rate_percent": "68.89"
    }
  },
  "last_updated": "2026-03-17T10:30:45.123Z"
}
```

**Status Codes:**
- `200` - Success
- `400` - Bad Request
- `401` - Unauthorized

---

## ⚠️ Error Responses

### 400 - Bad Request
```json
{
  "statusCode": 400,
  "message": "Bad Request",
  "error": "Detailed error message",
  "timestamp": "2026-03-17T10:30:45.123Z"
}
```

### 401 - Unauthorized
```json
{
  "statusCode": 401,
  "message": "Unauthorized",
  "error": "Invalid or expired token",
  "timestamp": "2026-03-17T10:30:45.123Z"
}
```

### 403 - Forbidden
```json
{
  "statusCode": 403,
  "message": "Forbidden",
  "error": "Admin privileges required",
  "timestamp": "2026-03-17T10:30:45.123Z"
}
```

### 500 - Internal Server Error
```json
{
  "statusCode": 500,
  "message": "Internal Server Error",
  "error": "Failed to process request",
  "timestamp": "2026-03-17T10:30:45.123Z"
}
```

---

## 🔐 Authentication

All endpoints except `/admin/binance/health` require **Admin JWT Token**:

```
Authorization: Bearer {admin_jwt_token}
```

### Get Token
```bash
curl -X POST "http://localhost:3000/admin/auth/login" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@example.com",
    "password": "your_password"
  }'
```

**Response:**
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "Bearer",
  "expires_in": 86400
}
```

---

## 📊 Status Codes Summary

| Code | Status | Meaning |
|------|--------|---------|
| **200** | ✅ Success | Request successful |
| **400** | ❌ Bad Request | Invalid parameters or request body |
| **401** | ❌ Unauthorized | Missing or invalid JWT token |
| **403** | ❌ Forbidden | User is not admin |
| **500** | ❌ Server Error | Internal server error |

---

## 🧪 Quick Test Commands

```bash
# 1. Login as admin
curl -X POST "http://localhost:3000/admin/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"password"}'

# Copy the access_token from response

# 2. Test health check (no auth)
curl -X GET "http://localhost:3000/admin/binance/health"

# 3. Test account info (with auth)
curl -X GET "http://localhost:3000/admin/binance/account" \
  -H "Authorization: Bearer YOUR_TOKEN"

# 4. Test deposit history
curl -X GET "http://localhost:3000/admin/binance/deposits?limit=10" \
  -H "Authorization: Bearer YOUR_TOKEN"

# 5. Test withdrawal history
curl -X GET "http://localhost:3000/admin/binance/withdrawals?limit=10" \
  -H "Authorization: Bearer YOUR_TOKEN"

# 6. Test trade history
curl -X GET "http://localhost:3000/admin/binance/trades/BTCUSDT?limit=20" \
  -H "Authorization: Bearer YOUR_TOKEN"

# 7. Test summary
curl -X GET "http://localhost:3000/admin/binance/summary" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

**All APIs tested and ready to use!** ✅
