# 👤 User Binance APIs - Complete Reference

**Base URL:** `http://localhost:3000` (dev) | `https://api.quantiva.com` (prod)

---

## 📋 API Overview

| # | Endpoint | Method | Auth | Purpose |
|---|----------|--------|------|---------|
| 1 | `/users/binance/account` | GET | ✅ User | Own account balance & info |
| 2 | `/users/binance/deposits` | GET | ✅ User | Own deposit history |
| 3 | `/users/binance/withdrawals` | GET | ✅ User | Own withdrawal history |
| 4 | `/users/binance/summary` | GET | ✅ User | Own account summary & stats |

---

## 💰 API #1 - Account Info

### Endpoint
```http
GET /users/binance/account
```

**Auth:** ✅ **REQUIRED** - User JWT Token

### Headers
```
Authorization: Bearer {user_jwt_token}
Content-Type: application/json
```

### Query Parameters
```
None
```

### Request
```bash
curl -X GET "http://localhost:3000/users/binance/account" \
  -H "Authorization: Bearer YOUR_USER_TOKEN"
```

### Response (200 OK)
```json
{
  "success": true,
  "data": {
    "user_id": "user-uuid-123",
    "email": "user@example.com",
    "balances": [
      {
        "asset": "USDT",
        "free": "2500.50",
        "locked": "500.00",
        "total": "3000.50"
      },
      {
        "asset": "BTC",
        "free": "0.25",
        "locked": "0.05",
        "total": "0.30"
      },
      {
        "asset": "ETH",
        "free": "5.5",
        "locked": "1.0",
        "total": "6.5"
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

## 📥 API #2 - Deposit History

### Endpoint
```http
GET /users/binance/deposits
```

**Auth:** ✅ **REQUIRED** - User JWT Token

### Headers
```
Authorization: Bearer {user_jwt_token}
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
curl -X GET "http://localhost:3000/users/binance/deposits?coin=USDT" \
  -H "Authorization: Bearer YOUR_USER_TOKEN"
```

**Example 2: Get pending deposits with pagination**
```bash
curl -X GET "http://localhost:3000/users/binance/deposits?status=0&offset=0&limit=50" \
  -H "Authorization: Bearer YOUR_USER_TOKEN"
```

**Example 3: Get deposits in date range**
```bash
curl -X GET "http://localhost:3000/users/binance/deposits?startTime=1710691200000&endTime=1710777600000" \
  -H "Authorization: Bearer YOUR_USER_TOKEN"
```

**Example 4: Get successful BTC deposits**
```bash
curl -X GET "http://localhost:3000/users/binance/deposits?coin=BTC&status=1&limit=20" \
  -H "Authorization: Bearer YOUR_USER_TOKEN"
```

### Response (200 OK)
```json
{
  "success": true,
  "data": [
    {
      "id": "deposit-uuid-1",
      "coin": "USDT",
      "amount": "500.00",
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
      "coin": "USDT",
      "amount": "250.00",
      "address": "0x742d35Cc6634C0532925a3b844Bc9e7595f987654",
      "addressTag": null,
      "txId": "0xdef456ghi789jkl012mno345pqr456stu789vwx012abc",
      "insertTime": 1710604800000,
      "status": 0,
      "statusText": "Pending",
      "confirmTimes": "5/10",
      "unlockConfirm": 10,
      "network": "BSC"
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

## 📤 API #3 - Withdrawal History

### Endpoint
```http
GET /users/binance/withdrawals
```

**Auth:** ✅ **REQUIRED** - User JWT Token

### Headers
```
Authorization: Bearer {user_jwt_token}
Content-Type: application/json
```

### Query Parameters (All Optional)

| Parameter | Type | Default | Max | Description |
|-----------|------|---------|-----|-------------|
| `coin` | string | - | - | Filter by coin (e.g., USDT, BTC) |
| `status` | integer | - | - | Status code (0-6, see status codes section) |
| `offset` | integer | 0 | - | Pagination offset |
| `limit` | integer | 100 | 1000 | Items per page |
| `startTime` | timestamp | - | - | Start timestamp (milliseconds) |
| `endTime` | timestamp | - | - | End timestamp (milliseconds) |

### Examples

**Example 1: Get USDT withdrawals**
```bash
curl -X GET "http://localhost:3000/users/binance/withdrawals?coin=USDT" \
  -H "Authorization: Bearer YOUR_USER_TOKEN"
```

**Example 2: Get completed withdrawals (status 6)**
```bash
curl -X GET "http://localhost:3000/users/binance/withdrawals?status=6&limit=50" \
  -H "Authorization: Bearer YOUR_USER_TOKEN"
```

**Example 3: Get pending withdrawals (status 4)**
```bash
curl -X GET "http://localhost:3000/users/binance/withdrawals?status=4" \
  -H "Authorization: Bearer YOUR_USER_TOKEN"
```

**Example 4: Get withdrawals in date range**
```bash
curl -X GET "http://localhost:3000/users/binance/withdrawals?startTime=1710691200000&endTime=1710777600000" \
  -H "Authorization: Bearer YOUR_USER_TOKEN"
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
      "amount": "250.00",
      "transactionFee": "0.50",
      "status": 6,
      "statusText": "Completed",
      "completeTime": 1710695400000,
      "applyTime": 1710691200000
    },
    {
      "id": "withdrawal-uuid-2",
      "coin": "USDT",
      "withdrawOrderId": "withdraw-order-123457",
      "network": "BSC",
      "address": "0x742d35Cc6634C0532925a3b844Bc9e7595f654321",
      "addressTag": null,
      "txId": "0xdef456ghi789jkl012mno345pqr456stu789vwx012abc",
      "amount": "100.00",
      "transactionFee": "0.20",
      "status": 4,
      "statusText": "Processing",
      "completeTime": null,
      "applyTime": 1710604800000
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

## 📊 API #4 - Account Summary

### Endpoint
```http
GET /users/binance/summary
```

**Auth:** ✅ **REQUIRED** - User JWT Token

### Headers
```
Authorization: Bearer {user_jwt_token}
Content-Type: application/json
```

### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `coin` | string | Optional - Filter summary by specific coin |

### Examples

**Example 1: Get overall summary**
```bash
curl -X GET "http://localhost:3000/users/binance/summary" \
  -H "Authorization: Bearer YOUR_USER_TOKEN"
```

**Example 2: Get summary for USDT only**
```bash
curl -X GET "http://localhost:3000/users/binance/summary?coin=USDT" \
  -H "Authorization: Bearer YOUR_USER_TOKEN"
```

### Response (200 OK)
```json
{
  "success": true,
  "data": {
    "account_summary": {
      "total_balance_usdt": "25000.00",
      "total_deposits_count": 8,
      "total_deposits_amount": "18000.00",
      "total_withdrawals_count": 3,
      "total_withdrawals_amount": "5000.00",
      "net_amount": "13000.00"
    },
    "deposits": {
      "total_count": 8,
      "total_amount": "18000.00",
      "pending_count": 1,
      "pending_amount": "250.00",
      "completed_count": 7,
      "completed_amount": "17750.00",
      "success_rate_percent": "87.50"
    },
    "withdrawals": {
      "total_count": 3,
      "total_amount": "5000.00",
      "processing_count": 1,
      "processing_amount": "100.00",
      "completed_count": 2,
      "completed_amount": "4900.00",
      "failed_count": 0,
      "failed_amount": "0.00",
      "success_rate_percent": "100.00"
    },
    "asset_breakdown": [
      {
        "asset": "USDT",
        "free_balance": "2500.50",
        "locked_balance": "500.00",
        "total_balance": "3000.50",
        "deposit_amount": "18000.00",
        "withdrawal_amount": "5000.00"
      },
      {
        "asset": "BTC",
        "free_balance": "0.25",
        "locked_balance": "0.05",
        "total_balance": "0.30",
        "deposit_amount": "0.5",
        "withdrawal_amount": "0.2"
      }
    ]
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

All user binance endpoints require **User JWT Token**:

```
Authorization: Bearer {user_jwt_token}
```

### Get Token (User Login)
```bash
curl -X POST "http://localhost:3000/auth/login" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "your_password"
  }'
```

**Response:**
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "Bearer",
  "expires_in": 86400,
  "user_id": "user-uuid-123"
}
```

---

## 🧪 Quick Test Commands

```bash
# 1. Login as user
curl -X POST "http://localhost:3000/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"password"}'

# Copy the access_token from response

# 2. Test account info
curl -X GET "http://localhost:3000/users/binance/account" \
  -H "Authorization: Bearer YOUR_TOKEN"

# 3. Test deposit history
curl -X GET "http://localhost:3000/users/binance/deposits?limit=10" \
  -H "Authorization: Bearer YOUR_TOKEN"

# 4. Test withdrawal history
curl -X GET "http://localhost:3000/users/binance/withdrawals?limit=10" \
  -H "Authorization: Bearer YOUR_TOKEN"

# 5. Test summary
curl -X GET "http://localhost:3000/users/binance/summary" \
  -H "Authorization: Bearer YOUR_TOKEN"

# 6. Test filters
curl -X GET "http://localhost:3000/users/binance/deposits?coin=USDT&status=1" \
  -H "Authorization: Bearer YOUR_TOKEN"

curl -X GET "http://localhost:3000/users/binance/withdrawals?coin=BTC&status=6" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

**User APIs ready to use!** ✅
