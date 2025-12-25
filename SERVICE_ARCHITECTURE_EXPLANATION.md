# Service vs Integration Service Architecture

## Why 2 Services?

This follows the **Layered Architecture Pattern** - separating concerns for better code organization, testability, and maintainability.

```
┌─────────────────────────────────────────────────────────────────┐
│                        Controller                               │
│          (HTTP endpoint, request/response handling)             │
└────────────────┬────────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Service Layer                                │
│        (Business Logic, Caching, Orchestration)                │
│    src/modules/binance-testnet/services/                       │
│    binance-testnet.service.ts                                  │
└────────────────┬────────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────────┐
│              Integration/API Layer                              │
│      (Raw API calls, HTTP requests, Data transformation)       │
│    src/modules/binance-testnet/integrations/                   │
│    binance-testnet.service.ts                                  │
└────────────────┬────────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────────┐
│         External API (Binance Testnet)                          │
│         https://testnet.binance.vision/api/v3/*                │
└─────────────────────────────────────────────────────────────────┘
```

---

## Service Layer (Business Logic)

**File**: `services/binance-testnet.service.ts`

### Responsibilities:
```typescript
import { TestnetCacheService } from './testnet-cache.service';
import { BinanceTestnetService as BinanceTestnetApiService } 
  from '../integrations/binance-testnet.service';

@Injectable()
export class BinanceTestnetService {
  constructor(
    private cacheService: TestnetCacheService,           // ← Caching
    private binanceTestnetApi: BinanceTestnetApiService, // ← Integration layer
  ) {}
  
  // Business logic methods
}
```

**What it does:**

1. **Credential Management**
   - Stores API key and secret from config
   - Validates if testnet is configured
   
2. **Caching**
   - Checks cache before making API calls
   - Stores results with TTL (3-5 seconds)
   - Example: `cacheService.get('testnet:balance')`
   
3. **Orchestration**
   - Calls integration layer to fetch data
   - Applies business rules
   - Handles errors gracefully
   
4. **Data Processing**
   - Filters data based on business needs
   - Formats responses
   - Invalidates cache when needed

### Example: `getAccountBalance()`
```typescript
async getAccountBalance(): Promise<AccountTestnetBalanceDto> {
  // Step 1: Check if configured
  if (!this.isConfigured()) {
    throw new Error('Testnet not configured');
  }

  // Step 2: Check cache
  const cacheKey = 'testnet:balance';
  const cached = this.cacheService.get(cacheKey);
  if (cached) {
    return cached;  // ← Return cached result (fast!)
  }

  // Step 3: Call integration layer
  const balance = await this.binanceTestnetApi.getAccountBalance(
    this.apiKey, 
    this.apiSecret
  );

  // Step 4: Cache result
  this.cacheService.set(cacheKey, balance, 5000);

  // Step 5: Return
  return balance;
}
```

---

## Integration/API Layer (Raw API Communication)

**File**: `integrations/binance-testnet.service.ts`

### Responsibilities:

1. **HTTP Communication**
   - Makes actual API calls to Binance
   - Uses axios client
   - Handles timeouts and network issues

2. **Authentication/Signing**
   - Creates HMAC-SHA256 signatures
   - Adds API key headers
   - Manages request timestamps
   
3. **Retry Logic**
   - Retries failed requests (3 attempts)
   - Exponential backoff
   - Handles rate limits (429 errors)
   
4. **Data Transformation**
   - Maps Binance response format to our DTOs
   - Parses numeric strings to numbers
   - Formats timestamps
   
5. **Error Handling**
   - Catches and logs API errors
   - Throws custom exceptions
   - Provides detailed error messages

### Example: `getAccountBalance()`
```typescript
async getAccountBalance(
  apiKey: string, 
  apiSecret: string
): Promise<AccountTestnetBalanceDto> {
  try {
    // Step 1: Make signed request to Binance API
    const accountInfo: BinanceTestnetAccountInfo = 
      await this.makeSignedRequest(
        'GET',
        '/v3/account',
        apiKey,
        apiSecret,
      );

    // Step 2: Filter only USDT balance
    const usdtBalance = accountInfo.balances.find(
      (balance) => balance.asset === 'USDT'
    );
    
    // Step 3: Transform to our DTO format
    const balances: AssetTestnetBalanceDto[] = usdtBalance
      ? [{
          asset: usdtBalance.asset,
          free: parseFloat(usdtBalance.free),    // ← String to number
          locked: parseFloat(usdtBalance.locked),
        }]
      : [];

    // Step 4: Calculate totals
    const totalBalanceUSD = balances.length > 0 
      ? (balances[0].free + balances[0].locked)
      : 0;

    // Step 5: Return formatted response
    return { balances, totalBalanceUSD };
    
  } catch (error) {
    this.logger.error(`Failed to get account balance: ${error.message}`);
    throw error;
  }
}
```

---

## Key Differences

| Aspect | Service Layer | Integration Layer |
|--------|---------------|-------------------|
| **Location** | `services/` | `integrations/` |
| **Purpose** | Business logic | Raw API calls |
| **Caching** | ✅ Yes | ❌ No |
| **Retry Logic** | ❌ No | ✅ Yes (3 attempts) |
| **Data Filtering** | ✅ Yes | ✅ Yes |
| **Credential Storage** | ✅ Yes | ❌ No (passed as params) |
| **API Communication** | ❌ No | ✅ Yes |
| **Error Recovery** | Catches errors | Implements retry |
| **Dependency** | Uses integration | Independent |

---

## Data Flow Example: Place an Order

```
User submits order
         ↓
┌─────────────────────────────────────────────────────┐
│ Controller (binance-testnet.controller.ts)          │
│ - Validates DTO                                      │
│ - Calls service.placeOrder()                        │
└──────────┬──────────────────────────────────────────┘
           ↓
┌─────────────────────────────────────────────────────┐
│ Service Layer (services/binance-testnet.service.ts) │
│ - Checks: isConfigured()? ✓                         │
│ - Invalidates cache: orders, balance                │
│ - Calls: binanceTestnetApi.placeOrder()             │
└──────────┬──────────────────────────────────────────┘
           ↓
┌─────────────────────────────────────────────────────┐
│ Integration Layer                                   │
│ (integrations/binance-testnet.service.ts)          │
│ - Normalizes symbol: "xmr" → "XMRUSDT"             │
│ - Creates params object                             │
│ - Calls makeSignedRequest()                         │
│   ├─ Get server time                               │
│   ├─ Create signature: HMAC-SHA256                 │
│   ├─ Make POST to /v3/order                        │
│   ├─ If fails: Retry (max 3 times)                │
│   └─ Transform response to DTO                      │
└──────────┬──────────────────────────────────────────┘
           ↓
┌─────────────────────────────────────────────────────┐
│ Binance Testnet API                                 │
│ POST /v3/order                                      │
│ Returns: { orderId: 4790550, symbol: "XMRUSDT", ..}│
└─────────────────────────────────────────────────────┘
```

---

## Benefits of This Architecture

### 1. **Separation of Concerns**
- Service = business logic
- Integration = technical details
- Easy to understand each layer's job

### 2. **Testability**
```typescript
// Easy to mock the integration layer for unit tests
const mockIntegration = {
  getAccountBalance: jest.fn().mockResolvedValue({...})
};

const service = new BinanceTestnetService(
  mockCache,
  mockIntegration  // ← Mock instead of real API
);
```

### 3. **Reusability**
- Multiple controllers can use the same service
- Multiple services can use the same integration layer
- Easy to swap implementations

### 4. **Maintainability**
- API changes? Update integration layer only
- Business rules change? Update service layer only
- Cache strategy change? Update cache service

### 5. **Performance**
- Cache at service layer (fast hits)
- Retry at integration layer (resilience)
- Both layers optimize independently

### 6. **Error Handling**
- Integration layer: Network errors, API errors
- Service layer: Business logic errors
- Each layer handles what it knows best

---

## Real Example: Caching Flow

### First Call
```
GET /binance-testnet/balance
     ↓
Service: Check cache → MISS ❌
     ↓
Call Integration Layer
     ↓
Binance API (300ms)
     ↓
Service: Store in cache (TTL: 5s)
     ↓
Return result (300ms total)
```

### Second Call (within 5 seconds)
```
GET /binance-testnet/balance
     ↓
Service: Check cache → HIT ✓
     ↓
Return cached result (< 5ms)
```

### Third Call (after 5 seconds)
```
GET /binance-testnet/balance
     ↓
Service: Check cache → EXPIRED ❌
     ↓
Call Integration Layer
     ↓
Binance API (300ms)
     ↓
Service: Update cache
     ↓
Return result (300ms total)
```

---

## Summary

| Layer | What | Why |
|-------|------|-----|
| **Service** | Orchestration, Caching, Business Logic | Optimize by reducing redundant API calls |
| **Integration** | Raw API calls, Signing, Retries | Handle technical details of API communication |
| **Together** | Fast, Reliable, Maintainable System | Best practices architecture |

Think of it like a restaurant:
- **Service = Manager** (takes orders, manages staff, applies business rules)
- **Integration = Chef** (executes the actual work, handles raw ingredients)
- **Controller = Waiter** (takes customer requests, presents responses)

Each has a specific job, and they work together! 🍕
