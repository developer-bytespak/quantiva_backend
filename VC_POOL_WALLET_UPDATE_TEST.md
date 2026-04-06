# VC Pool Wallet Address Update - Test Scenario

## Changes Made ✅

Modified: `src/modules/vc-pool/services/seat-reservation.service.ts` - `joinPool()` method

### What Was Fixed:
1. **Old Behavior:** User calls join API twice with different wallet → Get "ConflictException: You already have an active reservation"
2. **New Behavior:** User calls join API twice with different wallet → Wallet address is updated, NO error thrown

### How It Works Now:

```
User Flow:
─────────────────────────────────────────────────────────────
Step 1: POST /api/vc-pools/:id/join
  Input: { wallet: "0xABC123..." }
  Output: { reservation_id: "res-1", submission_id: "sub-1", ... }
  
Step 2: POST /api/vc-pools/:id/join (SAME POOL, DIFFERENT WALLET)
  Input: { wallet: "0xXYZ789..." }
  
  ✅ OLD CODE: ConflictException thrown ❌
  ✅ NEW CODE: 
     - Updates vc_pool_members.user_wallet_address
     - Updates vc_pool_payment_submissions.user_wallet_address
     - Returns updated response with wallet_updated: true
     - TIMER KEEPS RUNNING (no reset)
```

## Test Scenarios

### Scenario 1: First Join (New User)
```
POST /api/vc-pools/pool-123/join
{
  "payment_method": "binance",
  "user_wallet_address": "0xABC123..."
}

Expected Response (201):
{
  "reservation_id": "res-uuid",
  "submission_id": "sub-uuid",
  "deadline": "2026-04-07T10:30:00Z",
  "minutes_remaining": 30,
  "wallet_updated": false  // First time = false
}
```

### Scenario 2: Second Join (Same Pool, Within Timer)
```
POST /api/vc-pools/pool-123/join
{
  "payment_method": "binance",
  "user_wallet_address": "0xXYZ789..."  // DIFFERENT WALLET
}

Expected Response (200):
{
  "reservation_id": "res-uuid",  // SAME ID
  "submission_id": "sub-uuid",    // SAME ID
  "deadline": "2026-04-07T10:30:00Z",  // ORIGINAL DEADLINE
  "minutes_remaining": 28,        // TIMER CONTINUES
  "wallet_updated": true          // ✅ FLAG indicates update
}

Database Changes:
  - vc_pool_members.user_wallet_address: "0xABC123..." → "0xXYZ789..."
  - vc_pool_payment_submissions.user_wallet_address: "0xABC123..." → "0xXYZ789..."
```

### Scenario 3: Third Join (After Timer Expires)
```
POST /api/vc-pools/pool-123/join
{
  "payment_method": "binance",
  "user_wallet_address": "0xDEF456..."
}

Expected Response (409):
{
  error: "ConflictException",
  message: "You already have an active reservation for this pool"
}

Reason: Timer expired (> 30 mins), old reservation deleted,
user must start a fresh join
```

## Bug Fixes Included

### Fix 1: Null Submission Handling ✅
**Problem:** If payment_submission didn't exist, code tried to access `submission.submission_id` → Runtime error

**Solution:** 
```typescript
if (!submission) {
  // Create new submission if missing
  submission = await this.prisma.vc_pool_payment_submissions.create({...});
} else {
  // Update existing submission
  submission = await this.prisma.vc_pool_payment_submissions.update({...});
}
```

### Fix 2: Proper Null Coalescing ✅
- `dto.user_wallet_address || memberToUse.user_wallet_address` 
- Only updates if new value provided, keeps old value otherwise

## Database State After Update

### vc_pool_members table:
```
member_id | pool_id | user_id | user_wallet_address | user_binance_uid | ...
────────────────────────────────────────────────────────────────────────────
  m-123   | p-456   | u-789   | 0xXYZ789...        | (null)           | ...
          │                   └── UPDATED from 0xABC123...
```

### vc_pool_payment_submissions table:
```
submission_id | reservation_id | user_wallet_address | status      | ...
──────────────────────────────────────────────────────────────────────────────
   s-123      | res-456        | 0xXYZ789...        | pending     | ...
              │                │└── UPDATED from 0xABC123...
```

### vc_pool_seat_reservations table:
```
reservation_id | pool_id | user_id | expires_at          | status   | ...
──────────────────────────────────────────────────────────────────────────
  res-456      | p-456   | u-789   | 2026-04-07T10:30Z   | reserved | ...
               │                   │└── UNCHANGED (original deadline preserved)
```

## Files Modified

- `src/modules/vc-pool/services/seat-reservation.service.ts` - joinPool() method
  - Lines 85-191: Added wallet update logic
  - Lines 110-143: Submission creation/update logic
  - Added `wallet_updated` flag to response

## Frontend Integration

Frontend should:
1. Check for `wallet_updated: true` in response
2. If true → Show message "Wallet address updated successfully"
3. Keep showing countdown timer (already running)
4. User can still submit TX with same reservation & submission IDs

## Code Quality

✅ TypeScript compilation: PASS
✅ Null safety: Fixed (submission can't be null when accessed)
✅ Transaction safety: Uses atomic operations where needed
✅ Logging: Proper debug logs for wallet updates
✅ Error handling: Maintains original error scenarios for invalid states
