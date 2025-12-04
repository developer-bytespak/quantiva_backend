"""
Sentiment Engine
Analyzes sentiment from news, social media, and other text sources using FinGPT.
"""
from typing import Dict, Any, Optional, List
import logging

from .base_engine import BaseEngine
from src.models.fingpt import get_fingpt_inference

logger = logging.getLogger(__name__)


class SentimentEngine(BaseEngine):
    """
    Sentiment analysis engine using FinGPT model.
    Processes text from news, Twitter, Reddit, and other sources.
    """
    
    def __init__(self):
        """Initialize sentiment engine with FinGPT inference."""
        super().__init__("SentimentEngine")
        self.fingpt_inference = None
        self._initialize_inference()
    
    def _initialize_inference(self):
        """Lazy initialization of FinGPT inference."""
        try:
            self.fingpt_inference = get_fingpt_inference()
            self.logger.info("FinGPT inference initialized")
        except Exception as e:
            self.logger.error(f"Failed to initialize FinGPT inference: {str(e)}")
            self.fingpt_inference = None
    
    def calculate(
        self,
        asset_id: str,
        asset_type: str,
        timeframe: Optional[str] = None,
        text_data: Optional[List[Dict[str, Any]]] = None,
        **kwargs
    ) -> Dict[str, Any]:
        """
        Calculate sentiment score for an asset.
        
        Args:
            asset_id: Asset identifier (symbol or UUID)
            asset_type: Type of asset ('crypto' or 'stock')
            timeframe: Optional timeframe for analysis
            text_data: Optional list of text data dictionaries with:
                - 'text': str - The text content
                - 'source': str - Source identifier (e.g., 'news', 'twitter', 'reddit')
            **kwargs: Additional parameters
        
        Returns:
            Dictionary with:
                - score: float in range [-1, 1] (positive=1, neutral=0, negative=-1)
                - confidence: float in range [0, 1]
                - metadata: dict with sentiment breakdown and source information
        """
        try:
            if not self.validate_inputs(asset_id, asset_type):
                return self.handle_error(ValueError("Invalid inputs"), "validation")
            
            # Check if FinGPT inference is available
            if self.fingpt_inference is None:
                self.logger.warning("FinGPT inference not available, returning neutral score")
                return self.create_result(
                    0.0,
                    0.0,
                    {
                        'note': 'FinGPT inference not initialized',
                        'asset_id': asset_id
                    }
                )
            
            # If no text data provided, return neutral score
            if not text_data or len(text_data) == 0:
                self.logger.warning(f"No text data provided for {asset_id}, returning neutral score")
                return self.create_result(
                    0.0,
                    0.0,
                    {
                        'note': 'No text data provided',
                        'asset_id': asset_id
                    }
                )
            
            # Analyze sentiment for each text
            sentiment_results = []
            for text_item in text_data:
                text = text_item.get('text', '')
                source = text_item.get('source', 'unknown')
                
                if not text:
                    continue
                
                # Analyze sentiment
                result = self.fingpt_inference.analyze_financial_text(text, source=source)
                sentiment_results.append(result)
            
            if not sentiment_results:
                self.logger.warning(f"No valid text data found for {asset_id}")
                return self.create_result(
                    0.0,
                    0.0,
                    {
                        'note': 'No valid text data',
                        'asset_id': asset_id
                    }
                )
            
            # Aggregate sentiments
            aggregated = self.fingpt_inference.aggregate_sentiments(sentiment_results)
            
            # Convert sentiment label to score
            sentiment_score = self._sentiment_to_score(aggregated['overall_sentiment'])
            
            # Normalize score to [-1, 1] range
            normalized_score = self.normalize_score(
                sentiment_score,
                input_min=-1.0,
                input_max=1.0
            )
            
            # Use aggregated confidence
            confidence = aggregated.get('confidence', 0.5)
            
            # Build metadata
            metadata = {
                'overall_sentiment': aggregated['overall_sentiment'],
                'sentiment_breakdown': aggregated.get('breakdown', {}),
                'total_texts': aggregated.get('total_texts', 0),
                'individual_results': sentiment_results,
                'asset_id': asset_id,
                'asset_type': asset_type
            }
            
            return self.create_result(
                normalized_score,
                confidence,
                metadata
            )
            
        except Exception as e:
            return self.handle_error(e, f"sentiment analysis for {asset_id}")
    
    def _sentiment_to_score(self, sentiment: str) -> float:
        """
        Convert sentiment label to numeric score.
        
        Args:
            sentiment: Sentiment label ('positive', 'neutral', 'negative')
            
        Returns:
            Numeric score: positive=1.0, neutral=0.0, negative=-1.0
        """
        sentiment_lower = sentiment.lower()
        
        if sentiment_lower == 'positive':
            return 1.0
        elif sentiment_lower == 'negative':
            return -1.0
        else:
            return 0.0
    
    def analyze_text(self, text: str, source: Optional[str] = None) -> Dict[str, Any]:
        """
        Analyze sentiment of a single text.
        Convenience method for direct text analysis.
        
        Args:
            text: Text to analyze
            source: Optional source identifier
            
        Returns:
            Dictionary with sentiment analysis result
        """
        if self.fingpt_inference is None:
            self._initialize_inference()
        
        if self.fingpt_inference is None:
            return {
                'sentiment': 'neutral',
                'score': 0.0,
                'confidence': 0.0,
                'error': 'FinGPT inference not available'
            }
        
        result = self.fingpt_inference.analyze_financial_text(text, source=source)
        score = self._sentiment_to_score(result['sentiment'])
        
        return {
            'sentiment': result['sentiment'],
            'score': score,
            'confidence': result['confidence'],
            'source': source
        }
