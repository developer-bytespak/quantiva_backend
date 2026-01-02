# Detailed Summary: Crypto Trading with Engines - Complete Backend Process

## 🏗️ **System Architecture Overview**

The QuantivaHQ platform uses a **multi-service architecture** for crypto trading:

### **Core Components:**
1. **NestJS Backend** (`q_nest`) - TypeScript/Node.js orchestration layer
2. **Python Backend** (`q_python`) - FastAPI ML/AI analysis engine
3. **PostgreSQL Database** - Data persistence (Prisma ORM)
4. **Frontend** - Next.js application
5. **External APIs** - Binance/Exchanges, LunarCrush, News APIs

---

## 📊 **The Complete Trading Flow**

### **Phase 1: Data Collection & Asset Discovery**

**1.1 Trending Assets Discovery (LunarCrush)**
- **Cronjob**: Runs every 10 minutes via `PreBuiltSignalsCronjobService`
- **Source**: LunarCrush API fetches top 50 trending crypto assets
- **Data Stored**: `trending_assets` table
  - Galaxy Score (social sentiment aggregate)
  - Alt Rank
  - Price, Volume, Market Cap
  - 24h price changes
  - Social metrics

**1.2 News & Sentiment Data**
- Fetches latest news for each trending asset
- Sources: StockNewsAPI, LunarCrush feed
- Stored in: `trending_news` table with sentiment labels

---

### **Phase 2: Analysis Engines (Python Backend)**

The Python backend (`q_python`) contains **7 specialized analysis engines** that score each crypto asset:

#### **Engine 1: Sentiment Engine** (35% weight)
**File**: `sentiment_engine.py`

**Process:**
1. **News Fetching**: Gets recent news from LunarCrush/StockNewsAPI
2. **FinBERT Analysis**: 
   - Pre-trained financial sentiment model
   - Analyzes each news headline/article
   - Returns: Positive/Negative/Neutral with confidence
3. **Keyword Analysis**: Crypto-specific keywords (bullish/bearish signals)
4. **Social Metrics**: 
   - Twitter volume/sentiment
   - Reddit discussions
   - Galaxy Score from LunarCrush
5. **EMA Smoothing**: Exponential Moving Average (α=0.125) for stability
6. **Output**: Score [-1, 1] + confidence [0, 1]

**Key Features:**
- Lazy-loads FinBERT model (doesn't block startup)
- Caches results (TTL: seconds-minutes)
- Multi-source aggregation with weighted scoring

---

#### **Engine 2: Technical Engine** (25% weight)
**File**: `technical_engine.py`

**Process:**
1. **OHLCV Data Fetching**:
   - **Primary Source**: User's connected exchange (Binance/Bybit) via API
   - **Connection Flow**: NestJS → User Exchange Connections → Fetch OHLCV
   - **Timeframes**: 1h, 4h, 1d (multi-timeframe analysis)
   
2. **Technical Indicators Calculated**:
   - **Moving Averages**: MA20, MA50, MA200
   - **RSI** (Relative Strength Index): 14, 30 periods
   - **MACD** (Moving Average Convergence Divergence): 12, 26, 9
   - **ATR** (Average True Range): 14 periods
   - **Trend Structure**: Higher highs/lows analysis

3. **Multi-Timeframe Scoring**:
   ```python
   # Formula from code:
   trend_score = (
       0.40 * daily_trend +    # 1d timeframe
       0.35 * 4h_trend +       # 4h timeframe  
       0.25 * hourly_trend     # 1h timeframe
   )
   ```

4. **Output**: Score [-1, 1] + confidence + indicators metadata

**Critical Dependency:**
- Requires `connection_id` from `user_exchange_connections` table
- Without connection: Returns neutral score (0.0)

---

#### **Engine 3: Fundamental Engine** (15% weight)
**File**: `fundamental_engine.py`

**Crypto-Specific Analysis**:
1. **On-Chain Metrics** (if available):
   - Network activity (transactions/day)
   - Active addresses
   - Hash rate (for PoW coins)
   
2. **Market Fundamentals**:
   - Market Cap rank
   - Volume trends
   - Liquidity metrics
   
3. **Social Fundamentals**:
   - GitHub activity (for open-source projects)
   - Developer engagement
   - Community growth

4. **External APIs**: LunarCrush, CoinGecko
5. **Output**: Score [0, 1] + confidence

---

#### **Engine 4: Event Risk Engine** (15% weight)
**File**: `event_risk_engine.py`

**Monitors:**
1. **Upcoming Events** (30 days ahead):
   - Protocol upgrades
   - Hard forks
   - Major partnerships
   - Conference announcements
   
2. **Risk Assessment**:
   - High impact events → Lower score (caution)
   - Positive catalysts → Higher score
   
3. **Sources**: LunarCrush events API
4. **Output**: Score [-1, 1] (negative = high risk)

---

#### **Engine 5: Liquidity Engine** (10% weight)
**File**: `liquidity_engine.py`

**Analyzes:**
1. **Order Book Depth**:
   - Bid/Ask spread
   - Volume at key price levels
   - Market depth score
   
2. **Trading Volume**:
   - 24h volume vs 30-day average
   - Volume trend analysis
   
3. **Slippage Estimation**:
   - Expected price impact for large orders
   
4. **Output**: Score [0, 1] + metadata

---

#### **Engine 6: Fusion Engine** (Combines All)
**File**: `fusion_engine.py`

**Master Scoring Formula**:
```python
final_score = (
    0.35 * sentiment_score +
    0.25 * technical_score +
    0.15 * fundamental_score +
    0.15 * event_risk_score +
    0.10 * liquidity_score
)
```

**Action Determination**:
```python
if final_score > 0.3:
    action = "BUY"
elif final_score < -0.3:
    action = "SELL"
else:
    action = "HOLD"
    
# Adjusted for event risk:
if event_risk_score < -0.5:
    action = "HOLD"  # Override to HOLD if high risk
```

**Output**: Final score [-1, 1] + action (BUY/SELL/HOLD) + confidence

---

#### **Engine 7: Confidence Engine** (Position Sizing)
**File**: `confidence_engine.py`

**Calculates Trade Size**:
```python
base_allocation = portfolio_value * 0.02  # 2% risk per trade

position_size = base_allocation * (
    sentiment_confidence * 0.4 +
    trend_strength * 0.3 +
    data_freshness * 0.2 +
    diversification_weight * 0.1
)

# Apply Kelly Criterion if enabled
if use_kelly:
    kelly_fraction = (win_rate * avg_win - (1 - win_rate) * avg_loss) / avg_win
    position_size *= kelly_fraction
```

**Risk Management**:
- Max allocation: 10% per asset
- Stop loss distance affects sizing
- Portfolio diversification penalty

---

### **Phase 3: Signal Generation**

**Service**: `SignalGenerator` (Python)
**Orchestration**: `StrategyExecutionService` (NestJS)

**Flow**:
```
1. NestJS receives strategy execution request
   ├─ User strategy OR pre-built admin strategy
   ├─ Target asset (e.g., BTC)
   └─ Get user's exchange connection
   
2. NestJS calls Python API: POST /api/v1/signals/generate
   ├─ Payload includes:
   │   ├─ strategy_id
   │   ├─ asset_id (symbol)
   │   ├─ strategy_data (entry/exit rules, timeframe)
   │   ├─ market_data (current price, volume)
   │   ├─ connection_id (for OHLCV fetching)
   │   └─ exchange name (binance/bybit)
   
3. Python runs all 7 engines in sequence:
   ├─ Sentiment Engine → sentiment_score
   ├─ Technical Engine → technical_score (uses connection_id)
   ├─ Fundamental Engine → fundamental_score
   ├─ Event Risk Engine → event_risk_score
   ├─ Liquidity Engine → liquidity_score
   ├─ Fusion Engine → final_score + action
   └─ Confidence Engine → position_sizing
   
4. Strategy Executor applies custom rules (if any):
   ├─ Entry rules: "MA20 > MA50 AND RSI < 30"
   ├─ Exit rules: "RSI > 70 OR price > take_profit"
   └─ Can override Fusion engine's action
   
5. Python returns complete signal object:
   {
     "final_score": 0.65,
     "action": "BUY",
     "confidence": 0.78,
     "engine_scores": {...},
     "position_sizing": {
       "position_size": 0.05,  # BTC amount
       "position_value": 2500  # USD
     }
   }
```

---

### **Phase 4: Signal Storage & LLM Explanation**

**NestJS Service**: `StrategyExecutionService`

**1. Store Signal in Database**:
```typescript
// Insert into strategy_signals table
await prisma.strategy_signals.create({
  data: {
    strategy_id: strategyId,
    user_id: userId,
    asset_id: assetId,
    timestamp: new Date(),
    final_score: pythonSignal.final_score,
    action: pythonSignal.action,  // BUY/SELL/HOLD
    confidence: pythonSignal.confidence,
    sentiment_score: pythonSignal.engine_scores.sentiment.score,
    trend_score: pythonSignal.engine_scores.trend.score,
    // ... other engine scores
  }
});
```

**2. Store Signal Details**:
```typescript
// Insert into signal_details table
await prisma.signal_details.create({
  data: {
    signal_id: signal.signal_id,
    entry_price: marketData.price,
    position_size: pythonSignal.position_sizing.position_size,
    position_value: pythonSignal.position_sizing.position_value,
    stop_loss: calculateStopLoss(strategy.stop_loss_value),
    take_profit_1: calculateTakeProfit(strategy.take_profit_value),
    metadata: pythonSignal.metadata
  }
});
```

**3. Generate AI Explanation (Optional)**:
```typescript
// Call Python LLM service
const llmResponse = await pythonApi.post('/api/v1/llm/explain-signal', {
  signal_data: {
    action: "BUY",
    final_score: 0.65,
    confidence: 0.78
  },
  engine_scores: pythonSignal.engine_scores,
  asset_id: "BTC",
  asset_type: "crypto"
});

// Store explanation
await prisma.signal_explanations.create({
  data: {
    signal_id: signal.signal_id,
    llm_model: "gpt-4o-mini",
    text: llmResponse.data.explanation,
    explanation_status: "generated"
  }
});
```

**Example LLM Explanation**:
> "Strong BUY signal for Bitcoin based on multiple bullish indicators. Sentiment analysis shows 78% positive news coverage with strong social metrics (Galaxy Score: 85/100). Technical analysis confirms uptrend with MA20 crossing above MA50, RSI at 45 (neutral-bullish), and MACD showing bullish momentum. Fundamentals remain solid with increasing network activity. Event calendar shows no major risks ahead. Recommended position size: 0.05 BTC ($2,500) with stop-loss at $48,500 (-3%) and take-profit at $52,000 (+4%)."

---

## 🔄 **Automated Workflow (Cronjob)**

**Every 10 Minutes**:
```
PreBuiltSignalsCronjobService.generatePreBuiltSignals()
├─ Step 1: Get 4 pre-built strategies (admin-created)
├─ Step 2: Fetch 50 trending crypto assets (LunarCrush)
├─ Step 3: Get first available exchange connection (for OHLCV)
├─ Step 4: Process each asset (batch of 3):
│   ├─ Run sentiment analysis (news fetching + FinBERT)
│   ├─ Generate signals for all 4 strategies
│   │   ├─ Call Python engines (all 7)
│   │   ├─ Store signal in database
│   │   └─ Skip LLM explanation (too expensive in bulk)
│   └─ Sleep 500ms between batches
├─ Step 5: Generate LLM explanations for top 10 signals/strategy
└─ Complete: ~50 assets × 4 strategies = 200 signals generated
```

**Result**: Users see pre-analyzed signals for trending crypto without manual trigger.

---

## 📂 **Database Schema Summary**

**Key Tables**:
- `strategies` - User/admin trading strategies
- `strategy_signals` - Generated trading signals (BUY/SELL/HOLD)
- `signal_details` - Entry/exit prices, position sizing
- `signal_explanations` - LLM-generated explanations
- `orders` - Executed trades
- `order_executions` - Actual fill details from exchange
- `user_exchange_connections` - Encrypted API keys
- `trending_assets` - LunarCrush data (every 10 min)
- `trending_news` - Crypto news with sentiment

---

## 🎯 **Key Differentiators**

1. **Multi-Engine Architecture**: 7 specialized engines vs single-indicator systems
2. **Multi-Timeframe Analysis**: 1h/4h/1d for robust trend detection
3. **AI-Powered Sentiment**: FinBERT + social metrics + keyword analysis
4. **Dynamic Position Sizing**: Risk-adjusted based on confidence + Kelly Criterion
5. **Explainable AI**: LLM generates human-readable trade rationale
6. **Exchange-Agnostic**: Works with Binance, Bybit, etc. via unified API
7. **Paper Trading**: Risk-free testing on Binance testnet
8. **Automated Discovery**: Cronjob analyzes trending assets automatically

---

## 🔧 **Technical Stack**

**Backend**:
- NestJS (TypeScript) - API orchestration
- FastAPI (Python) - ML/AI processing
- Prisma ORM - Database access
- PostgreSQL - Data storage

**ML/AI Libraries**:
- FinBERT (Transformers) - Financial sentiment
- pandas-ta - Technical indicators
- pandas/numpy - Data manipulation
- OpenAI/Gemini - LLM explanations

**External APIs**:
- LunarCrush - Social sentiment + trending data
- Binance/Bybit APIs - OHLCV + order execution
- CoinGecko - Market data
- StockNewsAPI - News articles

---

## 📈 **Example: Complete BTC Trade Flow**

```
1. [10:00 AM] Cronjob fetches LunarCrush data
   └─ BTC ranked #1 trending (Galaxy Score: 85/100)

2. [10:01 AM] Sentiment Engine runs
   ├─ Fetches 10 news articles about BTC
   ├─ FinBERT analyzes: 7 positive, 2 neutral, 1 negative
   ├─ Social metrics: High Twitter volume, positive Reddit sentiment
   └─ Output: sentiment_score = 0.72, confidence = 0.85

3. [10:01 AM] Technical Engine runs
   ├─ Fetches OHLCV data (1h/4h/1d) from user's Binance connection
   ├─ Calculates: MA20 > MA50 (bullish), RSI = 45 (neutral)
   ├─ MACD showing bullish crossover
   └─ Output: technical_score = 0.58, confidence = 0.75

4. [10:02 AM] Other engines run
   ├─ Fundamental: Market cap stable, volume increasing → 0.60
   ├─ Event Risk: No major events ahead → 0.10 (low risk)
   └─ Liquidity: High order book depth → 0.80

5. [10:02 AM] Fusion Engine combines
   final_score = 0.35(0.72) + 0.25(0.58) + 0.15(0.60) + 0.15(0.10) + 0.10(0.80)
   final_score = 0.252 + 0.145 + 0.09 + 0.015 + 0.08 = 0.582
   action = "BUY" (score > 0.3)

6. [10:02 AM] Confidence Engine calculates position
   portfolio_value = $50,000
   base_risk = $50,000 × 0.02 = $1,000
   adjusted = $1,000 × (0.85×0.4 + 0.58×0.3 + 1.0×0.2 + 1.0×0.1)
   position_value = $1,000 × 0.804 = $804
   position_size = $804 / $50,000 (BTC price) = 0.016 BTC

7. [10:02 AM] Signal stored in database
   strategy_signals: {
     action: "BUY",
     final_score: 0.582,
     confidence: 0.804,
     position_size: 0.016 BTC
   }

8. [10:03 AM] LLM generates explanation
   "Strong BUY signal for Bitcoin. Sentiment is highly positive 
   (72% bullish) driven by institutional adoption news. Technical 
   indicators show bullish momentum with MA crossover..."

9. [10:05 AM] User sees signal in dashboard
   "BUY 0.016 BTC at $50,000 (confidence: 80%)"

10. [User Decision]
    Option A: Click "Execute on Testnet" → Paper trade placed
    Option B: Click "Execute Live" → Real trade on Binance
    Option C: Modify and trade manually
    Option D: Ignore signal
```

---

## 🚨 **Important Notes**

### **Data Dependencies**:
- **Technical Engine**: REQUIRES `connection_id` for OHLCV data
  - Without it: Returns neutral score (0.0)
  - Impact: Final score heavily weighted toward sentiment/fundamentals
  
- **Sentiment Engine**: Always runs (uses LunarCrush + news APIs)
  - FinBERT model lazy-loads (5-10s first request)
  - Cache helps subsequent requests (< 100ms)

### **Cost Considerations**:
- **LLM Explanations**: ~$0.01 per signal
  - Only generated for top signals (cronjob: 40/run)
  - Monthly cost: ~$1,200 for all signals
  - Optional: Can be disabled to save costs

- **LunarCrush API**: 
  - Free tier: 500 requests/day
  - Current usage: ~150/day (10-min cronjobs)
  - Headroom: 350 requests for user-triggered signals

### **Performance**:
- **Signal Generation**: 2-5 seconds per asset
  - Sentiment: 0.5-1s (cached) or 5-10s (first time)
  - Technical: 0.5-1s (OHLCV fetch + calculation)
  - Other engines: < 0.5s each
  - LLM: 2-4s (optional)

- **Cronjob Duration**: 
  - 50 assets × 4 strategies = 200 signals
  - Batched (3 assets at a time) = ~3 minutes total
  - With LLM (40 explanations) = +2 minutes
  - Total: ~5 minutes per run

---
