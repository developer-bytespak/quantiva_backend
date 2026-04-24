"""
Options Strategy Templates
Defines multi-leg options strategies with selection criteria based on IV rank
and directional bias.
"""
from typing import Dict, Any, List, Optional
from dataclasses import dataclass, field, asdict
from datetime import datetime, timedelta
import logging

logger = logging.getLogger(__name__)


@dataclass
class StrategyLeg:
    type: str          # "CALL" or "PUT"
    side: str          # "BUY" or "SELL"
    strike_offset: float  # offset from ATM (e.g. +0.05 = 5% OTM)
    ratio: int = 1
    expiry_days: int = 30  # default 30 DTE


@dataclass
class StrategyTemplate:
    name: str
    display_name: str
    direction: str         # "bullish", "bearish", "neutral"
    legs: List[StrategyLeg] = field(default_factory=list)
    iv_rank_min: float = 0.0
    iv_rank_max: float = 1.0
    min_score: float = 0.0    # minimum directional score to trigger
    signal_ttl_hours: int = 8  # how long the signal stays valid
    description: str = ""

    def matches(self, direction: str, iv_rank: Optional[float], score: float) -> bool:
        """Check if market conditions match this strategy."""
        # Neutral strategies only fire when direction is neutral
        if self.direction == "neutral" and direction != "neutral":
            return False
        # Directional strategies must match direction
        if self.direction != "neutral" and self.direction != direction:
            return False
        if abs(score) < self.min_score:
            return False
        if iv_rank is not None:
            if iv_rank < self.iv_rank_min or iv_rank > self.iv_rank_max:
                return False
        return True


# ── Strategy Library ──────────────────────────────────────────────────────────

STRATEGY_TEMPLATES: List[StrategyTemplate] = [
    # --- Single-leg ---
    # --- Directional single-leg (6h TTL — short shelf-life) ---
    StrategyTemplate(
        name="long_call",
        display_name="Long Call",
        direction="bullish",
        legs=[StrategyLeg(type="CALL", side="BUY", strike_offset=0.0)],
        iv_rank_min=0.0,
        iv_rank_max=0.50,
        min_score=0.15,
        signal_ttl_hours=6,
        description="Buy ATM call when IV is low and outlook is bullish",
    ),
    StrategyTemplate(
        name="long_put",
        display_name="Long Put",
        direction="bearish",
        legs=[StrategyLeg(type="PUT", side="BUY", strike_offset=0.0)],
        iv_rank_min=0.0,
        iv_rank_max=0.50,
        min_score=0.15,
        signal_ttl_hours=6,
        description="Buy ATM put when IV is low and outlook is bearish",
    ),
    # --- Directional spreads (8h TTL) ---
    StrategyTemplate(
        name="bull_call_spread",
        display_name="Bull Call Spread",
        direction="bullish",
        legs=[
            StrategyLeg(type="CALL", side="BUY", strike_offset=0.0),
            StrategyLeg(type="CALL", side="SELL", strike_offset=0.05),
        ],
        iv_rank_min=0.30,
        iv_rank_max=0.70,
        min_score=0.10,
        signal_ttl_hours=8,
        description="Debit spread: buy ATM call, sell OTM call. Lower cost than naked call.",
    ),
    StrategyTemplate(
        name="bear_put_spread",
        display_name="Bear Put Spread",
        direction="bearish",
        legs=[
            StrategyLeg(type="PUT", side="BUY", strike_offset=0.0),
            StrategyLeg(type="PUT", side="SELL", strike_offset=-0.05),
        ],
        iv_rank_min=0.30,
        iv_rank_max=0.70,
        min_score=0.10,
        signal_ttl_hours=8,
        description="Debit spread: buy ATM put, sell OTM put. Defined risk bearish play.",
    ),
    # --- Premium selling (12h TTL — vol mean-reversion is slower) ---
    StrategyTemplate(
        name="iron_condor",
        display_name="Iron Condor",
        direction="neutral",
        legs=[
            StrategyLeg(type="PUT", side="BUY", strike_offset=-0.10),
            StrategyLeg(type="PUT", side="SELL", strike_offset=-0.05),
            StrategyLeg(type="CALL", side="SELL", strike_offset=0.05),
            StrategyLeg(type="CALL", side="BUY", strike_offset=0.10),
        ],
        iv_rank_min=0.50,
        iv_rank_max=1.0,
        min_score=0.0,
        signal_ttl_hours=12,
        description="Sell premium when IV is high and no strong directional bias.",
    ),
    # --- Volatility plays (6h TTL — time-sensitive) ---
    StrategyTemplate(
        name="long_straddle",
        display_name="Long Straddle",
        direction="neutral",
        legs=[
            StrategyLeg(type="CALL", side="BUY", strike_offset=0.0),
            StrategyLeg(type="PUT", side="BUY", strike_offset=0.0),
        ],
        iv_rank_min=0.0,
        iv_rank_max=0.30,
        min_score=0.0,
        signal_ttl_hours=6,
        description="Buy ATM call + put. Profits from large moves when IV is cheap.",
    ),
    StrategyTemplate(
        name="long_strangle",
        display_name="Long Strangle",
        direction="neutral",
        legs=[
            StrategyLeg(type="CALL", side="BUY", strike_offset=0.05),
            StrategyLeg(type="PUT", side="BUY", strike_offset=-0.05),
        ],
        iv_rank_min=0.0,
        iv_rank_max=0.30,
        min_score=0.0,
        signal_ttl_hours=6,
        description="Buy OTM call + put. Cheaper than straddle, needs bigger move.",
    ),
    # --- Structural spreads (24h TTL — slow-moving trades) ---
    StrategyTemplate(
        name="long_butterfly",
        display_name="Long Call Butterfly",
        direction="neutral",
        legs=[
            StrategyLeg(type="CALL", side="BUY", strike_offset=-0.05),
            StrategyLeg(type="CALL", side="SELL", strike_offset=0.0, ratio=2),
            StrategyLeg(type="CALL", side="BUY", strike_offset=0.05),
        ],
        iv_rank_min=0.50,
        iv_rank_max=1.0,
        min_score=0.0,
        signal_ttl_hours=24,
        description="Low-cost bet that price stays near current level. High IV preferred.",
    ),
    StrategyTemplate(
        name="calendar_spread",
        display_name="Calendar Spread",
        direction="neutral",
        legs=[
            StrategyLeg(type="CALL", side="SELL", strike_offset=0.0, expiry_days=14),
            StrategyLeg(type="CALL", side="BUY", strike_offset=0.0, expiry_days=45),
        ],
        iv_rank_min=0.30,
        iv_rank_max=0.70,
        min_score=0.0,
        signal_ttl_hours=24,
        description="Sell near-dated, buy far-dated. Profits from time decay differential.",
    ),
    # --- Premium selling (12h TTL) ---
    StrategyTemplate(
        name="short_put",
        display_name="Short Put (Cash Secured)",
        direction="bullish",
        legs=[StrategyLeg(type="PUT", side="SELL", strike_offset=-0.05)],
        iv_rank_min=0.50,
        iv_rank_max=1.0,
        min_score=0.10,
        signal_ttl_hours=12,
        description="Sell OTM put to collect premium. Bullish bias, high IV preferred.",
    ),
]


def get_matching_strategies(
    direction: str,
    iv_rank: Optional[float],
    score: float,
) -> List[StrategyTemplate]:
    """Return all strategies that match the current market conditions."""
    return [s for s in STRATEGY_TEMPLATES if s.matches(direction, iv_rank, score)]


def snap_strike_to_listed(strike: float) -> float:
    """
    Round a theoretical strike to the nearest increment real options
    exchanges actually list, so the generated OCC / Binance symbol refers
    to a contract that exists (and has a bid/ask) instead of a synthetic
    one that returns empty quotes.

    The tiers match the common listing rules used by CBOE/Alpaca for
    equities and Binance eapi for crypto:

        <  $1             → $0.01   (DOGE)
        $1   - $5         → $0.50   (XRP)
        $5   - $25        → $1      (small caps, altcoins)
        $25  - $200       → $2.50   (SOL, NVDA, mid-cap equities)
        $200 - $1,000     → $5      (SPY, QQQ, AAPL, MSFT, TSLA, AMZN, GOOG)
        $1K  - $10K       → $100    (ETH)
        ≥ $10K            → $1,000  (BTC)

    Not venue-perfect (Alpaca occasionally lists weekly $1 strikes on
    $100+ names, Binance sometimes has $25 BTC steps near ATM) but
    correct for ~95 % of listed contracts — orders of magnitude better
    than emitting raw decimals like `spot × 1.05`.
    """
    if strike <= 0:
        return 0.0
    if strike < 1:
        step = 0.01
    elif strike < 5:
        step = 0.5
    elif strike < 25:
        step = 1.0
    elif strike < 200:
        step = 2.5
    elif strike < 1_000:
        step = 5.0
    elif strike < 10_000:
        step = 100.0
    else:
        step = 1_000.0
    return round(round(strike / step) * step, 2)


def build_occ_symbol(underlying: str, expiry_iso: str, option_type: str, strike: float) -> str:
    """Build an OCC-21 option symbol (unpadded root form used by Alpaca)."""
    date_part = expiry_iso[:10].replace("-", "")  # "YYYY-MM-DD" -> "YYYYMMDD"
    yy = date_part[2:4]
    mm = date_part[4:6]
    dd = date_part[6:8]
    cp = "C" if option_type.upper().startswith("C") else "P"
    strike_int = round(strike * 1000)
    return f"{underlying.upper()}{yy}{mm}{dd}{cp}{strike_int:08d}"


def resolve_strikes(
    template: StrategyTemplate,
    spot_price: float,
    expiry_iso: str,
    base_expiry_days: int = 30,
) -> List[Dict[str, Any]]:
    """
    Convert strategy legs with offsets to concrete strike prices.
    If a leg has a custom expiry_days (different from the default 30),
    the expiry is adjusted relative to now.
    """
    from datetime import datetime, timedelta, timezone

    legs = []
    for leg in template.legs:
        raw_strike = spot_price * (1 + leg.strike_offset)
        strike = snap_strike_to_listed(raw_strike)

        # Use per-leg expiry_days if it differs from default
        if leg.expiry_days != base_expiry_days:
            leg_expiry = (
                datetime.now(timezone.utc) + timedelta(days=leg.expiry_days)
            ).isoformat()
        else:
            leg_expiry = expiry_iso

        legs.append({
            "type": leg.type,
            "side": leg.side,
            "strike": strike,
            "expiry": leg_expiry,
            "ratio": leg.ratio,
        })
    return legs
