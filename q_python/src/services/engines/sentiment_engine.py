"""
Sentiment Engine
Analyzes sentiment from news, social media, and other text sources using FinBERT.
"""
from typing import Dict, Any, Optional, List
import logging

from .base_engine import BaseEngine
from src.models.finbert import get_finbert_inference
from src.services.data.stock_news_service import StockNewsService
from src.services.data.lunarcrush_service import LunarCrushService

logger = logging.getLogger(__name__)


class SentimentEngine(BaseEngine):
    """
    Sentiment analysis engine using FinBERT model.
    Processes text from news, Twitter, Reddit, and other sources.
    """
    
    def __init__(self):
        """Initialize sentiment engine with FinBERT inference."""
        super().__init__("SentimentEngine")
        self.finbert_inference = None
        self.stock_news_service = StockNewsService()
        self.lunarcrush_service = LunarCrushService()
        # Do NOT initialize here - load on first request to avoid blocking API startup
        self._initialization_attempted = False
    
    def _ensure_inference_initialized(self):
        """Ensure FinBERT inference is initialized (truly lazy loading)."""
        if self.finbert_inference is not None:
            return True
        
        if self._initialization_attempted:
            return False
        
        self._initialization_attempted = True
        try:
            self.logger.info("Initializing FinBERT inference (lazy loading)...")
            self.finbert_inference = get_finbert_inference()
            self.logger.info("FinBERT inference initialized successfully")
            return True
        except Exception as e:
            self.logger.error(f"Failed to initialize FinBERT inference: {str(e)}", exc_info=True)
            self.finbert_inference = None
            return False
    
    def calculate(
        self,
        asset_id: str,
        asset_type: str,
        timeframe: Optional[str] = None,
        text_data: Optional[List[Dict[str, Any]]] = None,
        news_source: Optional[str] = None,
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
            news_source: Optional source to fetch news from ('stock_news_api', 'lunarcrush', 'manual')
                        If None and text_data not provided, will auto-detect based on asset_type
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
            
            # Ensure FinBERT inference is initialized (lazy loading)
            if not self._ensure_inference_initialized():
                self.logger.warning("FinBERT inference not available, returning neutral score with error flag")
                return self.create_result(
                    0.0,
                    0.0,
                    {
                        'note': 'FinBERT inference not initialized',
                        'asset_id': asset_id,
                        'error': True,
                        'error_message': 'FinBERT model failed to initialize'
                    }
                )
            
            # If no text data provided, try to fetch from APIs
            if not text_data or len(text_data) == 0:
                text_data = self._fetch_news_data(asset_id, asset_type, news_source)
            
            # If still no text data, return neutral score
            if not text_data or len(text_data) == 0:
                self.logger.warning(f"No text data available for {asset_id}, returning neutral score")
                return self.create_result(
                    0.0,
                    0.0,
                    {
                        'note': 'No text data available',
                        'asset_id': asset_id,
                        'asset_type': asset_type
                    }
                )
            
            # Analyze sentiment for each text
            sentiment_results = []
            for text_item in text_data:
                text = text_item.get('text', '')
                source = text_item.get('source', 'unknown')
                
                if not text:
                    continue
                
                # Analyze sentiment using FinBERT
                result = self.finbert_inference.analyze_financial_text(text, source=source)
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
            aggregated = self.finbert_inference.aggregate_sentiments(sentiment_results)
            
            # Use aggregated score directly (already in [-1, 1] range)
            normalized_score = aggregated.get('score', 0.0)
            
            # Use aggregated confidence
            confidence = aggregated.get('confidence', 0.5)
            
            # Build metadata
            metadata = {
                'overall_sentiment': aggregated['overall_sentiment'],
                'sentiment_breakdown': aggregated.get('breakdown', {}),
                'total_texts': aggregated.get('total_texts', 0),
                'individual_results': sentiment_results,
                'asset_id': asset_id,
                'asset_type': asset_type,
                'error': aggregated.get('error', False),
                'error_count': aggregated.get('error_count', 0),
                'timeout_count': aggregated.get('timeout_count', 0),
                'news_source': news_source or 'auto'
            }
            
            # Log warnings if there were errors
            if aggregated.get('error', False):
                error_count = aggregated.get('error_count', 0)
                timeout_count = aggregated.get('timeout_count', 0)
                self.logger.warning(
                    f"Sentiment analysis completed with {error_count} errors "
                    f"({timeout_count} timeouts) for {asset_id}"
                )
            
            return self.create_result(
                normalized_score,
                confidence,
                metadata
            )
            
        except Exception as e:
            return self.handle_error(e, f"sentiment analysis for {asset_id}")
    
    def _fetch_news_data(
        self,
        asset_id: str,
        asset_type: str,
        news_source: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        Fetch news data from appropriate API based on asset type.
        
        Args:
            asset_id: Asset identifier (symbol)
            asset_type: Type of asset ('crypto' or 'stock')
            news_source: Optional source override ('stock_news_api', 'lunarcrush', 'manual')
        
        Returns:
            List of text data dictionaries
        """
        text_data = []
        
        try:
            if asset_type == 'stock':
                # Fetch from StockNewsAPI
                if news_source in (None, 'stock_news_api', 'auto'):
                    self.logger.info(f"Fetching stock news for {asset_id} from StockNewsAPI...")
                    news_items = self.stock_news_service.fetch_news(asset_id, limit=50)
                    
                    for item in news_items:
                        # Combine title and text for analysis
                        text = item.get('text', '')
                        title = item.get('title', '')
                        combined_text = f"{title}. {text}" if title and text else (text or title)
                        
                        if combined_text:
                            text_data.append({
                                'text': combined_text,
                                'source': item.get('source', 'stock_news_api'),
                                'published_at': item.get('published_at'),
                                'url': item.get('url')
                            })
            
            elif asset_type == 'crypto':
                # Fetch from LunarCrush
                if news_source in (None, 'lunarcrush', 'auto'):
                    self.logger.info(f"Fetching crypto news for {asset_id} from LunarCrush...")
                    news_items = self.lunarcrush_service.fetch_coin_news(asset_id, limit=50)
                    
                    for item in news_items:
                        # Combine title and text for analysis
                        text = item.get('text', '')
                        title = item.get('title', '')
                        combined_text = f"{title}. {text}" if title and text else (text or title)
                        
                        if combined_text:
                            text_data.append({
                                'text': combined_text,
                                'source': item.get('source', 'lunarcrush'),
                                'published_at': item.get('published_at'),
                                'url': item.get('url')
                            })
            
            self.logger.info(f"Fetched {len(text_data)} news items for {asset_id}")
            
        except Exception as e:
            self.logger.error(f"Error fetching news data: {str(e)}", exc_info=True)
        
        return text_data
    
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
        if not self._ensure_inference_initialized():
            return {
                'sentiment': 'neutral',
                'score': 0.0,
                'confidence': 0.0,
                'error': True,
                'error_message': 'FinBERT inference not available'
            }
        
        result = self.finbert_inference.analyze_financial_text(text, source=source)
        # FinBERT already returns score in [-1, 1] range, so use it directly
        score = result.get('score', 0.0)
        
        return {
            'sentiment': result['sentiment'],
            'score': score,
            'confidence': result['confidence'],
            'source': source
        }
