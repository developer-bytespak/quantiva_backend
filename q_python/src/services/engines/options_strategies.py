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

# All templates use a uniform 2-hour signal TTL because the NestJS cron
# regenerates signals every hour. The TTL is just a safety net for missed
# cron ticks — under normal operation each (underlying, strategy) row is
# replaced by a fresh row before the previous one expires, so the read-side
# `distinct on (underlying, strategy) order by created_at desc` query
# always shows the latest. If the cron skips a tick (network blip, Render
# wake-up), 2h gives one full hour of grace before the stale row falls out
# of the active list — better than showing a 6-24h-old strategy whose
# strikes no longer match where spot is now.
SIGNAL_TTL_HOURS = 2

STRATEGY_TEMPLATES: List[StrategyTemplate] = [
    # --- Directional single-leg ---
    StrategyTemplate(
        name="long_call",
        display_name="Long Call",
        direction="bullish",
        legs=[StrategyLeg(type="CALL", side="BUY", strike_offset=0.0)],
        iv_rank_min=0.0,
        iv_rank_max=0.50,
        min_score=0.15,
        signal_ttl_hours=SIGNAL_TTL_HOURS,
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
        signal_ttl_hours=SIGNAL_TTL_HOURS,
        description="Buy ATM put when IV is low and outlook is bearish",
    ),
    # --- Directional spreads ---
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
        signal_ttl_hours=SIGNAL_TTL_HOURS,
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
        signal_ttl_hours=SIGNAL_TTL_HOURS,
        description="Debit spread: buy ATM put, sell OTM put. Defined risk bearish play.",
    ),
    # --- Premium-selling neutral ---
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
        signal_ttl_hours=SIGNAL_TTL_HOURS,
        description="Sell premium when IV is high and no strong directional bias.",
    ),
    # --- Volatility plays (premium-buying neutral) ---
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
        signal_ttl_hours=SIGNAL_TTL_HOURS,
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
        signal_ttl_hours=SIGNAL_TTL_HOURS,
        description="Buy OTM call + put. Cheaper than straddle, needs bigger move.",
    ),
    # --- Structural spreads ---
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
        signal_ttl_hours=SIGNAL_TTL_HOURS,
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
        signal_ttl_hours=SIGNAL_TTL_HOURS,
        description="Sell near-dated, buy far-dated. Profits from time decay differential.",
    ),
    # --- Cash-secured short put ---
    StrategyTemplate(
        name="short_put",
        display_name="Short Put (Cash Secured)",
        direction="bullish",
        legs=[StrategyLeg(type="PUT", side="SELL", strike_offset=-0.05)],
        iv_rank_min=0.50,
        iv_rank_max=1.0,
        min_score=0.10,
        signal_ttl_hours=SIGNAL_TTL_HOURS,
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


def _easter(year: int) -> "date":
    """Gregorian Easter Sunday (anonymous algorithm). Used to derive Good Friday."""
    from datetime import date
    a = year % 19
    b, c = divmod(year, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    L = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * L) // 451
    month = (h + L - 7 * m + 114) // 31
    day = ((h + L - 7 * m + 114) % 31) + 1
    return date(year, month, day)


def _observed(d: "date") -> "date":
    """NYSE observance: a holiday on Sat shifts to Fri, on Sun shifts to Mon."""
    from datetime import timedelta
    if d.weekday() == 5:        # Saturday -> preceding Friday
        return d - timedelta(days=1)
    if d.weekday() == 6:        # Sunday -> following Monday
        return d + timedelta(days=1)
    return d


def _nth_weekday(year: int, month: int, weekday: int, n: int) -> "date":
    """The n-th `weekday` (Mon=0) of a month, e.g. 3rd Monday of January."""
    from datetime import date, timedelta
    first = date(year, month, 1)
    return first + timedelta(days=(weekday - first.weekday()) % 7 + 7 * (n - 1))


def _last_weekday(year: int, month: int, weekday: int) -> "date":
    """The last `weekday` (Mon=0) of a month, e.g. last Monday of May."""
    from datetime import date, timedelta
    last = (date(year + 1, 1, 1) if month == 12 else date(year, month + 1, 1)) - timedelta(days=1)
    return last - timedelta(days=(last.weekday() - weekday) % 7)


def us_market_full_day_holidays(year: int) -> set:
    """
    Full-day NYSE/Nasdaq closures for `year`. Only full closures matter for
    options-expiry snapping — half-days (day after Thanksgiving, Christmas
    Eve) are still trading sessions with listed expiries. Half-days are
    intentionally excluded so we don't roll a valid expiry off them.
    """
    from datetime import date, timedelta
    hols = set()
    # New Year's Day — NYSE does NOT observe it on Fri Dec 31 when Jan 1 is Sat.
    ny = date(year, 1, 1)
    if ny.weekday() == 6:        # Sunday -> Monday Jan 2
        hols.add(date(year, 1, 2))
    elif ny.weekday() != 5:      # any weekday except Saturday
        hols.add(ny)
    hols.add(_nth_weekday(year, 1, 0, 3))        # MLK — 3rd Mon Jan
    hols.add(_nth_weekday(year, 2, 0, 3))        # Presidents — 3rd Mon Feb
    hols.add(_easter(year) - timedelta(days=2))  # Good Friday
    hols.add(_last_weekday(year, 5, 0))          # Memorial — last Mon May
    if year >= 2022:
        hols.add(_observed(date(year, 6, 19)))   # Juneteenth
    hols.add(_observed(date(year, 7, 4)))        # Independence Day
    hols.add(_nth_weekday(year, 9, 0, 1))        # Labor — 1st Mon Sep
    hols.add(_nth_weekday(year, 11, 3, 4))       # Thanksgiving — 4th Thu Nov
    hols.add(_observed(date(year, 12, 25)))      # Christmas
    return hols


def _previous_trading_day(d: "date") -> "date":
    """
    Walk back to the most recent open trading day on/before `d` (skips
    weekends and full-day holidays). Unions adjacent years so a January
    rollback can cross into the prior December correctly.
    """
    from datetime import timedelta
    hols = us_market_full_day_holidays(d.year) | us_market_full_day_holidays(d.year - 1)
    while d.weekday() >= 5 or d in hols:
        d -= timedelta(days=1)
    return d


def snap_to_nearest_friday(dt, us_equity_holidays: bool = False):
    """
    US equity options (Alpaca) expire on Fridays, and Binance eapi options
    settle at 08:00 UTC on Fridays as well. Given any target datetime, return
    the Friday closest to it (±3 days max). Picking "Friday closest" rather
    than "next Friday" means a 30-DTE target lands on ~28 or ~32 DTE instead
    of drifting far from the intended horizon.

    The engine used to emit `now + N days` directly, which on Sundays /
    Mondays produced OCC / dash symbols for contracts nobody lists — the
    resulting bid/ask fetches returned all zeros.

    `us_equity_holidays` (Alpaca only): a Friday that is itself a full-day US
    market holiday (e.g. Good Friday, or Independence Day observed on Fri
    Jul 3 2026 when Jul 4 is a Saturday) has no listed equity contracts —
    the exchange lists that week's expiry on the prior session (Thu). So we
    roll back to the previous open trading day, where the contracts exist.
    This is NOT applied for Binance: crypto options list their Friday weekly/
    monthly regardless of US holidays, and have no Thursday contract 30d out.
    """
    from datetime import timedelta
    # weekday(): Monday=0 ... Friday=4 ... Sunday=6
    offset = (4 - dt.weekday()) % 7  # days forward to Friday (0 if already Fri)
    if offset > 3:
        offset -= 7  # prefer the Friday BEHIND us if it's closer
    snapped = dt + timedelta(days=offset)

    if us_equity_holidays:
        trading_day = _previous_trading_day(snapped.date())
        if trading_day != snapped.date():
            snapped += timedelta(days=(trading_day - snapped.date()).days)
    return snapped


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
    venue: str = "BINANCE",
) -> List[Dict[str, Any]]:
    """
    Convert strategy legs with offsets to concrete strike prices.
    If a leg has a custom expiry_days (different from the default 30),
    the expiry is adjusted relative to now. `venue` enables US-equity
    holiday rollback on the per-leg expiry snap for Alpaca (see
    `snap_to_nearest_friday`); the default-expiry path inherits the
    already-snapped `expiry_iso` from the caller.
    """
    from datetime import datetime, timedelta, timezone

    legs = []
    for leg in template.legs:
        raw_strike = spot_price * (1 + leg.strike_offset)
        strike = snap_strike_to_listed(raw_strike)

        # Use per-leg expiry_days if it differs from default, snapping to
        # the nearest Friday so the resulting symbol maps to a real listed
        # contract.
        if leg.expiry_days != base_expiry_days:
            raw_dt = datetime.now(timezone.utc) + timedelta(days=leg.expiry_days)
            leg_expiry = snap_to_nearest_friday(
                raw_dt, us_equity_holidays=(venue == "ALPACA")
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

    # Butterfly templates need EQUIDISTANT wings to be a real butterfly —
    # otherwise they become broken-wing butterflies, which have a totally
    # different (and much larger) right-tail max loss. Independent snapping
    # of each leg above can produce e.g. K1=335, K2=350, K3=370 from a
    # symmetric template (-5%, 0%, +5%) because each strike rounds to the
    # nearest listed increment in isolation. Detect the butterfly shape
    # (3 legs with a 2-ratio middle leg) and rebuild both wings using the
    # SMALLER of the two snapped wings — this caps risk at est_debit and
    # produces a true symmetric butterfly that lands on listed strikes.
    legs = _enforce_butterfly_symmetry(legs)
    return legs


def _enforce_butterfly_symmetry(legs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Post-process a 3-leg butterfly to guarantee equidistant wings. No-op for
    any other leg shape. Assumes legs are in template order: lower wing,
    middle (ratio 2), upper wing — which is the convention in
    STRATEGY_TEMPLATES["long_butterfly"].
    """
    if len(legs) != 3:
        return legs
    middle = legs[1]
    if middle.get("ratio") != 2:
        return legs

    k1 = float(legs[0]["strike"])
    k2 = float(middle["strike"])
    k3 = float(legs[2]["strike"])
    left_wing = k2 - k1
    right_wing = k3 - k2
    if left_wing <= 0 or right_wing <= 0 or left_wing == right_wing:
        return legs

    # Use the smaller wing on BOTH sides. Both sides land on the listed grid
    # because k2 is already snapped and we move by an existing-snapped delta.
    wing = min(left_wing, right_wing)
    legs[0] = {**legs[0], "strike": round(k2 - wing, 2)}
    legs[2] = {**legs[2], "strike": round(k2 + wing, 2)}
    return legs
