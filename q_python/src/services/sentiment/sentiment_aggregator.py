"""
Sentiment Aggregator
Combines multiple sentiment layers (ML, Keywords, Market) with weighted routing logic.
"""
import logging
from typing import Dict, Any, Optional

logger = logging.getLogger(__name__)


class SentimentAggregator:
    """
    Aggregates sentiment from multiple layers (ML, Keywords, Market) with routing logic.
    Applies different weights based on asset type and news source.
    """
    
    def __init__(self):
        """Initialize sentiment aggregator."""
        self.logger = logging.getLogger(__name__)
    
    def aggregate(
        self,
        ml_result: Dict[str, Any],
        keyword_result: Optional[Dict[str, Any]],
        market_result: Optional[Dict[str, Any]],
        asset_type: str,
        news_type: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Aggregate sentiment from multiple layers with routing logic.
        
        Routing weights:
        - Stock News: ML 80%, Market 20% (no keywords)
        - Crypto Formal News: ML 60%, Keywords 20%, Market 20%
        - Crypto Social Media: ML 50%, Keywords 30%, Market 20%
        
        Args:
            ml_result: ML (FinBERT) sentiment result with 'score' and 'confidence'
            keyword_result: Keyword analysis result (None for stocks)
            market_result: Market signal result with 'score' and 'confidence'
            asset_type: 'crypto' or 'stock'
            news_type: 'formal' or 'social' (None defaults to 'formal')
        
        Returns:
            Dictionary with:
                - sentiment: 'positive', 'negative', or 'neutral'
                - score: float in range [-1.0, 1.0]
                - confidence: float in range [0.0, 1.0]
                - breakdown: dict with individual layer scores
                - layers: dict with layer weights used
        """
        # Determine routing weights based on asset type and news type
        if asset_type == 'stock':
            ml_weight = 0.80
            keyword_weight = 0.0
            market_weight = 0.20
        elif asset_type == 'crypto':
            if news_type == 'social':
                ml_weight = 0.50
                keyword_weight = 0.30
                market_weight = 0.20
            else:  # formal or None
                ml_weight = 0.60
                keyword_weight = 0.20
                market_weight = 0.20
        else:
            # Unknown asset type, default to stock weights
            self.logger.warning(f"Unknown asset_type: {asset_type}, using stock weights")
            ml_weight = 0.80
            keyword_weight = 0.0
            market_weight = 0.20
        
        # Extract scores and confidences from each layer
        ml_score = ml_result.get('score', 0.0)
        ml_confidence = ml_result.get('confidence', 0.0)
        
        keyword_score = keyword_result.get('score', 0.0) if keyword_result else 0.0
        keyword_confidence = keyword_result.get('confidence', 0.0) if keyword_result else 0.0
        
        market_score = market_result.get('score', 0.0) if market_result else 0.0
        market_confidence = market_result.get('confidence', 0.0) if market_result else 0.0
        
        # Calculate weighted final score
        final_score = (
            ml_weight * ml_score +
            keyword_weight * keyword_score +
            market_weight * market_score
        )
        
        # Clamp to [-1.0, 1.0]
        final_score = max(-1.0, min(1.0, final_score))
        
        # Calculate weighted confidence
        # Preserve ML confidence as baseline, add bonus for other layers
        # This prevents confidence from dropping too much when other layers are weak
        ml_base_confidence = ml_confidence * ml_weight
        
        # Calculate weighted average (old method) for comparison
        total_weight = ml_weight + keyword_weight + market_weight
        if total_weight > 0:
            weighted_avg_confidence = (
                ml_weight * ml_confidence +
                keyword_weight * (keyword_confidence if keyword_result else 0.0) +
                market_weight * (market_confidence if market_result else 0.0)
            ) / total_weight
        else:
            weighted_avg_confidence = 0.0
        
        # Calculate bonus from other layers (only if they have meaningful confidence)
        keyword_bonus = 0.0
        if keyword_weight > 0 and keyword_result and keyword_confidence > 0.3:
            # Only add bonus if keyword confidence is meaningful (>0.3)
            keyword_bonus = keyword_weight * min(keyword_confidence, ml_confidence * 0.95)
        
        market_bonus = 0.0
        if market_weight > 0 and market_result and market_confidence > 0.3:
            # Only add bonus if market confidence is meaningful (>0.3)
            market_bonus = market_weight * min(market_confidence, ml_confidence * 0.95)
        
        # Final confidence: Use weighted average, but boost towards ML confidence
        # If other layers are weak, stay closer to ML confidence
        other_layers_total = keyword_bonus + market_bonus
        if other_layers_total > 0:
            # Other layers have meaningful confidence - use weighted average with slight ML boost
            final_confidence = weighted_avg_confidence * 0.7 + ml_confidence * 0.3
        else:
            # Other layers are weak - stay closer to ML confidence
            final_confidence = weighted_avg_confidence * 0.5 + ml_confidence * 0.5
        
        # Ensure confidence doesn't exceed ML confidence by too much
        final_confidence = min(final_confidence, ml_confidence * 1.1)
        
        # Clamp confidence to [0.0, 1.0]
        final_confidence = max(0.0, min(1.0, final_confidence))
        
        # Determine sentiment label
        if final_score > 0.1:
            sentiment = 'positive'
        elif final_score < -0.1:
            sentiment = 'negative'
        else:
            sentiment = 'neutral'
        
        # Build breakdown
        breakdown = {
            'ml': {
                'score': ml_score,
                'confidence': ml_confidence,
                'weight': ml_weight
            }
        }
        
        if keyword_result:
            breakdown['keywords'] = {
                'score': keyword_score,
                'confidence': keyword_confidence,
                'weight': keyword_weight
            }
        
        if market_result:
            breakdown['market'] = {
                'score': market_score,
                'confidence': market_confidence,
                'weight': market_weight
            }
        
        return {
            'sentiment': sentiment,
            'score': final_score,
            'confidence': final_confidence,
            'breakdown': breakdown,
            'layers': {
                'ml_weight': ml_weight,
                'keyword_weight': keyword_weight,
                'market_weight': market_weight
            },
            'asset_type': asset_type,
            'news_type': news_type or 'formal'
        }

