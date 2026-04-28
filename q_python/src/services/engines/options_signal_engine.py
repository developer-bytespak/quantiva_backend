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
    snap_to_nearest_friday,
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
            direction, dir_score, trend_strength, vol_regime = self._compute_direction(
                iv_rank, price_data, volume_data
            )

            # Determine default expiry — snap to the nearest Friday so the
            # resulting OCC / Binance symbol references a contract that's
            # actually listed on the venue's chain.
            raw_expiry = datetime.now(timezone.utc) + timedelta(days=DEFAULT_EXPIRY_DAYS)
            expiry_dt = snap_to_nearest_friday(raw_expiry)
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
                    trend_strength=trend_strength,
                    vol_regime=vol_regime,
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
        Returns (direction, score, trend_strength, vol_regime) where score is
        -1..+1, trend_strength is 0..1 (R² of linear fit), and vol_regime is
        one of "low" | "normal" | "high".
        """
        score = 0.0
        trend_strength = 0.0
        vol_regime = "normal"

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

        return direction, round(score, 4), round(trend_strength, 4), vol_regime

    def _build_signal(
        self,
        strat: StrategyTemplate,
        underlying: str,
        direction: str,
        dir_score: float,
        trend_strength: float,
        vol_regime: str,
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

            # Confidence reflects how well current conditions fit THIS strategy
            # template — not just whether IV data exists. Without per-strategy
            # terms every signal for an underlying converged to the same value
            # (≈0.70 for neutral signals), giving the UI no way to rank them.
            conf = self._compute_confidence(
                strat=strat,
                dir_score=dir_score,
                iv_rank=iv_rank,
                trend_strength=trend_strength,
                vol_regime=vol_regime,
            )

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

    def _compute_confidence(
        self,
        strat: StrategyTemplate,
        dir_score: float,
        iv_rank: Optional[float],
        trend_strength: float,
        vol_regime: str,
    ) -> float:
        """
        Score how well current conditions fit this specific strategy template.
        Mixes four per-(strategy, underlying) terms so different strategies
        on the same name produce different confidences:

          - iv_fit:    distance of iv_rank from the template's band midpoint
          - dir_fit:   directional templates reward score margin above min_score;
                       neutral templates reward score being near zero
          - trend_fit: directional plays prefer high R²; neutral plays prefer low
          - vol_pen:   high realised vol penalises directional plays (chaotic)

        Weights sum to ~0.55 on top of a 0.40 base, so confidences land in
        roughly [0.40, 0.95] — plenty of spread for the UI to rank cards.
        """
        conf = 0.40

        # IV fit. The optimum within a template's allowed band depends on which
        # edge is open:
        #   • band hugs 1.0 (e.g. iron_condor, long_butterfly, short_put) →
        #     premium-selling / cheap-debit plays peak at iv=1.0
        #   • band hugs 0.0 (e.g. long_straddle, long_strangle) →
        #     premium-buying plays peak at iv=0.0
        #   • interior bands (e.g. calendar_spread, bull/bear spreads) →
        #     peak at the band midpoint
        # `matches()` already filters out templates whose band excludes this
        # iv_rank, so we only get here if iv_rank ∈ [iv_rank_min, iv_rank_max].
        if iv_rank is not None:
            lo, hi = strat.iv_rank_min, strat.iv_rank_max
            if lo <= 0.0 and hi < 1.0:
                # low-IV preferring → optimum at lo
                iv_fit = max(0.0, 1.0 - (iv_rank - lo) / max(hi - lo, 0.01))
            elif hi >= 1.0 and lo > 0.0:
                # high-IV preferring → optimum at hi
                iv_fit = max(0.0, (iv_rank - lo) / max(hi - lo, 0.01))
            else:
                # interior band → optimum at midpoint
                mid = (lo + hi) / 2
                half_width = max((hi - lo) / 2, 0.01)
                iv_fit = max(0.0, 1.0 - abs(iv_rank - mid) / half_width)
            conf += 0.20 * iv_fit

        # Directional fit. For directional templates the score should point the
        # right way and exceed min_score; saturates at +0.30 above the floor.
        # For neutral templates, fade as |score| approaches the 0.10 cutoff.
        if strat.direction == "neutral":
            dir_fit = max(0.0, 1.0 - abs(dir_score) / 0.10)
        else:
            signed = dir_score if strat.direction == "bullish" else -dir_score
            margin = signed - strat.min_score
            dir_fit = max(0.0, min(1.0, margin / 0.30))
        conf += 0.20 * dir_fit

        # Trend strength: directional plays want clear linear trends; neutral
        # plays (condors, butterflies) want chop. trend_strength is R² ∈ [0, 1].
        if strat.direction == "neutral":
            conf += 0.10 * (1.0 - trend_strength)
        else:
            conf += 0.10 * trend_strength

        # High realised-vol regime is hostile to directional bets — the price
        # path is too noisy for the entry strike to matter.
        if vol_regime == "high" and strat.direction != "neutral":
            conf -= 0.05

        return self.clamp_score(conf, 0.0, 1.0)

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
                # Sort by strike so K1 < K2 < K3 regardless of input order.
                sorted_legs = sorted(legs, key=lambda l: l["strike"])
                k1 = float(sorted_legs[0]["strike"])
                k2 = float(sorted_legs[1]["strike"])
                k3 = float(sorted_legs[2]["strike"])
                left_wing = k2 - k1
                right_wing = k3 - k2
                # Conservative debit estimate — preserves the old 20%-of-wing
                # heuristic, anchored on the smaller wing (which bounds the
                # debit in either symmetric or broken-wing cases).
                est_debit = min(left_wing, right_wing) * 0.2
                # Peak P&L at S = K2 is the LEFT wing minus the debit.
                max_profit_val = left_wing - est_debit
                # For a long butterfly the right tail (S ≥ K3) is flat at
                #   P&L = (left_wing - right_wing) - debit
                # so when right_wing > left_wing, max loss exceeds the debit
                # by exactly the wing imbalance. Symmetric → max_loss = debit.
                max_loss_val = est_debit + max(0.0, right_wing - left_wing)
                ratio = f"{max_profit_val / max_loss_val:.1f}:1" if max_loss_val > 0 else "N/A"
                return ratio, fmt(max_profit_val), fmt(max_loss_val)
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
