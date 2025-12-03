"""
Base Engine Class
Abstract base class for all trading strategy engines.
All engines must implement the calculate() method and return scores in -1 to +1 range.
"""
from abc import ABC, abstractmethod
from typing import Dict, Any, Optional
import logging
import numpy as np

logger = logging.getLogger(__name__)


class BaseEngine(ABC):
    """
    Abstract base class for all trading engines.
    Provides common utilities for score normalization and validation.
    """
    
    def __init__(self, name: str):
        """
        Initialize base engine.
        
        Args:
            name: Engine name for logging
        """
        self.name = name
        self.logger = logging.getLogger(f"{__name__}.{name}")
    
    @abstractmethod
    def calculate(
        self,
        asset_id: str,
        asset_type: str,
        timeframe: Optional[str] = None,
        **kwargs
    ) -> Dict[str, Any]:
        """
        Calculate engine score for an asset.
        
        Args:
            asset_id: Asset identifier (symbol or UUID)
            asset_type: Type of asset ('crypto' or 'stock')
            timeframe: Optional timeframe for analysis
            **kwargs: Additional parameters specific to engine
        
        Returns:
            Dictionary with:
                - score: float in range [-1, 1]
                - confidence: float in range [0, 1]
                - metadata: dict with additional information
        """
        pass
    
    def validate_inputs(
        self,
        asset_id: Optional[str] = None,
        asset_type: Optional[str] = None,
        **kwargs
    ) -> bool:
        """
        Validate required inputs for engine calculation.
        
        Args:
            asset_id: Asset identifier
            asset_type: Type of asset
            **kwargs: Additional parameters
        
        Returns:
            True if inputs are valid, False otherwise
        """
        if not asset_id:
            self.logger.error(f"{self.name}: asset_id is required")
            return False
        
        if asset_type and asset_type not in ['crypto', 'stock']:
            self.logger.error(f"{self.name}: Invalid asset_type: {asset_type}")
            return False
        
        return True
    
    def normalize_score(
        self,
        score: float,
        min_val: float = -1.0,
        max_val: float = 1.0,
        input_min: Optional[float] = None,
        input_max: Optional[float] = None
    ) -> float:
        """
        Normalize a score to the range [-1, 1].
        
        Args:
            score: Raw score to normalize
            min_val: Minimum output value (default: -1.0)
            max_val: Maximum output value (default: 1.0)
            input_min: Minimum input value (for scaling)
            input_max: Maximum input value (for scaling)
        
        Returns:
            Normalized score in range [min_val, max_val]
        """
        if input_min is not None and input_max is not None:
            # Scale from input range to output range
            if input_max == input_min:
                return 0.0
            normalized = (score - input_min) / (input_max - input_min)
            return min_val + normalized * (max_val - min_val)
        else:
            # Simple clamping
            return max(min_val, min(max_val, score))
    
    def clamp_score(self, score: float, min_val: float = -1.0, max_val: float = 1.0) -> float:
        """
        Clamp score to valid range.
        
        Args:
            score: Score to clamp
            min_val: Minimum value (default: -1.0)
            max_val: Maximum value (default: 1.0)
        
        Returns:
            Clamped score
        """
        return max(min_val, min(max_val, score))
    
    def calculate_confidence(
        self,
        data_points: int,
        data_freshness_hours: float,
        required_points: int = 10,
        max_age_hours: float = 24.0
    ) -> float:
        """
        Calculate confidence based on data quality.
        
        Args:
            data_points: Number of data points available
            data_freshness_hours: Hours since last data update
            required_points: Minimum required data points
            max_age_hours: Maximum acceptable data age in hours
        
        Returns:
            Confidence score in range [0, 1]
        """
        # Data completeness factor
        completeness = min(1.0, data_points / required_points) if required_points > 0 else 1.0
        
        # Data freshness factor
        freshness = max(0.0, 1.0 - (data_freshness_hours / max_age_hours)) if max_age_hours > 0 else 1.0
        
        # Combined confidence
        confidence = (completeness * 0.6 + freshness * 0.4)
        return self.clamp_score(confidence, 0.0, 1.0)
    
    def handle_error(self, error: Exception, context: str = "") -> Dict[str, Any]:
        """
        Handle errors and return default score.
        
        Args:
            error: Exception that occurred
            context: Additional context information
        
        Returns:
            Dictionary with error score and metadata
        """
        self.logger.error(f"{self.name} error{': ' + context if context else ''}: {str(error)}")
        return {
            'score': 0.0,
            'confidence': 0.0,
            'metadata': {
                'error': str(error),
                'context': context
            }
        }
    
    def create_result(
        self,
        score: float,
        confidence: float = 1.0,
        metadata: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """
        Create standardized result dictionary.
        
        Args:
            score: Engine score in range [-1, 1]
            confidence: Confidence level in range [0, 1]
            metadata: Additional metadata
        
        Returns:
            Standardized result dictionary
        """
        return {
            'score': self.clamp_score(score),
            'confidence': self.clamp_score(confidence, 0.0, 1.0),
            'metadata': metadata or {}
        }
