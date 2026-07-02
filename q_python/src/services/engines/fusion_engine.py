"""
Fusion Engine
Combines all individual engine scores into a single trading signal.
"""
from typing import Dict, Any, Optional
import logging

from .base_engine import BaseEngine

logger = logging.getLogger(__name__)

# Default engine weights, used when a strategy doesn't supply its own.
# Matches the historical "Alpha Fusion" profile.
DEFAULT_FUSION_WEIGHTS: Dict[str, float] = {
    'sentiment': 0.35,
    'trend': 0.25,
    'fundamental': 0.15,
    'event_risk': 0.15,
    'liquidity': 0.10,
}

# Engines that may be part of a weighting profile, in a fixed order.
_WEIGHT_KEYS = ('sentiment', 'trend', 'fundamental', 'event_risk', 'liquidity')


def _normalize_weights(raw: Optional[Dict[str, Any]]) -> Dict[str, float]:
    """
    Accept a user-supplied weights dict, coerce to floats, fill in missing
    keys from the default profile, and normalize to sum to 1.0 (so a
    strategy that accidentally supplies weights that don't add up still
    produces a score on the same [-1, 1] scale as the default profile).
    """
    if not isinstance(raw, dict) or not raw:
        return dict(DEFAULT_FUSION_WEIGHTS)

    merged: Dict[str, float] = {}
    for key in _WEIGHT_KEYS:
        val = raw.get(key, DEFAULT_FUSION_WEIGHTS[key])
        try:
            merged[key] = max(0.0, float(val))
        except (TypeError, ValueError):
            merged[key] = DEFAULT_FUSION_WEIGHTS[key]

    total = sum(merged.values())
    if total <= 0:
        return dict(DEFAULT_FUSION_WEIGHTS)
    return {k: v / total for k, v in merged.items()}


class FusionEngine(BaseEngine):
    """
    Fusion engine that combines all engine scores.

    Weights are **per-strategy**: each call to :meth:`calculate` can pass a
    ``weights`` dict (typically from the strategy's ``engine_weights`` field
    in NestJS). When no weights are provided the default profile is used.

    Default formula:
        final_score = 0.35*sentiment + 0.25*trend + 0.15*fundamental
                      + 0.15*event_risk + 0.10*liquidity
    """

    def __init__(self):
        super().__init__("FusionEngine")
        # Retained for backward compatibility with any caller that reads
        # `fusion_engine.weights` directly. Per-call weights are now the
        # primary mechanism.
        self.weights = dict(DEFAULT_FUSION_WEIGHTS)

    def calculate(
        self,
        asset_id: str,
        asset_type: str,
        timeframe: Optional[str] = None,
        engine_scores: Optional[Dict[str, Dict[str, Any]]] = None,
        weights: Optional[Dict[str, Any]] = None,
        buy_threshold: Optional[float] = None,
        sell_threshold: Optional[float] = None,
        **kwargs
    ) -> Dict[str, Any]:
        """
        Calculate fusion score from all engine scores.

        Args:
            asset_id: Asset identifier
            asset_type: 'crypto' or 'stock'
            timeframe: Optional timeframe
            engine_scores: Dictionary with engine scores:
                {
                    'sentiment': {'score': float, 'confidence': float},
                    'trend': {'score': float, 'confidence': float},
                    'fundamental': {'score': float, 'confidence': float},
                    'event_risk': {'score': float, 'confidence': float},
                    'liquidity': {'score': float, 'confidence': float}
                }
            weights: Optional per-strategy engine weights. When omitted the
                default profile is used. Non-numeric or negative values fall
                back to the default for that engine. The final profile is
                normalized so its values sum to 1.0.
            buy_threshold: Optional override for the BUY action cutoff. If
                omitted, asset-type defaults apply (0.5 stock, 0.3 crypto).
            sell_threshold: Optional override for the SELL action cutoff.
            **kwargs: Additional parameters (ignored)

        Returns:
            Dictionary with final_score, action, and metadata
        """
        try:
            if not self.validate_inputs(asset_id, asset_type):
                return self.handle_error(ValueError("Invalid inputs"), "validation")

            if engine_scores is None:
                return self.handle_error(
                    ValueError("Engine scores required"),
                    "data"
                )

            # Resolve the weighting profile for THIS strategy (not the
            # hardcoded instance default). This is the core of the
            # per-strategy differentiation fix.
            active_weights = _normalize_weights(weights)

            # Extract scores. An engine that failed or had no data returns
            # ``score = None`` (see BaseEngine.handle_error / handle_no_data).
            # We deliberately do NOT coerce None to 0 here — a silent 0 drags
            # the final score toward HOLD even though the engine had no
            # opinion. Instead we build a "valid scores" view and re-normalize
            # the surviving weights to sum to 1.0.
            raw_scores: Dict[str, Optional[float]] = {
                key: engine_scores.get(key, {}).get('score') for key in _WEIGHT_KEYS
            }

            valid_scores: Dict[str, float] = {}
            engines_skipped: list[str] = []
            for key, val in raw_scores.items():
                if val is None or (isinstance(val, float) and (val != val)):  # None or NaN
                    engines_skipped.append(key)
                else:
                    try:
                        valid_scores[key] = float(val)
                    except (TypeError, ValueError):
                        engines_skipped.append(key)

            # event_risk_score is used by _determine_action for the safety
            # override; if it was skipped, treat as 0.0 for that check (i.e.,
            # no event-risk veto when we have no event-risk data).
            event_risk_score_for_action = valid_scores.get('event_risk', 0.0)

            if not valid_scores:
                # Nothing to fuse — surface as no_data instead of a fake 0.
                return self.handle_no_data(
                    'all engines returned null',
                    context=f"asset={asset_id} type={asset_type}",
                )

            valid_weight_sum = sum(active_weights[k] for k in valid_scores)
            if valid_weight_sum <= 0:
                # All non-null engines have zero weight; treat as no_data.
                return self.handle_no_data(
                    'no weight assigned to engines with valid scores',
                    context=f"asset={asset_id} type={asset_type}",
                )

            rebalanced_weights: Dict[str, float] = {
                k: active_weights[k] / valid_weight_sum for k in valid_scores
            }

            weighted_avg = sum(
                rebalanced_weights[k] * valid_scores[k] for k in valid_scores
            )

            # Synergy bonus — multi-engine alignment is a real signal that
            # weighted averaging dilutes. When 3+ engines independently agree
            # in the same direction (each contributing ≥|0.15|), that's harder
            # to fake than a single strong signal carrying the average. So we
            # add a small bonus in the agreed direction.
            #
            # Asymmetric on purpose: positive synergy gets the full bump (we
            # want to surface high-conviction BUYs); negative synergy gets
            # half (we don't want to chase weak shorts harder than the data
            # warrants).
            ALIGN_THRESHOLD = 0.15
            pos_aligned = sum(1 for v in valid_scores.values() if v >= ALIGN_THRESHOLD)
            neg_aligned = sum(1 for v in valid_scores.values() if v <= -ALIGN_THRESHOLD)
            synergy_bonus = 0.0
            synergy_reason = None
            if pos_aligned >= 4:
                synergy_bonus = 0.10
                synergy_reason = f'{pos_aligned}-engine positive alignment'
            elif pos_aligned >= 3:
                synergy_bonus = 0.05
                synergy_reason = f'{pos_aligned}-engine positive alignment'
            elif neg_aligned >= 4:
                synergy_bonus = -0.05
                synergy_reason = f'{neg_aligned}-engine negative alignment'
            elif neg_aligned >= 3:
                synergy_bonus = -0.025
                synergy_reason = f'{neg_aligned}-engine negative alignment'

            final_score = max(-1.0, min(1.0, weighted_avg + synergy_bonus))

            # Determine action using per-strategy thresholds (falls back
            # to asset-type defaults when not supplied).
            action = self._determine_action(
                final_score,
                event_risk_score_for_action,
                asset_type,
                buy_threshold=buy_threshold,
                sell_threshold=sell_threshold,
            )

            # Calculate overall confidence — only across engines that
            # actually contributed a score. A skipped (None) engine doesn't
            # have a meaningful confidence to factor in.
            confidences = []
            weight_used = []
            for key in valid_scores:
                conf = engine_scores.get(key, {}).get('confidence', 0.0)
                if conf and conf > 0:
                    confidences.append(conf)
                    weight_used.append(rebalanced_weights[key])

            if confidences and weight_used:
                total_weight = sum(weight_used)
                if total_weight > 0:
                    normalized = [w / total_weight for w in weight_used]
                    overall_confidence = sum(c * w for c, w in zip(confidences, normalized))
                else:
                    overall_confidence = sum(confidences) / len(confidences)
            else:
                overall_confidence = 0.5

            # When less than half of the engines contributed, knock confidence
            # down — even a fused score from 1-2 engines is shakier than one
            # built from all 5.
            if len(valid_scores) < (len(_WEIGHT_KEYS) / 2.0):
                overall_confidence *= 0.5

            metadata = {
                'action': action,
                # Full per-engine view (None for engines that were skipped) —
                # written to strategy_signals.engine_metadata so a HOLD/BUY
                # can be inspected to see WHY: which engines voted, which
                # were missing, and what weight each one carried.
                'score_breakdown': raw_scores,
                'engines_used': sorted(valid_scores.keys()),
                'engines_skipped': sorted(engines_skipped),
                'weights': active_weights,
                'rebalanced_weights': rebalanced_weights,
                'weights_source': 'strategy' if weights else 'default',
                'weighted_avg_pre_synergy': weighted_avg,
                'synergy_bonus': synergy_bonus,
                'synergy_reason': synergy_reason,
                'positive_alignments': pos_aligned,
                'negative_alignments': neg_aligned,
            }

            return {
                'score': self.clamp_score(final_score),
                'confidence': self.clamp_score(overall_confidence, 0.0, 1.0),
                'action': action,
                'metadata': metadata
            }

        except Exception as e:
            return self.handle_error(e, f"calculation for {asset_id}")

    def _determine_action(
        self,
        final_score: float,
        event_risk_score: float,
        asset_type: str = 'crypto',
        buy_threshold: Optional[float] = None,
        sell_threshold: Optional[float] = None,
    ) -> str:
        """
        Determine trading action based on scores.

        Args:
            final_score: Combined fusion score
            event_risk_score: Event risk score
            asset_type: 'crypto' or 'stock' (retained for logging/context;
                default BUY/SELL thresholds are the same for both)
            buy_threshold: Optional override; when provided, replaces the
                asset-type default BUY cutoff.
            sell_threshold: Optional override for the SELL cutoff.

        Returns:
            Action: 'BUY', 'SELL', or 'HOLD'
            Note: AVOID is mapped to HOLD for schema compatibility (SignalAction enum doesn't include AVOID)
        """
        # High risk events result in HOLD action regardless of thresholds.
        # AVOID mapped to HOLD for schema compatibility.
        if event_risk_score < -0.5:
            return 'HOLD'

        # Per-strategy thresholds take priority; otherwise use asset-type
        # defaults. Stocks and crypto both use 0.3. The old stock default of 0.5
        # sat above the 95th percentile (often above the max) of the actual
        # stock score distribution — median ~0, p95 ~0.2–0.36 — so only 0–4
        # stocks/run ever qualified. 0.3 lands around the top ~8% of stocks,
        # scaling BUYs with sentiment strength instead of starving them.
        if buy_threshold is None:
            buy_threshold = 0.3
        if sell_threshold is None:
            sell_threshold = -0.3

        if final_score > buy_threshold:
            return 'BUY'
        elif final_score < sell_threshold:
            return 'SELL'
        else:
            return 'HOLD'
