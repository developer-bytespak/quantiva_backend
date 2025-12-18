"""
Sentiment Engine
Analyzes sentiment from news, social media, and other text sources using FinBERT.
"""
from typing import Dict, Any, Optional, List
from datetime import datetime
import logging

from .base_engine import BaseEngine
# Defer importing the heavy FinBERT modules until needed (lazy import)
from src.services.data.stock_news_service import StockNewsService
from src.services.data.lunarcrush_service import LunarCrushService
from src.services.data.ema_state_service import EMAStateService
from src.services.sentiment import CryptoKeywordAnalyzer, SentimentAggregator, MarketSignalAnalyzer

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
        # Initialize sentiment analysis components (lightweight, no model loading)
        self.keyword_analyzer = CryptoKeywordAnalyzer()
        self.aggregator = SentimentAggregator()
        self.market_signal_analyzer = MarketSignalAnalyzer()
        self.ema_state_service = EMAStateService()
        # Do NOT initialize FinBERT here - load on first request to avoid blocking API startup
        self._initialization_attempted = False
        
        # EMA configuration
        self.ema_alpha = 0.125  # As specified
        
        # Source-specific weights
        self.source_weights = {
            'twitter': 1.0,
            'reddit': 0.8,
            'news': 1.2,
            'stock_news_api': 1.2,
            'lunarcrush': 1.0,
            'default': 1.0
        }
    
    def _ensure_inference_initialized(self):
        """Ensure FinBERT inference is initialized (truly lazy loading)."""
        if self.finbert_inference is not None:
            return True
        
        if self._initialization_attempted:
            return False
        
        self._initialization_attempted = True
        # Respect SKIP_ML_INIT to allow the API to start without loading ML libraries
        import os
        skip = os.environ.get("SKIP_ML_INIT", "").lower()
        if skip in ("1", "true", "yes"):
            self.logger.info("SKIP_ML_INIT enabled; skipping FinBERT initialization at startup")
            return False

        try:
            self.logger.info("Initializing FinBERT inference (lazy loading)...")
            # Import inside the function to avoid heavy imports at module import time
            from src.models.finbert import get_finbert_inference
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
        exchange: Optional[str] = None,
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
            # Fetch social metrics from LunarCrush EARLY (before potential early returns)
            # This ensures trending_assets gets populated even if no news text is available
            social_metrics = {}
            if asset_type == 'crypto':
                try:
                    social_metrics = self.lunarcrush_service.fetch_social_metrics(asset_id)
                    self.logger.debug(f"Fetched social metrics for {asset_id}: galaxy_score={social_metrics.get('galaxy_score')}, alt_rank={social_metrics.get('alt_rank')}, price={social_metrics.get('price')}")
                except Exception as e:
                    self.logger.warning(f"Failed to fetch social metrics for {asset_id}: {str(e)}")
            
            if not text_data:
                self.logger.warning(f"No text data available for {asset_id}, returning neutral score with social metrics")
                return self.create_result(
                    0.0,
                    0.0,
                    {
                        'note': 'No text data available',
                        'asset_id': asset_id,
                        'asset_type': asset_type,
                        'social_metrics': social_metrics
                    }
                )
            
            # Detect news_type from sources if not already present
            news_type = self._detect_news_type(text_data)
            
            # Analyze sentiment for each text using FinBERT
            ml_results = []
            keyword_results = []
            
            for text_item in text_data:
                text = text_item.get('text', '')
                source = text_item.get('source', 'unknown')
                
                if not text:
                    continue
                
                # FinBERT analysis (ML layer)
                try:
                    ml_result = self.finbert_inference.analyze_financial_text(text, source=source)
                    # Apply source weight to score
                    source_weight = self._get_source_weight(source)
                    ml_result['score'] = ml_result.get('score', 0.0) * source_weight
                    ml_results.append(ml_result)
                except Exception as e:
                    self.logger.warning(f"FinBERT analysis failed for text: {str(e)}")
                    continue
                
                # Keyword analysis (only for crypto)
                if asset_type == 'crypto':
                    try:
                        keyword_result = self.keyword_analyzer.analyze(text)
                        keyword_results.append(keyword_result)
                    except Exception as e:
                        self.logger.warning(f"Keyword analysis failed: {str(e)}")
                        # Continue without keyword analysis
            
            if not ml_results:
                self.logger.warning(f"No valid text data found for {asset_id}")
                return self.create_result(
                    0.0,
                    0.0,
                    {
                        'note': 'No valid text data',
                        'asset_id': asset_id
                    }
                )
            
            # Aggregate ML results (weighted by source)
            ml_aggregated = self.finbert_inference.aggregate_sentiments(ml_results)
            ml_result = {
                'score': ml_aggregated.get('score', 0.0),
                'confidence': ml_aggregated.get('confidence', 0.5)
            }
            
            # Aggregate keyword results (for crypto)
            keyword_result = None
            if asset_type == 'crypto' and keyword_results:
                try:
                    keyword_aggregated = self._aggregate_keyword_results(keyword_results)
                    keyword_result = {
                        'score': keyword_aggregated.get('score', 0.0),
                        'confidence': keyword_aggregated.get('confidence', 0.5)
                    }
                except Exception as e:
                    self.logger.warning(f"Keyword aggregation failed: {str(e)}")
                    keyword_result = None
            
            # Market signal analysis
            connection_id = kwargs.get('connection_id')  # Optional connection ID for NestJS API
            market_result = None
            try:
                market_result = self.market_signal_analyzer.analyze(
                    asset_id,
                    asset_type,
                    exchange or 'binance',
                    connection_id
                )
            except Exception as e:
                self.logger.warning(f"Market signal analysis failed: {str(e)}")
                market_result = {'score': 0.0, 'confidence': 0.0}
            
            # Aggregate all layers using SentimentAggregator
            aggregated = self.aggregator.aggregate(
                ml_result=ml_result,
                keyword_result=keyword_result,
                market_result=market_result,
                asset_type=asset_type,
                news_type=news_type
            )
            
            # Get raw aggregated score (before EMA)
            raw_score = aggregated.get('score', 0.0)
            confidence = aggregated.get('confidence', 0.5)
            
            # Apply EMA smoothing
            current_timestamp = datetime.now()
            ema_score, momentum = self._apply_ema_and_momentum(asset_id, raw_score, current_timestamp)
            
            # Include momentum in final score (weighted combination)
            # Momentum weight: 0.2 (20% of momentum adjustment)
            momentum_weight = 0.2
            momentum_adjustment = momentum * momentum_weight
            final_score = ema_score + momentum_adjustment
            
            # Clamp final score to [-1, 1]
            final_score = self.clamp_score(final_score)
            
            # Build metadata
            metadata = {
                'overall_sentiment': aggregated.get('sentiment', 'neutral'),
                'sentiment_breakdown': ml_aggregated.get('breakdown', {}),
                'total_texts': ml_aggregated.get('total_texts', 0),
                'individual_ml_results': ml_results,
                'asset_id': asset_id,
                'asset_type': asset_type,
                'news_type': news_type,
                'news_source': news_source or 'auto',
                'layer_breakdown': aggregated.get('breakdown', {}),
                'layers': aggregated.get('layers', {}),
                'keyword_analysis': keyword_result if asset_type == 'crypto' else None,
                'market_signals': market_result.get('signals', {}) if market_result else None,
                'social_metrics': social_metrics,
                'error': ml_aggregated.get('error', False),
                'error_count': ml_aggregated.get('error_count', 0),
                'timeout_count': ml_aggregated.get('timeout_count', 0),
                'ema': {
                    'raw_score': raw_score,
                    'ema_score': ema_score,
                    'momentum': momentum,
                    'momentum_adjustment': momentum_adjustment,
                    'final_score': final_score,
                    'alpha': self.ema_alpha
                }
            }
            
            # Log warnings if there were errors
            if ml_aggregated.get('error', False):
                error_count = ml_aggregated.get('error_count', 0)
                timeout_count = ml_aggregated.get('timeout_count', 0)
                self.logger.warning(
                    f"Sentiment analysis completed with {error_count} errors "
                    f"({timeout_count} timeouts) for {asset_id}"
                )
            
            return self.create_result(
                final_score,
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
                            source = item.get('source', 'stock_news_api')
                            news_type = self._detect_news_type_from_source(source)
                            text_data.append({
                                'text': combined_text,
                                'source': source,
                                'news_type': news_type,
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
                            source = item.get('source', 'lunarcrush')
                            news_type = self._detect_news_type_from_source(source)
                            text_data.append({
                                'text': combined_text,
                                'source': source,
                                'news_type': news_type,
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
    
    def _detect_news_type(self, text_data: List[Dict[str, Any]]) -> str:
        """
        Detect news type from text data sources.
        
        Args:
            text_data: List of text data dictionaries
        
        Returns:
            'social' or 'formal'
        """
        if not text_data:
            return 'formal'
        
        # Check if any item has news_type already set
        for item in text_data:
            if item.get('news_type'):
                return item.get('news_type')
        
        # Detect from sources
        social_count = 0
        formal_count = 0
        
        for item in text_data:
            source = item.get('source', '').lower()
            news_type = self._detect_news_type_from_source(source)
            if news_type == 'social':
                social_count += 1
            else:
                formal_count += 1
        
        # Return majority type, default to formal
        return 'social' if social_count > formal_count else 'formal'
    
    def _detect_news_type_from_source(self, source: str) -> str:
        """
        Detect news type from source string.
        
        Args:
            source: Source identifier
        
        Returns:
            'social' or 'formal'
        """
        if not source:
            return 'formal'
        
        source_lower = source.lower()
        
        # Social media indicators
        social_indicators = ['twitter', 'reddit', 'social', 'tweet', 'post', 'x.com']
        if any(indicator in source_lower for indicator in social_indicators):
            return 'social'
        
        # Formal news indicators
        formal_indicators = ['news', 'article', 'press', 'media', 'cointelegraph', 'cryptonews', 'forbes', 'reuters']
        if any(indicator in source_lower for indicator in formal_indicators):
            return 'formal'
        
        # Default to formal
        return 'formal'
    
    def _aggregate_keyword_results(self, keyword_results: List[Dict[str, Any]]) -> Dict[str, Any]:
        """
        Aggregate multiple keyword analysis results.
        
        Args:
            keyword_results: List of keyword analysis results
        
        Returns:
            Aggregated result with score and confidence
        """
        if not keyword_results:
            return {'score': 0.0, 'confidence': 0.0}
        
        # Weighted average of scores
        total_score = 0.0
        total_confidence = 0.0
        total_weight = 0.0
        
        for result in keyword_results:
            score = result.get('score', 0.0)
            confidence = result.get('confidence', 0.0)
            
            # Weight by confidence
            weight = confidence
            total_score += score * weight
            total_confidence += confidence
            total_weight += weight
        
        if total_weight > 0:
            avg_score = total_score / total_weight
            avg_confidence = total_confidence / len(keyword_results)
        else:
            avg_score = 0.0
            avg_confidence = 0.0
        
        # Determine sentiment
        if avg_score > 0.1:
            sentiment = 'positive'
        elif avg_score < -0.1:
            sentiment = 'negative'
        else:
            sentiment = 'neutral'
        
        return {
            'sentiment': sentiment,
            'score': max(-1.0, min(1.0, avg_score)),
            'confidence': max(0.0, min(1.0, avg_confidence))
        }
    
    def _get_source_weight(self, source: str) -> float:
        """
        Get source weight for sentiment score adjustment.
        
        Args:
            source: Source identifier
            
        Returns:
            Source weight (float)
        """
        if not source:
            return self.source_weights.get('default', 1.0)
        
        source_lower = source.lower()
        
        # Check for exact matches first
        if source_lower in self.source_weights:
            return self.source_weights[source_lower]
        
        # Check for partial matches
        if 'twitter' in source_lower or 'x.com' in source_lower or 'tweet' in source_lower:
            return self.source_weights.get('twitter', 1.0)
        elif 'reddit' in source_lower:
            return self.source_weights.get('reddit', 0.8)
        elif 'news' in source_lower or 'article' in source_lower:
            return self.source_weights.get('news', 1.2)
        elif 'lunarcrush' in source_lower:
            return self.source_weights.get('lunarcrush', 1.0)
        elif 'stock_news' in source_lower:
            return self.source_weights.get('stock_news_api', 1.2)
        
        return self.source_weights.get('default', 1.0)
    
    def _apply_ema_and_momentum(
        self,
        asset_id: str,
        weighted_score: float,
        current_timestamp: datetime
    ) -> tuple:
        """
        Apply EMA smoothing and calculate momentum.
        
        Formula:
        ema_sentiment[t] = alpha * weighted_score + (1-alpha) * ema_sentiment[t-1]
        sentiment_momentum = (ema_sentiment[t] - ema_sentiment[t-1]) / time_delta
        
        Args:
            asset_id: Asset identifier
            weighted_score: Current weighted sentiment score
            current_timestamp: Current timestamp
            
        Returns:
            Tuple of (ema_score, momentum)
        """
        # Get previous EMA state from database
        previous_state = self.ema_state_service.get_ema_state(asset_id)
        
        if previous_state is None:
            # No previous state - use current score as initial EMA
            ema_score = weighted_score
            momentum = 0.0
        else:
            previous_ema = previous_state['ema_value']
            previous_timestamp = previous_state['last_timestamp']
            
            # Calculate EMA
            # ema_sentiment[t] = alpha * weighted_score + (1-alpha) * ema_sentiment[t-1]
            ema_score = self.ema_alpha * weighted_score + (1 - self.ema_alpha) * previous_ema
            
            # Calculate momentum
            # sentiment_momentum = (ema_sentiment[t] - ema_sentiment[t-1]) / time_delta
            if isinstance(previous_timestamp, datetime):
                time_delta = (current_timestamp - previous_timestamp).total_seconds() / 3600.0  # Convert to hours
            else:
                # If timestamp is not datetime, assume 1 hour
                time_delta = 1.0
            
            # Prevent division by zero
            if time_delta > 0:
                momentum = (ema_score - previous_ema) / time_delta
            else:
                momentum = 0.0
        
        # Save current EMA state to database
        self.ema_state_service.save_ema_state(asset_id, ema_score, current_timestamp)
        
        return ema_score, momentum
