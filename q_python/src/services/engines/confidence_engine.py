"""
Confidence Engine
Calculates confidence level for signals and determines position sizing.
"""
from typing import Dict, Any, Optional
import numpy as np
import logging

from .base_engine import BaseEngine

logger = logging.getLogger(__name__)


class ConfidenceEngine(BaseEngine):
    """
    Confidence engine that calculates:
    - Confidence multiplier using cube root formula
    - Position sizing based on confidence and risk level
    """
    
    def __init__(self):
        super().__init__("ConfidenceEngine")
        self.risk_multipliers = {
            'low': 0.02,      # 2% of portfolio
            'medium': 0.05,   # 5% of portfolio
            'high': 0.10      # 10% of portfolio
        }
    
    def calculate(
        self,
        asset_id: str,
        asset_type: str,
        timeframe: Optional[str] = None,
        sentiment_confidence: float = 0.5,  # Placeholder until Engine 1 is implemented
        trend_strength: float = 0.5,
        data_freshness: float = 1.0,
        diversification_weight: float = 1.0,
        risk_level: str = 'medium',
        portfolio_value: Optional[float] = None,
        stop_loss_distance: Optional[float] = None,
        max_allocation: float = 0.10,  # 10% max per asset
        **kwargs
    ) -> Dict[str, Any]:
        """
        Calculate confidence and position sizing.
        
        Args:
            asset_id: Asset identifier
            asset_type: 'crypto' or 'stock'
            timeframe: Optional timeframe
            sentiment_confidence: Confidence from sentiment engine (0-1)
            trend_strength: Strength of trend signals (0-1)
            data_freshness: Data freshness factor (0-1)
            diversification_weight: Portfolio diversification factor (0-1)
            risk_level: Risk level ('low', 'medium', 'high')
            portfolio_value: Total portfolio value
            stop_loss_distance: Stop loss distance as percentage (e.g., 0.05 for 5%)
            max_allocation: Maximum allocation per asset (default 0.10 = 10%)
            **kwargs: Additional parameters
        
        Returns:
            Dictionary with confidence, position_size, and metadata
        """
        try:
            if not self.validate_inputs(asset_id, asset_type):
                return self.handle_error(ValueError("Invalid inputs"), "validation")
            
            # Calculate confidence using cube root formula
            confidence = self._calculate_confidence(
                sentiment_confidence,
                trend_strength,
                data_freshness,
                diversification_weight
            )
            
            # Calculate position size if portfolio value provided
            position_size = None
            position_percentage = None
            risk_adjusted_size = None
            
            if portfolio_value and portfolio_value > 0:
                position_size, position_percentage, risk_adjusted_size = self._calculate_position_size(
                    confidence=confidence,
                    risk_level=risk_level,
                    portfolio_value=portfolio_value,
                    stop_loss_distance=stop_loss_distance,
                    max_allocation=max_allocation
                )
            
            metadata = {
                'confidence_factors': {
                    'sentiment_confidence': sentiment_confidence,
                    'trend_strength': trend_strength,
                    'data_freshness': data_freshness,
                    'diversification_weight': diversification_weight
                },
                'risk_level': risk_level,
                'position_size': position_size,
                'position_percentage': position_percentage,
                'risk_adjusted_size': risk_adjusted_size,
                'max_allocation': max_allocation
            }
            
            return {
                'confidence': self.clamp_score(confidence, 0.0, 1.0),
                'position_size': position_size,
                'position_percentage': position_percentage,
                'risk_adjusted_size': risk_adjusted_size,
                'metadata': metadata
            }
            
        except Exception as e:
            return self.handle_error(e, f"calculation for {asset_id}")
    
    def _calculate_confidence(
        self,
        sentiment_confidence: float,
        trend_strength: float,
        data_freshness: float,
        diversification_weight: float
    ) -> float:
        """
        Calculate confidence using cube root formula.
        
        Formula: confidence = cube_root(sentiment_confidence * trend_strength * data_freshness * diversification_weight)
        
        Cube root prevents any single factor from dominating.
        
        Args:
            sentiment_confidence: Confidence from sentiment engine (0-1)
            trend_strength: Strength of trend signals (0-1)
            data_freshness: Data freshness factor (0-1)
            diversification_weight: Portfolio diversification factor (0-1)
        
        Returns:
            Confidence in range [0, 1]
        """
        try:
            # Clamp all inputs to [0, 1]
            sentiment_confidence = self.clamp_score(sentiment_confidence, 0.0, 1.0)
            trend_strength = self.clamp_score(trend_strength, 0.0, 1.0)
            data_freshness = self.clamp_score(data_freshness, 0.0, 1.0)
            diversification_weight = self.clamp_score(diversification_weight, 0.0, 1.0)
            
            # Calculate product
            product = sentiment_confidence * trend_strength * data_freshness * diversification_weight
            
            # Apply cube root
            confidence = np.cbrt(product)
            
            return self.clamp_score(confidence, 0.0, 1.0)
            
        except Exception as e:
            self.logger.error(f"Error calculating confidence: {str(e)}")
            return 0.5  # Default confidence
    
    def _calculate_position_size(
        self,
        confidence: float,
        risk_level: str,
        portfolio_value: float,
        stop_loss_distance: Optional[float] = None,
        max_allocation: float = 0.10
    ) -> tuple:
        """
        Calculate position size based on confidence and risk parameters.
        
        Args:
            confidence: Confidence level (0-1)
            risk_level: Risk level ('low', 'medium', 'high')
            portfolio_value: Total portfolio value
            stop_loss_distance: Stop loss distance as percentage (e.g., 0.05 for 5%)
            max_allocation: Maximum allocation per asset (default 0.10 = 10%)
        
        Returns:
            Tuple of (position_size, position_percentage, risk_adjusted_size)
        """
        try:
            # Get base position size based on risk level
            risk_multiplier = self.risk_multipliers.get(risk_level, 0.05)  # Default to medium
            base_size = portfolio_value * risk_multiplier
            
            # Adjust based on confidence
            confidence_adjusted_size = base_size * confidence
            
            # Adjust based on stop-loss distance
            # Closer stop-loss = larger position (risk is controlled)
            # Further stop-loss = smaller position
            if stop_loss_distance and stop_loss_distance > 0:
                # Normalize to 5% stop-loss baseline
                stop_loss_multiplier = min(1.0, 0.05 / stop_loss_distance)
                final_position_size = confidence_adjusted_size * stop_loss_multiplier
            else:
                final_position_size = confidence_adjusted_size
            
            # Apply maximum allocation constraint
            max_position_size = portfolio_value * max_allocation
            final_position_size = min(final_position_size, max_position_size)
            
            # Calculate position percentage
            position_percentage = (final_position_size / portfolio_value) * 100 if portfolio_value > 0 else 0.0
            
            return (
                float(final_position_size),
                float(position_percentage),
                float(final_position_size)  # risk_adjusted_size is same as final_position_size
            )
            
        except Exception as e:
            self.logger.error(f"Error calculating position size: {str(e)}")
            return (0.0, 0.0, 0.0)
    
    def calculate_trend_strength(
        self,
        trend_score: float,
        indicator_agreement: float = 1.0
    ) -> float:
        """
        Calculate trend strength from trend score and indicator agreement.
        
        Args:
            trend_score: Trend score from technical engine (-1 to 1)
            indicator_agreement: Agreement factor between indicators (0-1)
        
        Returns:
            Trend strength (0-1)
        """
        # Convert trend score (-1 to 1) to strength (0 to 1)
        trend_strength = abs(trend_score)
        
        # Adjust by indicator agreement
        trend_strength = trend_strength * indicator_agreement
        
        return self.clamp_score(trend_strength, 0.0, 1.0)
    
    def calculate_data_freshness(
        self,
        hours_since_update: float,
        max_age_hours: float = 24.0
    ) -> float:
        """
        Calculate data freshness factor.
        
        Args:
            hours_since_update: Hours since last data update
            max_age_hours: Maximum acceptable data age in hours
        
        Returns:
            Data freshness factor (0-1)
        """
        if max_age_hours <= 0:
            return 1.0
        
        freshness = max(0.0, 1.0 - (hours_since_update / max_age_hours))
        return self.clamp_score(freshness, 0.0, 1.0)
    
    def calculate_diversification_weight(
        self,
        current_positions: int,
        max_positions: int = 10,
        correlation: float = 0.0
    ) -> float:
        """
        Calculate diversification weight.
        
        Args:
            current_positions: Number of current positions
            max_positions: Maximum recommended positions
            correlation: Correlation with existing positions (0-1)
        
        Returns:
            Diversification weight (0-1)
        """
        # Position count factor
        if current_positions >= max_positions:
            count_factor = 0.3  # Penalize if too many positions
        else:
            count_factor = 1.0 - (current_positions / max_positions) * 0.5
        
        # Correlation factor (lower correlation = better)
        correlation_factor = 1.0 - correlation
        
        # Combined weight
        diversification_weight = (count_factor * 0.6 + correlation_factor * 0.4)
        
        return self.clamp_score(diversification_weight, 0.0, 1.0)
