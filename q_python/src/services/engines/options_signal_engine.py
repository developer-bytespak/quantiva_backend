"""
Options Signal Engine
Generates standalone AI options trading signals based on IV analysis,
directional scoring, and strategy template matching.
"""
from typing import Dict, Any, List, Optional
from datetime import datetime, timedelta, timezone
import logging
import numpy as np

from src.services.engines.base_engine import BaseEngine
from src.services.engines.options_strategies import (
    get_matching_strategies,
    resolve_strikes,
    build_occ_symbol,
    StrategyTemplate,
)

logger = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────

DEFAULT_EXPIRY_DAYS = 30
SIGNAL_VALIDITY_HOURS = 12
MIN_CONFIDENCE = 0.25


class OptionsSignalEngine(BaseEngine):
    """
    Generates AI options signals without requiring an existing base signal.
    Analyses IV environment and produces strategy recommendations.
    """

    def __init__(self):
        super().__init__("OptionsSignalEngine")

    def calculate(
        self,
        asset_id: str,
        asset_type: str = "crypto",
        timeframe: Optional[str] = None,
        **kwargs,
    ) -> Dict[str, Any]:
        """
        Generate options signals for a given underlying.

        Expected kwargs:
            iv_rank: float | None — current IV rank (0-1)
            iv_value: float | None — raw IV value
            spot_price: float | None — current spot price
            price_data: list | None — recent price data for directional scoring
            volume_data: list | None — recent volume data for weighting
        """
        try:
            if not self.validate_inputs(asset_id=asset_id, asset_type=asset_type):
                return self.handle_error(ValueError("Invalid inputs"), "validate")

            iv_rank = kwargs.get("iv_rank")
            iv_value = kwargs.get("iv_value")
            spot_price = kwargs.get("spot_price")
            price_data = kwargs.get("price_data")
            volume_data = kwargs.get("volume_data")
            venue = kwargs.get("venue", "BINANCE")
            contract_multiplier = float(kwargs.get("contract_multiplier", 0.01))

            # Derive direction and score from available data
            direction, dir_score = self._compute_direction(iv_rank, price_data, volume_data)

            # Determine default expiry
            expiry_dt = datetime.now(timezone.utc) + timedelta(days=DEFAULT_EXPIRY_DAYS)
            expiry_iso = expiry_dt.strftime("%Y-%m-%dT08:00:00Z")

            # Find matching strategies
            strategies = get_matching_strategies(direction, iv_rank, dir_score)

            if not strategies:
                return self.create_result(
                    score=0.0,
                    confidence=0.0,
                    metadata={"signals": [], "reason": "No strategies match current conditions"},
                )

            signals: List[Dict[str, Any]] = []

            for strat in strategies:
                sig = self._build_signal(
                    strat=strat,
                    underlying=asset_id,
                    direction=direction,
                    dir_score=dir_score,
                    iv_rank=iv_rank,
                    iv_value=iv_value,
                    spot_price=spot_price or 0,
                    expiry_iso=expiry_iso,
                    venue=venue,
                    contract_multiplier=contract_multiplier,
                )
                if sig:
                    signals.append(sig)

            avg_confidence = (
                float(np.mean([s["confidence"] for s in signals])) if signals else 0.0
            )

            return self.create_result(
                score=dir_score,
                confidence=avg_confidence,
                metadata={"signals": signals},
            )

        except Exception as e:
            return self.handle_error(e, f"calculate({asset_id})")

    # ── Internal helpers ──────────────────────────────────────────────────

    def _compute_direction(
        self,
        iv_rank: Optional[float],
        price_data: Optional[List[float]],
        volume_data: Optional[List[float]] = None,
    ) -> tuple:
        """
        Determine directional bias and score using multi-timeframe momentum,
        realized volatility regime detection, trend strength, and volume weighting.
        Returns (direction, score) where score is -1 to +1.
        """
        score = 0.0

        if price_data and len(price_data) >= 10:
            arr = np.array(price_data[-60:], dtype=float)
            returns = np.diff(arr) / arr[:-1]

            # 1. Multi-timeframe momentum
            short_mom = float(np.mean(returns[-5:])) * 100 if len(returns) >= 5 else 0
            med_mom = float(np.mean(returns[-20:])) * 100 if len(returns) >= 20 else short_mom
            long_mom = float(np.mean(returns)) * 100

            # 2. Realized volatility regime detection
            rv = float(np.std(returns[-20:])) * np.sqrt(365) if len(returns) >= 20 else 0
            vol_regime = "high" if rv > 0.8 else "low" if rv < 0.3 else "normal"

            # 3. Trend strength via R-squared of linear regression
            trend_strength = 0.0
            if len(arr) >= 20:
                window = arr[-20:]
                x = np.arange(len(window))
                coeffs = np.polyfit(x, window, 1)
                predicted = np.polyval(coeffs, x)
                ss_res = float(np.sum((window - predicted) ** 2))
                ss_tot = float(np.sum((window - np.mean(window)) ** 2))
                trend_strength = max(0, 1 - (ss_res / ss_tot)) if ss_tot > 0 else 0

            # 4. Volume-weighted adjustment
            vol_weight = 1.0
            if volume_data and len(volume_data) >= 10:
                vol_arr = np.array(volume_data[-20:], dtype=float)
                recent_vol = float(np.mean(vol_arr[-5:])) if len(vol_arr) >= 5 else 0
                avg_vol = float(np.mean(vol_arr))
                vol_weight = min(1.5, max(0.5, recent_vol / avg_vol)) if avg_vol > 0 else 1.0

            # Composite score: weighted multi-timeframe momentum
            raw_score = (short_mom * 0.4 + med_mom * 0.35 + long_mom * 0.25) * vol_weight

            # Dampen in high realized vol regime (chaotic, less predictable)
            if vol_regime == "high":
                raw_score *= 0.6

            # Boost if strong trend (R² > 0.5 means clear linear trend)
            raw_score *= (1 + trend_strength * 0.3)

            score = self.clamp_score(raw_score)

        # IV-based adjustment: high IV favours neutral/selling
        if iv_rank is not None and iv_rank > 0.7:
            score *= 0.5

        if score > 0.1:
            direction = "bullish"
        elif score < -0.1:
            direction = "bearish"
        else:
            direction = "neutral"

        return direction, round(score, 4)

    def _build_signal(
        self,
        strat: StrategyTemplate,
        underlying: str,
        direction: str,
        dir_score: float,
        iv_rank: Optional[float],
        iv_value: Optional[float],
        spot_price: float,
        expiry_iso: str,
        venue: str = "BINANCE",
        contract_multiplier: float = 0.01,
    ) -> Optional[Dict[str, Any]]:
        """Build a single signal dict from a strategy template."""
        try:
            legs = resolve_strikes(strat, spot_price, expiry_iso) if spot_price > 0 else []

            # Attach contract symbol to each leg, format depends on venue
            for leg in legs:
                expiry_date = leg.get("expiry", expiry_iso)[:10]  # YYYY-MM-DD
                if venue == "ALPACA":
                    leg["symbol"] = build_occ_symbol(
                        underlying=underlying,
                        expiry_iso=expiry_date,
                        option_type=leg["type"],
                        strike=leg["strike"],
                    )
                else:
                    # Binance format: UNDERLYING-YYMMDD-STRIKE-C/P
                    date_part = expiry_date.replace("-", "")[2:]  # YYMMDD
                    cp = "C" if leg["type"].upper().startswith("C") else "P"
                    leg["symbol"] = f"{underlying.upper()}-{date_part}-{int(leg['strike'])}-{cp}"

            # Confidence based on IV data availability and score strength
            conf = 0.5
            if iv_rank is not None:
                conf += 0.2  # we have IV data
            conf += min(0.3, abs(dir_score) * 0.5)
            conf = self.clamp_score(conf, 0.0, 1.0)

            if conf < MIN_CONFIDENCE:
                return None

            # Risk/reward estimation
            risk_reward, max_profit, max_loss = self._estimate_risk_reward(strat, legs, spot_price)

            # Use strategy-specific TTL, fallback to default
            ttl_hours = strat.signal_ttl_hours if hasattr(strat, 'signal_ttl_hours') else SIGNAL_VALIDITY_HOURS
            expires_at = datetime.now(timezone.utc) + timedelta(hours=ttl_hours)

            return {
                "strategy": strat.name,
                "display_name": strat.display_name,
                "direction": direction,
                "score": round(dir_score, 4),
                "confidence": round(conf, 4),
                "iv_rank": round(iv_rank, 4) if iv_rank is not None else None,
                "iv_value": round(iv_value, 6) if iv_value is not None else None,
                "spot_price": round(spot_price, 2) if spot_price else None,
                "legs": legs,
                "reasoning": self._generate_reasoning(strat, direction, iv_rank, dir_score),
                "risk_reward": risk_reward,
                "max_profit": max_profit,
                "max_loss": max_loss,
                "expires_at": expires_at.isoformat(),
            }
        except Exception as e:
            self.logger.error(f"Failed to build signal for {strat.name}: {e}")
            return None

    @staticmethod
    def _fmt_usd(value: float) -> str:
        """Format USD with appropriate precision based on magnitude."""
        if abs(value) >= 100:
            return f"${value:,.0f}"
        elif abs(value) >= 1:
            return f"${value:,.2f}"
        else:
            return f"${value:,.4f}"

    def _estimate_risk_reward(
        self,
        strat: StrategyTemplate,
        legs: List[Dict[str, Any]],
        spot_price: float,
    ) -> tuple:
        """Risk/reward estimation based on strategy type.
        Uses 10% favorable price move as profit target for uncapped strategies."""
        fmt = self._fmt_usd

        if strat.name in ("long_call", "long_put"):
            est_premium = spot_price * 0.03
            # Estimate profit on a 10% favorable move
            target_profit = spot_price * 0.10 - est_premium
            ratio = f"{target_profit / est_premium:.1f}:1" if est_premium > 0 else "N/A"
            return ratio, fmt(target_profit), fmt(est_premium)

        if strat.name in ("bull_call_spread", "bear_put_spread"):
            if len(legs) >= 2:
                width = abs(legs[0]["strike"] - legs[1]["strike"])
                est_debit = width * 0.4
                est_profit = width - est_debit
                ratio = f"{est_profit / est_debit:.1f}:1" if est_debit > 0 else "N/A"
                return ratio, fmt(est_profit), fmt(est_debit)
            return "N/A", "N/A", "N/A"

        if strat.name == "iron_condor":
            if len(legs) >= 4:
                wing_width = abs(legs[0]["strike"] - legs[1]["strike"])
                est_credit = wing_width * 0.3
                max_loss_val = wing_width - est_credit
                ratio = f"1:{max_loss_val / est_credit:.1f}" if est_credit > 0 else "N/A"
                return ratio, fmt(est_credit), fmt(max_loss_val)
            return "N/A", "N/A", "N/A"

        if strat.name == "long_straddle":
            est_premium = spot_price * 0.06
            target_profit = spot_price * 0.10 - est_premium
            ratio = f"{target_profit / est_premium:.1f}:1" if est_premium > 0 else "N/A"
            return ratio, fmt(target_profit), fmt(est_premium)

        if strat.name == "long_strangle":
            est_premium = spot_price * 0.04
            target_profit = spot_price * 0.10 - est_premium
            ratio = f"{target_profit / est_premium:.1f}:1" if est_premium > 0 else "N/A"
            return ratio, fmt(target_profit), fmt(est_premium)

        if strat.name == "long_butterfly":
            if len(legs) >= 3:
                wing_width = abs(legs[0]["strike"] - legs[1]["strike"])
                est_debit = wing_width * 0.2
                max_profit_val = wing_width - est_debit
                ratio = f"{max_profit_val / est_debit:.1f}:1" if est_debit > 0 else "N/A"
                return ratio, fmt(max_profit_val), fmt(est_debit)
            return "N/A", "N/A", "N/A"

        if strat.name == "calendar_spread":
            est_debit = spot_price * 0.015
            est_profit = est_debit * 0.5
            ratio = f"{est_profit / est_debit:.1f}:1" if est_debit > 0 else "N/A"
            return ratio, fmt(est_profit), fmt(est_debit)

        if strat.name == "short_put":
            est_credit = spot_price * 0.02
            max_loss_val = legs[0]["strike"] - est_credit if legs else spot_price * 0.05
            ratio = f"1:{max_loss_val / est_credit:.1f}" if est_credit > 0 else "N/A"
            return ratio, fmt(est_credit), fmt(max_loss_val)

        return "N/A", "N/A", "N/A"

    def _generate_reasoning(
        self,
        strat: StrategyTemplate,
        direction: str,
        iv_rank: Optional[float],
        score: float,
    ) -> str:
        """Generate human-readable reasoning for the signal."""
        parts = [strat.description]

        if iv_rank is not None:
            iv_pct = int(iv_rank * 100)
            if iv_rank < 0.3:
                parts.append(f"IV Rank is low ({iv_pct}%) — buying premium is favoured.")
            elif iv_rank > 0.7:
                parts.append(f"IV Rank is high ({iv_pct}%) — selling premium is favoured.")
            else:
                parts.append(f"IV Rank is moderate ({iv_pct}%).")

        if abs(score) > 0.5:
            parts.append(f"Strong {direction} momentum detected (score: {score:+.2f}).")
        elif abs(score) > 0.2:
            parts.append(f"Moderate {direction} bias (score: {score:+.2f}).")

        return " ".join(parts)
