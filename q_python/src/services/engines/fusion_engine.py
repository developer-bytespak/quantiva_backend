"""
Fusion Engine
Combines all individual engine scores into a single trading signal.
"""
from typing import Dict, Any, Optional
import logging

from .base_engine import BaseEngine

logger = logging.getLogger(__name__)


class FusionEngine(BaseEngine):
    """
    Fusion engine that combines all engine scores.
    
    Formula:
    final_score = 0.35*sentiment + 0.25*trend + 0.15*fundamental + 0.15*event_risk + 0.10*liquidity
    """
    
    def __init__(self):
        super().__init__("FusionEngine")
        self.weights = {
            'sentiment': 0.35,
            'trend': 0.25,
            'fundamental': 0.15,
            'event_risk': 0.15,
            'liquidity': 0.10
        }
    
    def calculate(
        self,
        asset_id: str,
        asset_type: str,
        timeframe: Optional[str] = None,
        engine_scores: Optional[Dict[str, Dict[str, Any]]] = None,
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
            **kwargs: Additional parameters
        
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
            
            # Extract scores (default to 0 if not provided)
            sentiment_score = engine_scores.get('sentiment', {}).get('score', 0.0)
            trend_score = engine_scores.get('trend', {}).get('score', 0.0)
            fundamental_score = engine_scores.get('fundamental', {}).get('score', 0.0)
            event_risk_score = engine_scores.get('event_risk', {}).get('score', 0.0)
            liquidity_score = engine_scores.get('liquidity', {}).get('score', 0.0)
            
            # Calculate weighted final score
            final_score = (
                self.weights['sentiment'] * sentiment_score +
                self.weights['trend'] * trend_score +
                self.weights['fundamental'] * fundamental_score +
                self.weights['event_risk'] * event_risk_score +
                self.weights['liquidity'] * liquidity_score
            )
            
            # Determine action
            action = self._determine_action(final_score, event_risk_score)
            
            # Calculate overall confidence (weighted average, but only count engines with data)
            confidences = []
            weights = []
            
            # Sentiment engine (always present, weight: 0.35)
            if 'sentiment' in engine_scores:
                conf = engine_scores['sentiment'].get('confidence', 0.0)
                if conf > 0:
                    confidences.append(conf)
                    weights.append(0.35)
            
            # Trend engine (weight: 0.25, but may be missing)
            if 'trend' in engine_scores:
                conf = engine_scores['trend'].get('confidence', 0.0)
                if conf > 0:
                    confidences.append(conf)
                    weights.append(0.25)
            
            # Fundamental engine (always present, weight: 0.15)
            if 'fundamental' in engine_scores:
                conf = engine_scores['fundamental'].get('confidence', 0.0)
                if conf > 0:
                    confidences.append(conf)
                    weights.append(0.15)
            
            # Event risk engine (always present, weight: 0.15)
            if 'event_risk' in engine_scores:
                conf = engine_scores['event_risk'].get('confidence', 0.0)
                if conf > 0:
                    confidences.append(conf)
                    weights.append(0.15)
            
            # Liquidity engine (weight: 0.10, but may be missing)
            if 'liquidity' in engine_scores:
                conf = engine_scores['liquidity'].get('confidence', 0.0)
                if conf > 0:
                    confidences.append(conf)
                    weights.append(0.10)
            
            # Calculate weighted average confidence
            if confidences and weights:
                total_weight = sum(weights)
                if total_weight > 0:
                    # Normalize weights to sum to 1.0
                    normalized_weights = [w / total_weight for w in weights]
                    overall_confidence = sum(c * w for c, w in zip(confidences, normalized_weights))
                else:
                    overall_confidence = sum(confidences) / len(confidences) if confidences else 0.5
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
                'weights': self.weights
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
        event_risk_score: float
    ) -> str:
        """
        Determine trading action based on scores.
        
        Args:
            final_score: Combined fusion score
            event_risk_score: Event risk score
        
        Returns:
            Action: 'BUY', 'SELL', or 'HOLD'
            Note: AVOID is mapped to HOLD for schema compatibility (SignalAction enum doesn't include AVOID)
        """
        # AVOID mapped to HOLD for schema compatibility (SignalAction enum doesn't include AVOID)
        # High risk events result in HOLD action
        if event_risk_score < -0.5:
            return 'HOLD'
        
        # Determine action based on final score
        if final_score > 0.3:
            return 'BUY'
        elif final_score < -0.3:
            return 'SELL'
        else:
            return 'HOLD'
