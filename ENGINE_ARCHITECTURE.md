# Quantiva Signal Engine — Complete Architecture & Logic

> Read this end-to-end before touching engine code. Every score field exposed to users (and every BUY/HOLD/SELL decision) flows through this pipeline. If something is wrong with what a strategy fires on, the cause is in one of these layers and it's almost always traceable to a specific function.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Data Sources](#2-data-sources)
3. [The Base Engine Contract](#3-the-base-engine-contract)
4. [The 5 Engines (deep dive each)](#4-the-5-engines)
   - 4.1 [Trend Engine](#41-trend-engine)
   - 4.2 [Sentiment Engine](#42-sentiment-engine)
   - 4.3 [Fundamental Engine](#43-fundamental-engine)
   - 4.4 [Event Risk Engine](#44-event-risk-engine)
   - 4.5 [Liquidity Engine](#45-liquidity-engine)
5. [Fusion Engine — how the 5 scores combine](#5-fusion-engine)
6. [Strategy Evaluation — rules + thresholds](#6-strategy-evaluation)
7. [Noticeboard Storage Pattern](#7-noticeboard-storage-pattern)
8. [End-to-End Cron Flow](#8-end-to-end-cron-flow)
9. [Calibration Decisions (why numbers are what they are)](#9-calibration-decisions)
10. [Troubleshooting Map](#10-troubleshooting-map)

---

## 1. System Overview

A signal is one row in `strategy_signals` that says **"this (strategy, asset) combination is a BUY right now"**. There are five engines that each rate an asset on a single dimension (`score ∈ [-1, +1]`), a Fusion engine that combines them with per-strategy weights, and a Strategy Executor that applies the user's entry rules.

```
                ┌─────────────────────────────────────────────────────────┐
                │                  Cron (every 10 min)                    │
                │  (q_nest/src/modules/strategies/services/...)           │
                │  picks 50 stocks / 250 crypto → for each (asset,        │
                │  strategy) calls Python /api/v1/signals/generate        │
                └─────────────────┬───────────────────────────────────────┘
                                  │
                                  ▼
              ┌────────────────────────────────────────────┐
              │   signal_generator.SignalGenerator         │
              │   q_python/src/services/strategies/        │
              │   signal_generator.py                      │
              └─────┬──────┬─────┬──────┬─────┬────────────┘
                    │      │     │      │     │
                    ▼      ▼     ▼      ▼     ▼
                 trend  sent  fund   event   liq      ← 5 engines run
                  │      │     │     risk     │          in parallel
                  └──────┴─────┴──────┴───────┘          (logically)
                              │
                              ▼
                  ┌──────────────────────────┐
                  │   FusionEngine            │
                  │   weights × scores +      │
                  │   synergy bonus           │
                  └────────────┬──────────────┘
                               │
                               ▼
                  ┌──────────────────────────┐
                  │  StrategyExecutor         │
                  │  applies entry_rules      │
                  │  → action: BUY/HOLD/SELL  │
                  └────────────┬──────────────┘
                               │
                               ▼
                  ┌──────────────────────────┐
                  │ SignalsService            │
                  │ upsertOrDeleteFromEngine  │
                  │ (noticeboard)             │
                  └──────────────────────────┘
                               │
                               ▼
                  strategy_signals row in DB
                  (only BUY rows persist)
```

Engine scores are floats in `[-1, +1]`. Negative = bearish, positive = bullish. `None`/null means **"this engine couldn't compute"**, which is different from `0.0` (a real neutral reading) — Fusion treats null engines as absent and renormalizes weights.

---

## 2. Data Sources

Every engine is ultimately built on external data. Here is who calls what:

| Source | Used By | Endpoint(s) | Purpose | API Key Env Var |
|---|---|---|---|---|
| **NestJS `/candles/system`** | Trend | `GET /candles/system/{symbol}?interval=1d&limit=200` | OHLCV bars for technical indicators. Internal — proxies Binance (crypto) or Alpaca (stocks). | (none — internal HTTP) |
| **Binance public** | Trend (via NestJS), Liquidity (order book, crypto only), market_rankings sync | `/api/v3/klines`, `/api/v3/depth` | Crypto candles + L2 order book. | `BINANCE_API_KEY` (NestJS) |
| **Alpaca Markets** | Trend (stocks, via NestJS), price/volume sync | `/v2/stocks/{symbol}/bars`, `/v2/stocks/{symbol}/quotes` | Stock candles + 24h price/volume. **Free tier returns IEX-only volume (~3-5% of real consolidated SIP).** | `APCA_API_KEY_ID` / `APCA_API_SECRET_KEY` (NestJS) |
| **Finnhub** | Fundamental (stocks), Event Risk (stocks) | `GET /stock/metric?metric=all`, `GET /calendar/earnings?from=&to=` | Financial ratios (P/E, ROE, growth, margins) + upcoming earnings calendar. Free tier: 60 req/min. | `FINNHUB_API_KEY` (Python) |
| **StockNewsAPI** | Sentiment (stocks), Fundamental (legacy stock path), Event Risk (news event detection) | `GET /v1/category?section=alltickers&items=N` | News articles per ticker (used for FinBERT sentiment). | `STOCK_NEWS_API_KEY` (Python) |
| **LunarCrush** | Sentiment (crypto), Fundamental (crypto galaxy score), Event Risk (crypto news) | `GET /coin/{symbol}/v1`, `GET /coin/{symbol}/news/v1` | Crypto social metrics + news. | `LUNARCRUSH_API_KEY` (Python) |
| **CoinGecko Pro** | Fundamental (crypto: developer activity, tokenomics) | `GET /coins/{id}/developer_score`, `/coins/{id}/...` | Dev activity, supply, market cap. | `COINGECKO_API_KEY` (Python) |
| **FRED (Federal Reserve)** | Event Risk (macro economic events, stocks only) | Various series endpoints | Fed rate decisions, inflation, yield curve. | `FRED_API_KEY` (Python) |
| **HuggingFace ProsusAI/finbert** | Sentiment (stocks: ML scoring) | Local model load | Financial sentiment classification (positive/negative/neutral). Downloaded once, cached on disk. | — |

**Env var locations:**
- NestJS-side keys: `q_nest/.env` AND Render NestJS service Environment tab
- Python-side keys: `q_python/.env` AND **Render Python service Environment tab** (these must be set independently — Render does not share env between services)

A missing Python-side env var **does not error loudly** — it usually results in the engine returning `score=0` or `score=null` with a metadata note. Always check `/api/v1/admin/...-stats` endpoints (or the engine `metadata.status` field) when scores look stuck at 0.

---

## 3. The Base Engine Contract

Every engine subclasses `BaseEngine` ([q_python/src/services/engines/base_engine.py](q_python/src/services/engines/base_engine.py)) and follows the same return contract:

```python
{
    "score": float | None,        # [-1, +1] or None if no data
    "confidence": float,          # [0, 1] — how trustworthy the score is
    "metadata": {
        "status": "ok" | "no_data" | "error",
        "reason": "...",          # human-readable when not 'ok'
        # ... engine-specific fields ...
    }
}
```

Three helper methods on `BaseEngine` produce the contract correctly:

- `create_result(score, confidence, metadata)` — engine ran and got a real score.
- `handle_no_data(reason, context)` — engine couldn't fetch data. Returns `score=None`.
- `handle_error(exception, context)` — engine threw. Returns `score=None`.

**Critical invariant: `score=None` ≠ `score=0.0`.** The Fusion engine renormalizes weights when a score is None (so the engine is effectively skipped). A score of 0.0 means "engine computed a real neutral reading" and contributes 0 × weight to the final.

> **Historical bug fixed:** an old version of `signal_generator.py` did `engine_scores.get('x', {}).get('score', 0.0) or 0.0`. That `or 0.0` clobbered None into 0.0 in the API response, breaking Fusion's null-aware renormalization and making probes incapable of distinguishing the two cases. The current code uses `_pass_through_engine_result()` which preserves the contract intact.

---

## 4. The 5 Engines

### 4.1 Trend Engine

**File:** [q_python/src/services/engines/technical_engine.py](q_python/src/services/engines/technical_engine.py)

#### What it measures
Technical price momentum — is the asset in a confirmed uptrend or downtrend across multiple timeframes?

#### Data path
1. `calculate()` receives `asset_id`, `asset_type`, optional `connection_id` (user's exchange) and `asset_symbol`.
2. If a `connection_id` is provided (user-scoped path), fetch OHLCV from that user's connected exchange.
3. **Otherwise (system cron path):** call `_fetch_multi_timeframe_ohlcv_from_system(symbol, exchange, asset_type)`. This internally calls NestJS `GET {NESTJS_API_URL}/candles/system/{SYMBOL}?interval=...&limit=...&asset_type=...` three times for the **1d / 4h / 1h** timeframes.
4. NestJS routes the call to Binance (crypto) or Alpaca (stocks) and returns `{success, data: [{openTime, open, high, low, close, volume}, ...]}`.

> **The throttler bug:** the global NestJS `ThrottlerGuard` is 30 req/min per IP. Python on Render shares one egress IP, and each signal call makes 3 candle requests × N stocks per cron tick. We hit the 429 limit constantly. Fix: `@SkipThrottle()` decorator on `SystemCandlesController` ([q_nest/src/modules/strategies/system-candles.controller.ts](q_nest/src/modules/strategies/system-candles.controller.ts)). Without it the trend engine silently returns 0 for almost every asset.

#### Scoring math

Inside `_calculate_multi_timeframe_trend_score()`:

```python
score_components = [
    (ma50_200_1d,  weight 0.4),  # 1d golden/death-cross strength
    (ma20_50_4h,   weight 0.3),  # 4h short-term momentum
    (roc_1h,       weight 0.2),  # 1h rate-of-change (1h is more reactive)
    (structure,    weight 0.1),  # higher-highs / lower-lows analysis
]
weighted_score = sum(component × weight) / sum(weight)
```

Each component returns a value in `[-1, +1]` via `normalize_score(value, input_min, input_max)`. Empty timeframes contribute 0 with their weight subtracted from the denominator (so missing data doesn't artificially drag the score).

#### Multi-timeframe alignment bonus

If all three timeframes (1d MA cross, 4h MA cross, 1h ROC) point in **the same direction** with magnitude ≥ 0.10:

```python
weighted_score *= 1.20
```

A truly confirmed trend gets a 20% scaling boost. Symmetric: works for downtrends too. The flag `mtf_aligned` is exposed in metadata so probes can see why a trend was boosted.

#### No-data fallback

If `_fetch_multi_timeframe_ohlcv_from_system` returns nothing AND no fallback OHLCV was passed, return `handle_no_data("OHLCV data unavailable...")` so Fusion correctly skips this engine.

#### Confidence

`base_confidence(data_points, data_freshness, required_points=50, max_age_hours=24)` — higher when we have many recent bars.

---

### 4.2 Sentiment Engine

**File:** [q_python/src/services/engines/sentiment_engine.py](q_python/src/services/engines/sentiment_engine.py)

#### What it measures
Aggregate market sentiment from news + social media + (for stocks) FinBERT-scored articles.

#### Data path

For **stocks** (`asset_type='stock'`):
1. `_fetch_news_data()` calls `stock_news_service.fetch_news(asset_symbol, limit=50)`.
2. **Critical:** `asset_symbol` (the ticker, e.g. AAPL) must be passed, NOT `asset_id` (the DB UUID). An earlier bug used asset_id, which `stocknews` treated as "unknown symbol" → 0 articles → sentiment 0 for every stock.
3. Each returned article is fed to `finbert_inference.analyze_financial_text(text, source=...)`. FinBERT is a HuggingFace model (`ProsusAI/finbert`) that classifies financial text into positive / negative / neutral.
4. FinBERT loads lazily — first call may take 30-60 s (model download + tokenizer init). Subsequent calls are fast.

For **crypto** (`asset_type='crypto'`):
1. `lunarcrush_service.fetch_coin_news(asset_symbol, limit=50)` for news.
2. `lunarcrush_service.fetch_social_metrics(asset_symbol)` for galaxy_score / alt_rank.
3. FinBERT applied to news (same model, just different source weight).

#### Per-article scoring

Each article goes through FinBERT → `{score: -1..+1, confidence: 0..1, sentiment: 'positive'|'negative'|'neutral'}`.

Source-credibility weights then scale each article's score:

```python
self.source_weights = {
    # Tier 1 — wire services / top financial press
    'reuters': 1.4, 'bloomberg': 1.4, 'wsj': 1.35, 'ft': 1.35,
    'cnbc': 1.3, 'barron\'s': 1.3,
    # Tier 2 — mainstream financial / tech press
    'forbes': 1.2, 'business insider': 1.15, 'marketwatch': 1.15,
    'the motley fool': 1.1, 'techcrunch': 1.1,
    # Tier 3 — aggregators / retail blogs
    'benzinga': 0.95, '24/7 wall street': 0.9, 'cnet': 0.9,
    'proactive investors': 0.85, 'marketbeat': 0.85,
    # default
    'default': 1.0,
}
```

Reasoning: a negative Reuters headline moves markets more than ten negative blog posts. We tier them.

#### Consensus boost

Among **non-neutral** articles (positive + negative count), if ≥55% lean the same direction with at least 5 articles:

```python
boosted_score = base_ml_score * 1.35
```

This corrects for FinBERT's tendency to label ~50% of financial news as "neutral" (which anchors the simple mean toward 0). When the non-neutral subset is uniformly positive, that's a real signal — boost it.

#### EMA smoothing

After per-article aggregation, the engine maintains a per-asset EMA:

```python
ema_score = α * raw_score + (1 - α) * previous_ema    # α = 0.25
```

Previously α was 0.125 (half-life ~5.3 ticks); raised to 0.25 (half-life ~2.5 ticks) so fresh news flow actually moves the score. The EMA is persisted in DB via `EMAStateService`, requiring `DATABASE_URL` env var on the Python service.

#### Momentum

```python
final_score = ema_score + momentum × 0.2
```

Where `momentum = (current EMA - previous EMA) / dt`. This rewards accelerating sentiment shifts.

#### Layer aggregation

For crypto the engine combines three layers:
1. **ML layer** (FinBERT scores)
2. **Keyword layer** (`CryptoKeywordAnalyzer` — counts bullish/bearish crypto-specific terms)
3. **Market layer** (`MarketSignalAnalyzer` — looks at price action as a sentiment proxy)

For stocks only the ML layer + market layer apply (no crypto keyword dict).

---

### 4.3 Fundamental Engine

**File:** [q_python/src/services/engines/fundamental_engine.py](q_python/src/services/engines/fundamental_engine.py)

#### What it measures
For stocks: the financial quality of the underlying company — value, quality, growth, leverage. For crypto: galaxy score + developer activity + tokenomics.

#### Stock path (the one that matters for most users)

**Old (broken) approach:** the engine used to filter StockNewsAPI articles for "earnings"/"revenue"/"performance" keywords and run FinBERT sentiment on the matching subset. Most days for most stocks no article contains those exact keywords (real earnings news is quarterly), so the engine returned 0 for nearly every stock, every day — making any user strategy with `fundamental > 0.X` impossible to fire.

**Current approach:** call Finnhub `/stock/metric?metric=all` and build a composite score from 4 dimensions.

```python
batch = self.finnhub_service.fetch_company_fundamentals_batch([asset_symbol])
metrics = batch[asset_symbol]
# metrics = {pe_ratio, eps, market_cap, dividend_yield, beta, price_to_book,
#            roe, debt_to_equity, eps_growth_quarterly_yoy, eps_growth_5y,
#            revenue_growth_ttm_yoy, gross_margin}
```

#### Four-dimension composite

| Dimension | Weight | Inputs | Scoring |
|---|---|---|---|
| **Value** | 0.30 | P/E ratio, P/B ratio, dividend yield | `(25 - PE) / 15` clamped [-1,+1]; `(2 - PB) / 2`; `min(div_yield/8 × 0.5, 0.5)`. Averaged across available inputs. Negative P/E (loss-making company) → -0.5. |
| **Quality** | 0.25 | ROE, gross margin | `ROE / 25` clamped [-0.8, +1]; `(gross_margin - 20) / 30` clamped [-1, +1]. Averaged. |
| **Growth** | 0.25 | EPS growth Q YoY, EPS growth 5Y, revenue growth TTM YoY | `growth_pct / target` clamped [-1, +1]. Targets: 20% Q, 15% 5Y, 15% revenue. Averaged. |
| **Leverage** | 0.20 | Debt/Equity | `(1 - D/E) / 2` clamped [-1, +1]. Negative equity (D/E < 0) → -0.5 warning. |

Each dimension that's null (Finnhub didn't return the field) is dropped and the remaining weights renormalize. The final composite is `sum(weight[d] × score[d]) / sum(weight[d])` over available dimensions.

#### Confidence

- 4 dimensions covered → 0.90
- 3 → 0.80
- 2 → 0.65
- 1 → 0.50

#### Failure modes (each surfaces a distinct metadata.status)

```python
if not self.finnhub_service.api_key:
    return handle_no_data("FINNHUB_API_KEY not configured...")
if not isinstance(batch, dict):
    return handle_no_data("Finnhub service returned non-dict response")
if metrics is None:
    return handle_no_data("Finnhub request failed inside FinnhubService...")  # caught network/timeout/SSL
if not metrics:
    return handle_no_data("Finnhub responded but returned empty data")
if not contributions:
    return handle_no_data("Finnhub returned no usable metric values")
```

This granularity matters when something breaks — probe responses immediately tell you whether to check Render env vars, network, or Finnhub itself.

#### Why AAPL still scores modestly

AAPL post-rewrite: P/E ~37 (value negative), P/B ~51 (value strongly negative), ROE ~151% (quality maxed at +1), debt/equity ~1.35 (leverage slightly negative), EPS growth ~22% (growth strong). Composite ≈ +0.14. Engine correctly recognizes that AAPL is high quality but **expensive** — a value strategy shouldn't get a strong BUY on it.

---

### 4.4 Event Risk Engine

**File:** [q_python/src/services/engines/event_risk_engine.py](q_python/src/services/engines/event_risk_engine.py)

#### What it measures
Are there scheduled catalysts (earnings, SEC filings, regulatory actions) in the next 30 days that could move the price? Engine outputs `+` for benign / no-event days and `-` for impending negative events.

#### Data path — stocks

Two sources are combined and deduplicated:

1. **Finnhub `/calendar/earnings`** (the primary structured source) via `_fetch_finnhub_earnings_events()`. Returns `{earnings_date, eps_estimate, days_until_earnings, ...}`. Each upcoming earnings becomes an event dict with `type='earnings'`.
2. **StockNewsAPI** via `stock_news_service.fetch_news()` (~100 articles). Parsed for earnings keywords, SEC filing keywords, regulatory action keywords. Each match becomes an event dict.

Plus FRED-based macro events (Fed rate decisions, inflation prints) if `FredService.is_available()`.

> **Why both sources:** Finnhub's calendar misses ad-hoc events (regulatory investigations, surprise filings). News parsing catches those. Both feed the same dedupe + scoring pipeline.

#### Data path — crypto

LunarCrush news parsed for: exchange listings, hard forks / protocol upgrades, partnerships, regulatory actions, token unlocks (with percentage extraction from text).

#### Per-event scoring

```python
self.event_impacts = {
    'exchange_listing': +0.8, 'partnership': +0.6, 'protocol_upgrade': +0.5,
    'positive_earnings': +0.7,
    'earnings': 0.0,  # neutral — depends on expectations
    'fomc_meeting': -0.2, 'economic_release': 0.0,
    'sec_investigation': -0.9, 'regulatory_action': -0.8,
    'negative_earnings': -0.6, 'hard_fork_risky': -0.5,
    'token_unlock_large': -0.9,  # >5% supply
    'token_unlock_medium': -0.6,
    'token_unlock_small': -0.3,
}
```

Each event's base impact is multiplied by a **time-decay weight**:

```python
if days_away <= 7:    time_weight = 1.0       # full impact
elif days_away <= 30: time_weight = max(0.3, 1.0 - (days_away - 7) × 0.1)  # decays
elif days_away < -7:  return 0.0              # too far past, ignore
```

#### Aggregation (asymmetric)

```python
positive_sum = sum(positive_event_scores) × 0.5  # halved
negative_sum = sum(negative_event_scores) × 1.5  # amplified
total = clamp(positive_sum + negative_sum, -1, +1)
```

Negative events get 3× the weight of positive ones — risk is asymmetric.

#### No-events baseline

```python
if not events:
    return create_result(0.20, 0.6, {'status': 'no_events'})  # quiet 30d window
if not event_scores:
    return create_result(0.10, 0.6, {'status': 'no_impactful_events'})
```

Why +0.20 (not 0.0 or 1.0):
- **Old bug:** the engine returned `1.0` for no-events — meaning every stock got a silent +0.20 boost to final_score (event_risk weight × 1.0) on most days. That made the engine meaningless and inflated all final_scores.
- **Honest neutral would be 0.0**, but "no scheduled catalysts in the next 30 days" is genuinely mildly positive (no surprise risk). +0.20 reflects that without dominating.

---

### 4.5 Liquidity Engine

**File:** [q_python/src/services/engines/liquidity_engine.py](q_python/src/services/engines/liquidity_engine.py)

#### What it measures
Can you actually trade this asset cleanly? High score = tight spreads + deep books + heavy volume. Low score = wide spreads + thin volume → slippage risk.

#### Crypto path (uses order book)

When the crypto cron is making the call it pre-fetches a Binance L2 order book (`top 20 bids/asks`) and passes it in. The engine computes:

| Component | Weight | Math |
|---|---|---|
| Spread score | 0.40 | `(best_ask - best_bid) / mid_price` → tight spreads (<0.1%) → +1, wide (>2%) → -1 |
| Depth score | 0.30 | Total quantity within ±1% of mid, normalized by `current_price`. Sums top 20 levels each side. |
| Volume score | 0.20 | `volume_24h / avg_volume_30d` ratio. Above average → positive. |
| Slippage score | 0.10 | Estimated cost to move a notional trade of ~$10k through the book. |

If no order book is passed → `handle_no_data("Order book and current price required for crypto liquidity")`.

#### Stock path (no order book — uses volume + market cap)

The stock cron does NOT pre-fetch an L2 book (Alpaca doesn't easily expose one). Instead the engine scores from price + 24h volume + (optional) avg 30d volume + market cap.

```python
dollar_volume = volume_24h × current_price
```

**Anchor calibrated to Alpaca's IEX-only feed** (free tier returns ~3-5% of real consolidated SIP volume):

```python
anchor = 10_000_000.0  # $10M IEX dollar volume = neutral 0
dollar_score = log10(max(1, dollar_volume) / anchor)
# $10M  → 0       (neutral / typical mid-cap)
# $100M → +1      (mega-cap; capped)
# $1M   → -1      (illiquid small-cap; capped)
```

When/if the data source upgrades to Alpaca SIP or Finnhub `/quote` (real consolidated volume), bump anchor back to `100_000_000`.

Plus **volume burst** (if 30d avg available):
```python
burst_ratio = volume_24h / avg_volume_30d
burst_score = clamp(burst_ratio - 1.0, -0.5, +0.5)  # 2x avg = +0.5, 0.5x = -0.5
```

Plus **turnover sanity** (if market_cap available):
```python
turnover = dollar_volume / market_cap
if turnover < 0.0001:  # <0.01% daily — suspicious for mid+cap
    turnover_penalty = -0.2
```

Combined: `0.75 × dollar_score + 0.20 × burst_score + 0.05 × turnover_penalty`.

---

## 5. Fusion Engine

**File:** [q_python/src/services/engines/fusion_engine.py](q_python/src/services/engines/fusion_engine.py)

#### Inputs
- `engine_scores`: dict of `{engine_name: {score, confidence, metadata}}`.
- `weights`: per-strategy engine weights (from `strategy.engine_weights`). Defaults: sentiment 0.35 / trend 0.25 / fundamental 0.15 / event_risk 0.15 / liquidity 0.10. Must sum to 1.0 after normalization.
- `buy_threshold`, `sell_threshold`: optional per-strategy overrides. Defaults: BUY 0.5, SELL -0.5 (stocks) / 0.3, -0.3 (crypto).

#### Step 1 — Filter to valid scores

```python
raw_scores = {key: engine_scores[key].get('score') for key in WEIGHT_KEYS}
valid_scores = {k: float(v) for k, v in raw_scores.items() if v is not None and not isnan(v)}
engines_skipped = [k for k, v in raw_scores.items() if v is None or isnan(v)]
```

If all engines are null → `handle_no_data('all engines returned null')`. This is the **null-aware re-normalization** that the metadata-strip + `or 0.0` bug used to break.

#### Step 2 — Renormalize weights

```python
valid_weight_sum = sum(active_weights[k] for k in valid_scores)
rebalanced = {k: active_weights[k] / valid_weight_sum for k in valid_scores}
weighted_avg = sum(rebalanced[k] × valid_scores[k] for k in valid_scores)
```

So a strategy weighted 25% on trend will have that weight redistributed across the other 4 engines if trend was null. **This is critical for non-Binance crypto assets** where trend can't compute but the rest can.

#### Step 3 — Synergy bonus (multi-engine alignment)

```python
ALIGN_THRESHOLD = 0.15
pos_aligned = count(scores where score >= +0.15)
neg_aligned = count(scores where score <= -0.15)

if   pos_aligned >= 4: synergy = +0.10
elif pos_aligned >= 3: synergy = +0.05
elif neg_aligned >= 4: synergy = -0.05
elif neg_aligned >= 3: synergy = -0.025

final_score = clamp(weighted_avg + synergy, -1, +1)
```

**Asymmetric on purpose**: positive synergy gets a full bump because we want to surface high-conviction BUYs. Negative synergy only halves — we don't want to chase weak shorts harder than the data warrants.

#### Step 4 — Action determination

```python
action = _determine_action(final_score, event_risk_score, asset_type, buy_threshold, sell_threshold)
```

Defaults: BUY when `final_score > buy_threshold`. The event_risk score is also used as a **veto** — extremely negative event_risk (< -0.5) blocks a BUY even with strong final_score.

#### Step 5 — Confidence

Weighted average of contributing engines' confidences, then **dampened if fewer than half the engines contributed**:

```python
if len(valid_scores) < (len(WEIGHT_KEYS) / 2.0):
    overall_confidence *= 0.5
```

#### Step 6 — Metadata (fully exposed)

The returned dict includes:
- `score_breakdown`: per-engine score (None for skipped)
- `engines_used`, `engines_skipped`
- `weights`, `rebalanced_weights`, `weights_source`
- `weighted_avg_pre_synergy`, `synergy_bonus`, `synergy_reason`
- `positive_alignments`, `negative_alignments`

Probe responses surface all of this so debugging a BUY/HOLD decision is mechanical.

---

## 6. Strategy Evaluation

**File:** [q_python/src/services/strategies/strategy_executor.py](q_python/src/services/strategies/strategy_executor.py) (orchestrates) plus the rule check inside `signal_generator.py`.

#### Rule shape
```json
[
  {"field": "final_score", "value": 0.30, "operator": ">"},
  {"field": "metadata.engine_details.fundamental.score", "value": 0.25, "operator": ">"}
]
```

Fields can be:
- `final_score` — fusion output
- `metadata.engine_details.{engine}.score` — per-engine raw score
- (potentially) deeper paths into engine metadata, but those are brittle and discouraged

#### Evaluation
The rule list is **AND-ed**: every rule must pass for the engine's intended action (BUY/SELL) to fire. If any rule fails, the action becomes HOLD.

Operators: `>`, `<`, `>=`, `<=`, `=`, `==`.

#### Calibrated threshold ranges (front-end enforced)

From actual engine output distribution observed in production:

| Field | Min | Max | Warn above | Reason |
|---|---|---|---|---|
| `final_score` | 0.10 | 0.50 | 0.30 | Weighted avg + synergy peaks ~0.60 in market peaks; typical good stock 0.20-0.40 |
| All per-engine | 0.10 | 0.40 | 0.25 | Per-engine ceilings observed: trend 0.38, sentiment 0.38, fundamental 0.42, event_risk 0.20 baseline, liquidity 0.75 for mega-caps |

The frontend strategy-create form ([QuantivaHQ-frontend/src/app/(dashboard)/dashboard/my-strategies/create/page.tsx](QuantivaHQ-frontend/src/app/(dashboard)/dashboard/my-strategies/create/page.tsx)) hard-clamps inputs to these ranges and shows an amber warning when the user crosses into the "strict" band. This is the actual UX guardrail — the description text is just explaining what the slider already enforces.

#### Why `final > 0.5` fires almost never

To reach 0.5+, four conditions effectively must coincide:
- A genuine multi-timeframe trend (trend ≥ +0.35) — rare in chop
- Aligned positive sentiment (sent ≥ +0.30) — requires a heavy positive news week with consensus boost
- Real fundamental quality (fund ≥ +0.30) — value + growth + quality + leverage all aligned
- Liquidity contributing (liq ≥ +0.50) — mega-cap or very heavy turnover
- Often event_risk needs to add a small positive (~+0.20 baseline or +0.40 with imminent earnings)

That's a "everything aligned" stock — the engine output naturally surfaces 1-3 per day across the entire universe, not dozens. Hence the calibrated default suggestion of `final > 0.30` for steady signal flow.

---

## 7. Noticeboard Storage Pattern

**File:** [q_nest/src/modules/signals/signals.service.ts](q_nest/src/modules/signals/signals.service.ts), method `upsertOrDeleteFromEngine`

The `strategy_signals` table is **not a history log**. It's a noticeboard: one row per `(strategy_id, asset_id, user_id)` tuple, representing the engine's current opinion. Three operations:

| Engine returned | Existing row | Action |
|---|---|---|
| BUY | exists | UPDATE in place (same `signal_id`, refreshed scores + timestamp) |
| BUY | none | INSERT new |
| HOLD or SELL | exists | DELETE (signal_details + signal_explanations cascade-delete) |
| HOLD or SELL | none | no-op |

**Invariant: only BUY rows are ever stored.** When the engine "flips" a stock from BUY to HOLD, the row disappears — it never lingers showing a stale recommendation.

The `signal_id` stays stable across updates so FK-referencing rows in `orders` / `auto_trade_evaluations` keep their link.

Why this matters for the user UX: Top Trades page reads BUY rows directly with a 24h freshness filter. There's never a "stale BUY" because the cron's next pass deletes it the moment the engine disagrees.

---

## 8. End-to-End Cron Flow

### Crypto path

**File:** [q_nest/src/modules/strategies/services/pre-built-signals-cronjob.service.ts](q_nest/src/modules/strategies/services/pre-built-signals-cronjob.service.ts)

```
Every 10 min
  │
  ├─ getMergedTopAssets(250, enrichWithRealtime=false)
  │  → CoinGecko top 250 by market cap LEFT JOIN LunarCrush trending
  │  → trending coins sorted first, then by mcap
  │
  ├─ For each asset (batched 10 parallel):
  │   ├─ runSentimentAnalysis(asset)  // pre-warm: hits Python /sentiment/analyze
  │   │
  │   ├─ binanceService.getOrderBook(symbol, 20)
  │   │  → pre-fetch L2 order book for liquidity engine
  │   │
  │   ├─ For each active strategy:
  │   │   ├─ pythonApi.generateSignal(strategyId, assetId, {
  │   │   │     strategy_data, market_data, order_book,
  │   │   │     connection_id: null, exchange: 'binance',
  │   │   │     asset_symbol })
  │   │   │
  │   │   ├─ Python runs all 5 engines + fusion + rules → action
  │   │   │
  │   │   └─ signalsService.upsertOrDeleteFromEngine({...})
  │   │      → noticeboard write
  │   │
  │   └─ heartbeat.{buy/hold/sell/failed}++  // logged at end of run
  │
  └─ generateLLMExplanationsForTopSignals(strategies)
     → top-10 per strategy get Gemini explanation
```

### Stock path

**File:** [q_nest/src/modules/strategies/services/stock-signals-cronjob.service.ts](q_nest/src/modules/strategies/services/stock-signals-cronjob.service.ts)

```
Every 5 min: syncStockMarketData()  → Alpaca quotes → trending_assets
Every 10 min: generateStockSignals()
  │
  ├─ getStocksToProcess(50)
  │  → market_rankings + assets, filtered to is_active + price_usd > 0
  │  → ORDER BY oldest signal first, then market_cap_rank  (rotation)
  │
  ├─ For each stock (batched 3 parallel):
  │   ├─ runSentimentAnalysis(stock)  // pre-warm
  │   │
  │   ├─ For each active strategy:
  │   │   ├─ executeStrategyForStock(strategyId, assetId, connectionInfo)
  │   │   │   ├─ pythonApi.generateSignal({
  │   │   │   │     strategy_data, market_data, asset_type='stock',
  │   │   │   │     connection_id: null, exchange: 'alpaca',
  │   │   │   │     asset_symbol, portfolio_value: 10000 })
  │   │   │   │
  │   │   │   ├─ // PYTHON FAILED? NO FAKE FALLBACK.
  │   │   │   │   // Previously this catch ran generateFallbackSignal()
  │   │   │   │   // which fabricated trend=0.5/fund=0/sent=0/ev=0/liq=0.2
  │   │   │   │   // signals — those polluted the DB with fake BUYs.
  │   │   │   │   // Now we just heartbeat.failed++ and return.
  │   │   │   │
  │   │   │   └─ signalsService.upsertOrDeleteFromEngine({...})
  │
  └─ generateLLMExplanationsForTopSignals(strategies)
```

#### Rotation correctness

`getStocksToProcess` ranks stocks by their oldest `last_signal_time` first (with never-processed stocks treated as 1970-01-01, ensuring they get picked first). This guarantees full universe coverage over the cycle even though we only do 50 stocks per tick.

**Important subtlety:** the rotation does NOT filter by `target_assets`. Every active strategy is evaluated against every rotated stock. A user-defined "Momentum Stocks" strategy with `target_assets=['F','VLO',...]` will get signals for AAPL too if AAPL is in the rotation that tick — because the rule evaluation happens on the signal output, not the asset selection.

### Throttler config

NestJS has a **global ThrottlerGuard at 30 req/min per IP**. The `SystemCandlesController` (used by the trend engine for OHLCV) is decorated with `@SkipThrottle()` because Python on Render makes ~3 × 50-250 candle requests per cron tick, all from one IP. Without the skip, ~80%+ of trend lookups 429 and the engine returns null.

---

## 9. Calibration Decisions (why numbers are what they are)

This section documents the **specific magic numbers** and why they're set where they are. If you change one of these, you should know what bug or observation triggered the choice.

| Where | Value | Why |
|---|---|---|
| Sentiment `ema_alpha` | 0.25 | Old 0.125 was a ~5.3-tick half-life — too damped to reflect fresh news flow. 0.25 gives ~2.5-tick half-life. Above 0.4 you whipsaw on every article. |
| Sentiment consensus threshold | 55% (non-neutral basis) + 5 minimum articles | FinBERT labels ~50% of routine financial news as 'neutral', anchoring the mean toward 0. A 55% lean of the non-neutral subset is the cleanest "real signal" threshold. |
| Sentiment consensus multiplier | 1.35× | Empirically, 18-of-23 positive (~78% non-neutral) only produced raw score ~0.22 without this boost. 1.35× lifts it to ~0.30 — meaningful but not extreme. |
| Source weight tiers | 1.4 / 1.2 / 0.9 | Magnitude small enough that a single Reuters article doesn't dominate, large enough that a news day weighted toward Tier-1 sources scores higher than the same volume from aggregators. |
| Event risk no-events baseline | +0.20 | Old 1.0 inflated every stock by event_risk_weight × 1.0 ≈ +0.20 final. Zero is too harsh — "quiet 30-day window" IS mildly positive. +0.20 splits the difference. |
| Event risk no-impactful-events | +0.10 | Events exist in the calendar but time-decayed out of relevance. Less positive than truly empty case (something IS coming), but still net mildly positive. |
| Fusion synergy threshold | each engine ≥ |0.15| | Below 0.15 the score is essentially "neutral with noise" and shouldn't count as alignment. 0.15 is the same threshold most engines hit in their typical positive band. |
| Fusion synergy positive bonus | +0.05 / +0.10 (3 / 4 engines) | Empirically VLO with 5 engines aligned was 0.31 weighted avg → 0.41 with +0.10. Lifts the strongest signals over the 0.40 mark while leaving partial alignment alone. |
| Fusion synergy negative bonus | -0.025 / -0.05 (half of positive) | We don't want to amplify weak negative readings — only positives get the full bonus. |
| Liquidity stock anchor | $10M dollar volume | Alpaca free tier returns IEX-only volume ~3-5% of real SIP. $10M IEX corresponds to roughly $100M-$500M real. Bump to $100M when source upgrades to SIP. |
| Trend MTF alignment threshold | each timeframe ≥ |0.10| | Below 0.10 it's noise. 0.10 is roughly "directionally meaningful". |
| Trend MTF alignment multiplier | 1.20× | A confirmed multi-timeframe trend deserves more credit than a single-bar fluke but shouldn't dominate. 1.20× lifts strong trends without overwhelming. |
| Fundamental dimension weights | value 0.30 / quality 0.25 / growth 0.25 / leverage 0.20 | Reflects "what fundamentals matter for stocks" — value (price reasonable), quality (returns), growth (future earnings), leverage (downside risk). Equal-ish weighting prevents any one from dominating. |
| Fundamental P/E anchor | 25 | Roughly the long-term S&P 500 P/E median. <10 = strongly cheap, >40 = strongly expensive. |
| Fundamental ROE anchor | 25% | Excellent ROE territory. AAPL/MSFT regularly exceed it; companies below 5% are flagged negative. |
| Fundamental growth anchor (EPS Q YoY) | 20% | Healthy growth stock territory. NVDA-type companies exceed easily; mature companies hover around 5-10%. |
| Threshold UI clamps | final 0.10-0.50, per-engine 0.10-0.40 | Set ABOVE highest observed values in extensive production probing but below where the rule becomes structurally impossible. Above these = warning text, save still allowed. |

---

## 10. Troubleshooting Map

When a signal looks wrong (BUY missing where you expect, or BUY firing where you don't), use this map to find the cause.

### "Engine X always returns 0 for stocks"

Cause is almost always one of:
1. **Env var missing on Python service.** Check Render Python service → Environment tab. Common missing: `FINNHUB_API_KEY`, `STOCK_NEWS_API_KEY`, `DATABASE_URL`.
2. **Throttler eating the call.** Check `SystemCandlesController` still has `@SkipThrottle()`. Without it, NestJS's 30/min throttler 429s the trend engine's candle requests.
3. **Symbol mismatch.** Engines that need a ticker (sentiment, fundamental, event_risk) require `asset_symbol` in kwargs — not `asset_id` (UUID). Verify the cron passes both.

### "Signal score doesn't match the per-engine breakdown"

Re-derive by hand:
```
weighted_avg = Σ (rebalanced_weight[engine] × score[engine])    # over engines with score != None
synergy = +0.10 if pos_aligned ≥ 4 else +0.05 if pos_aligned ≥ 3 else (negative side similarly)
final = clamp(weighted_avg + synergy, -1, +1)
```

If your hand math diverges from the API response, the bug is in Fusion. The probe's `metadata.weighted_avg_pre_synergy`, `synergy_bonus`, and `rebalanced_weights` fields show the exact intermediate values.

### "BUY appeared but engine scores are all 0.5 / 0 / 0 / 0 / 0.2"

That's the **old stock cron fallback signature**. It used to fabricate signals when Python failed. The fallback has been removed but stale rows from before the fix linger in DB. Run `scripts/cleanup-stale-fake-buys.ts` to purge them.

### "Strategy never fires no matter what"

Probe one of its target assets via `scripts/probe-stock-engines.ts SYMBOL`. Check:
1. Does each engine actually return a score? Look at the per-engine breakdown.
2. Calculate the final score by hand. Is it actually below the strategy's threshold?
3. Compare the rule fields with the metadata path. `metadata.engine_details.X.score` is the correct path; older strategies sometimes referenced fields like `metadata.engine_details.sentiment.metadata.ema.momentum` which were stripped from the API response.

### "Engine output looks 'too small' across the board"

Two known-real causes:
1. **Alpaca IEX volume scale issue (stocks)** — Alpaca free returns ~3-5% of real consolidated volume. The Liquidity engine's anchor is set for IEX scale ($10M); if you swap to a SIP/Finnhub source, bump it to $100M.
2. **Market just isn't strong** — engines are honest. Multiple stocks scoring 0.10-0.25 final on a mixed market day is correct behavior, not a bug. Median final score across the universe ≈ 0.18; 90th percentile ≈ 0.40.

### "I changed an engine and want to verify quickly"

Probe a known stock: `npx tsx q_nest/scripts/probe-stock-engines.ts AAPL`. This calls Python's `/api/v1/signals/generate` directly with Blue Chip Guardian's config and dumps:
- final action + score + confidence
- per-engine score / confidence / status / reason
- full engine_scores JSON (which now includes the metadata you added)

If your engine change should have boosted AAPL by +0.05 fundamental, the probe shows whether it did within ~80 seconds.

### "Cron isn't picking up my new env var"

Render does not auto-restart on env-var changes for some service types. Manual re-deploy from the Render dashboard is the reliable trigger. Check `/health` after — it includes a timestamp so you can confirm you're hitting the new process.

---

## Appendix A — File index

Engines:
- [q_python/src/services/engines/base_engine.py](q_python/src/services/engines/base_engine.py) — contract
- [q_python/src/services/engines/technical_engine.py](q_python/src/services/engines/technical_engine.py) — trend
- [q_python/src/services/engines/sentiment_engine.py](q_python/src/services/engines/sentiment_engine.py)
- [q_python/src/services/engines/fundamental_engine.py](q_python/src/services/engines/fundamental_engine.py)
- [q_python/src/services/engines/event_risk_engine.py](q_python/src/services/engines/event_risk_engine.py)
- [q_python/src/services/engines/liquidity_engine.py](q_python/src/services/engines/liquidity_engine.py)
- [q_python/src/services/engines/fusion_engine.py](q_python/src/services/engines/fusion_engine.py)

Orchestration:
- [q_python/src/services/strategies/signal_generator.py](q_python/src/services/strategies/signal_generator.py) — runs all engines + fusion + rule check
- [q_python/src/services/strategies/strategy_executor.py](q_python/src/services/strategies/strategy_executor.py) — rule evaluation

External data services (Python):
- [q_python/src/services/data/finnhub_service.py](q_python/src/services/data/finnhub_service.py)
- [q_python/src/services/data/stock_news_service.py](q_python/src/services/data/stock_news_service.py)
- [q_python/src/services/data/lunarcrush_service.py](q_python/src/services/data/lunarcrush_service.py)
- [q_python/src/services/data/coingecko_service.py](q_python/src/services/data/coingecko_service.py)
- [q_python/src/models/finbert/](q_python/src/models/finbert/) — FinBERT inference

NestJS-side:
- [q_nest/src/modules/strategies/services/pre-built-signals-cronjob.service.ts](q_nest/src/modules/strategies/services/pre-built-signals-cronjob.service.ts) — crypto cron
- [q_nest/src/modules/strategies/services/stock-signals-cronjob.service.ts](q_nest/src/modules/strategies/services/stock-signals-cronjob.service.ts) — stock cron
- [q_nest/src/modules/strategies/system-candles.controller.ts](q_nest/src/modules/strategies/system-candles.controller.ts) — OHLCV proxy
- [q_nest/src/modules/signals/signals.service.ts](q_nest/src/modules/signals/signals.service.ts) — `upsertOrDeleteFromEngine` noticeboard
- [q_nest/src/kyc/integrations/python-api.service.ts](q_nest/src/kyc/integrations/python-api.service.ts) — NestJS → Python HTTP client

Frontend:
- [QuantivaHQ-frontend/src/app/(dashboard)/dashboard/my-strategies/create/page.tsx](QuantivaHQ-frontend/src/app/(dashboard)/dashboard/my-strategies/create/page.tsx) — strategy creation form with threshold/weight guardrails
- [QuantivaHQ-frontend/src/components/strategies/strategy-form-shared.tsx](QuantivaHQ-frontend/src/components/strategies/strategy-form-shared.tsx) — shared rule field / operator / weight definitions

Useful diagnostic scripts (all in `q_nest/scripts/`):
- `probe-stock-engines.ts SYMBOL` — full per-engine breakdown for one stock
- `manual-generate-wrighster.ts ["strategy name"]` — manually fire signals for g.wrighster's strategies (or one of them)
- `check-wrighster-buys.ts` — list all current BUYs across g.wrighster's strategies
- `cleanup-stale-fake-buys.ts` — purge legacy hardcoded-fallback rows
- `relax-wrighster-rules.ts` — DB script to retune entry rules
- `full-signal-audit.ts` — multi-window signal volume by strategy
- `check-stock-volumes.ts` — verify trending_assets / market_rankings volume data
- `verify-stock-deploy.ts` — sanity-check post-deploy

---

## Appendix B — Sample probe response (annotated)

```json
{
  "strategy_id": "877eccb3-...",
  "asset_id": "...",
  "asset_type": "stock",
  "timestamp": "2026-06-03T...",
  "final_score": 0.346,
  "action": "HOLD",
  "confidence": 0.61,

  "engine_scores": {
    "trend": {
      "score": 0.092,
      "confidence": 0.71,
      "metadata": {
        "indicators": {...},
        "timeframes": {"1d": {...}, "4h": {...}, "1h": {...}},
        "mtf_aligned": false        // ← would be true if 1.2x boost fired
      }
    },
    "sentiment": {
      "score": 0.258,
      "confidence": 0.74,
      "metadata": {
        "overall_sentiment": "positive",
        "sentiment_breakdown": {"positive": 18, "neutral": 27, "negative": 5},
        "total_texts": 50,
        "consensus_applied": true,
        "consensus_direction": "positive",
        "consensus_ratio": 0.78,
        "individual_ml_results": [{...}, ...]
      }
    },
    "fundamental": {
      "score": 0.256,
      "confidence": 0.85,
      "metadata": {
        "source": "finnhub_metric",
        "raw_metrics": {
          "pe_ratio": 36.86,
          "roe_pct": 151.9,
          "gross_margin_pct": 46.91,
          "eps_growth_quarterly_yoy_pct": 22.04,
          "debt_to_equity": 1.35,
          ...
        },
        "component_scores": {
          "value": -0.60, "quality": +1.0, "growth": +0.80, "leverage": -0.17
        },
        "dimensions_used": ["value", "quality", "growth", "leverage"]
      }
    },
    "event_risk": {
      "score": 0.20,
      "confidence": 0.6,
      "metadata": {
        "events_count": 0,
        "status": "no_events",
        "note": "No upcoming events detected (quiet 30d window)"
      }
    },
    "liquidity": {
      "score": 0.75,
      "confidence": 0.7,
      "metadata": {
        "method": "stock_dollar_volume",
        "dollar_volume_usd": 407000000,
        "dollar_volume_score": 1.0,    // log10(407M/10M) = 1.6 → capped 1.0
        "burst_ratio": null,
        "burst_score": 0.0,
        "turnover": null,
        "turnover_penalty": 0.0
      }
    }
  },

  "metadata": {
    "fusion_result": {
      "score": 0.346,
      "action": "HOLD",
      "metadata": {
        "engines_used": ["sentiment","trend","fundamental","liquidity","event_risk"],
        "engines_skipped": [],
        "weights": {"sentiment":0.25,"trend":0.15,"fundamental":0.35,"event_risk":0.20,"liquidity":0.05},
        "rebalanced_weights": {...},                  // same as weights when no engine null
        "weights_source": "strategy",
        "weighted_avg_pre_synergy": 0.296,
        "synergy_bonus": 0.05,                        // 3 engines aligned (sent, ev, liq ≥ 0.15)
        "synergy_reason": "3-engine positive alignment",
        "positive_alignments": 3,
        "negative_alignments": 0
      }
    },
    "engine_details": { ... }                         // full per-engine output (same as engine_scores top-level)
  },

  "strategy_execution": {
    "rules_passed": false,
    "rule_results": [
      {"field": "final_score", "operator": ">", "threshold": 0.30, "actual": 0.346, "passed": true},
      {"field": "metadata.engine_details.fundamental.score", "operator": ">", "threshold": 0.25, "actual": 0.256, "passed": true}
    ]
  },

  "position_sizing": {...}
}
```

To debug *any* BUY/HOLD decision: read `engine_scores` to see what each engine said, `fusion_result.metadata` to see how they combined, and `strategy_execution.rule_results` to see which rule (if any) blocked the action.

---

*Last verified end-to-end: production probe of AAPL returning all 5 engines healthy + synergy bonus applied. Next time you touch any engine, re-probe AAPL and one mid-cap (e.g., VLO) — if both look right, you haven't broken the pipeline.*
