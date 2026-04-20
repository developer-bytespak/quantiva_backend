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

            # Extract scores (default to 0 if not provided)
            sentiment_score = engine_scores.get('sentiment', {}).get('score', 0.0)
            trend_score = engine_scores.get('trend', {}).get('score', 0.0)
            fundamental_score = engine_scores.get('fundamental', {}).get('score', 0.0)
            event_risk_score = engine_scores.get('event_risk', {}).get('score', 0.0)
            liquidity_score = engine_scores.get('liquidity', {}).get('score', 0.0)

            # Calculate weighted final score using the strategy's weights
            final_score = (
                active_weights['sentiment'] * sentiment_score +
                active_weights['trend'] * trend_score +
                active_weights['fundamental'] * fundamental_score +
                active_weights['event_risk'] * event_risk_score +
                active_weights['liquidity'] * liquidity_score
            )

            # Determine action using per-strategy thresholds (falls back
            # to asset-type defaults when not supplied).
            action = self._determine_action(
                final_score,
                event_risk_score,
                asset_type,
                buy_threshold=buy_threshold,
                sell_threshold=sell_threshold,
            )

            # Calculate overall confidence — weighted by the SAME profile
            # so confidence reflects the strategy's own priorities.
            confidences = []
            weight_used = []
            for key in _WEIGHT_KEYS:
                if key in engine_scores:
                    conf = engine_scores[key].get('confidence', 0.0)
                    if conf and conf > 0:
                        confidences.append(conf)
                        weight_used.append(active_weights[key])

            if confidences and weight_used:
                total_weight = sum(weight_used)
                if total_weight > 0:
                    normalized = [w / total_weight for w in weight_used]
                    overall_confidence = sum(c * w for c, w in zip(confidences, normalized))
                else:
                    overall_confidence = sum(confidences) / len(confidences)
            else:
                overall_confidence = 0.5

            metadata = {
                'action': action,
                'score_breakdown': {
                    'sentiment': sentiment_score,
                    'trend': trend_score,
                    'fundamental': fundamental_score,
                    'event_risk': event_risk_score,
                    'liquidity': liquidity_score
                },
                'weights': active_weights,
                'weights_source': 'strategy' if weights else 'default',
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
            asset_type: 'crypto' or 'stock' (affects default thresholds)
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
        # defaults. Stocks require higher conviction (0.5) vs crypto (0.3).
        if buy_threshold is None:
            buy_threshold = 0.5 if asset_type == 'stock' else 0.3
        if sell_threshold is None:
            sell_threshold = -0.5 if asset_type == 'stock' else -0.3

        if final_score > buy_threshold:
            return 'BUY'
        elif final_score < sell_threshold:
            return 'SELL'
        else:
            return 'HOLD'
