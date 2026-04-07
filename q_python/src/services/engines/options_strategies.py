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
    StrategyTemplate(
        name="long_call",
        display_name="Long Call",
        direction="bullish",
        legs=[StrategyLeg(type="CALL", side="BUY", strike_offset=0.0)],
        iv_rank_min=0.0,
        iv_rank_max=0.50,
        min_score=0.3,
        description="Buy ATM call when IV is low and outlook is bullish",
    ),
    StrategyTemplate(
        name="long_put",
        display_name="Long Put",
        direction="bearish",
        legs=[StrategyLeg(type="PUT", side="BUY", strike_offset=0.0)],
        iv_rank_min=0.0,
        iv_rank_max=0.50,
        min_score=0.3,
        description="Buy ATM put when IV is low and outlook is bearish",
    ),
    # --- Spreads ---
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
        min_score=0.2,
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
        min_score=0.2,
        description="Debit spread: buy ATM put, sell OTM put. Defined risk bearish play.",
    ),
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
        description="Sell premium when IV is high and no strong directional bias.",
    ),
    # --- Volatility plays ---
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
        description="Buy OTM call + put. Cheaper than straddle, needs bigger move.",
    ),
    # --- Advanced spreads ---
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
        description="Sell near-dated, buy far-dated. Profits from time decay differential.",
    ),
    # --- Premium selling ---
    StrategyTemplate(
        name="short_put",
        display_name="Short Put (Cash Secured)",
        direction="bullish",
        legs=[StrategyLeg(type="PUT", side="SELL", strike_offset=-0.05)],
        iv_rank_min=0.50,
        iv_rank_max=1.0,
        min_score=0.2,
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
        strike = round(spot_price * (1 + leg.strike_offset), 2)

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
