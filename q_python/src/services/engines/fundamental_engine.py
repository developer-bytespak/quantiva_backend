"""
Fundamental Engine
Analyzes fundamental metrics for stocks and crypto assets.
"""
from typing import Dict, Any, Optional, List
import logging

from .base_engine import BaseEngine
from src.services.data.lunarcrush_service import LunarCrushService
from src.services.data.coingecko_service import CoinGeckoService
from src.services.data.stock_news_service import StockNewsService
from src.models.finbert import get_finbert_inference

logger = logging.getLogger(__name__)


class FundamentalEngine(BaseEngine):
    """
    Fundamental analysis engine.
    
    For Stocks:
    - Analyzes earnings, revenue, and financial performance news using FinBERT
    
    For Crypto:
    - Analyzes Galaxy Score, developer activity, and social metrics
    - Combines LunarCrush and CoinGecko data
    """
    
    def __init__(self):
        super().__init__("FundamentalEngine")
        self.lunarcrush_service = LunarCrushService()
        self.coingecko_service = CoinGeckoService()
        self.stock_news_service = StockNewsService()
        self.finbert_inference = None  # Lazy initialization
    
    def calculate(
        self,
        asset_id: str,
        asset_type: str,
        timeframe: Optional[str] = None,
        **kwargs
    ) -> Dict[str, Any]:
        """
        Calculate fundamental score.
        
        Args:
            asset_id: Asset identifier
            asset_type: 'crypto' or 'stock'
            timeframe: Optional timeframe
            **kwargs: Additional parameters
        
        Returns:
            Dictionary with score, confidence, and metadata
        """
        try:
            if not self.validate_inputs(asset_id, asset_type):
                return self.handle_error(ValueError("Invalid inputs"), "validation")
            
            if asset_type == 'crypto':
                return self._calculate_crypto_fundamental(asset_id, **kwargs)
            elif asset_type == 'stock':
                return self._calculate_stock_fundamental(asset_id, **kwargs)
            else:
                return self.handle_error(ValueError(f"Unsupported asset_type: {asset_type}"), "validation")
                
        except Exception as e:
            return self.handle_error(e, f"calculation for {asset_id}")
    
    def _calculate_crypto_fundamental(
        self,
        asset_id: str,
        **kwargs
    ) -> Dict[str, Any]:
        """
        Calculate fundamental score for crypto assets.
        
        Combines data from LunarCrush (Galaxy Score, Alt Rank) and CoinGecko (Developer Activity).
        
        Formula:
        fundamental_score = 0.50 * galaxy_score + 0.30 * dev_activity + 0.20 * alt_rank
        
        Args:
            asset_id: Crypto asset identifier (UUID or symbol)
            **kwargs: Additional parameters (asset_symbol for external API calls)
        
        Returns:
            Dictionary with score, confidence, and metadata
        """
        try:
            # Use asset_symbol if provided (for external API calls), otherwise use asset_id
            asset_symbol = kwargs.get('asset_symbol', asset_id)
            
            # Fetch data from LunarCrush (needs symbol, not UUID)
            lunarcrush_metrics = self.lunarcrush_service.fetch_social_metrics(asset_symbol)
            
            # Fetch developer activity from CoinGecko (needs symbol, not UUID)
            try:
                dev_activity_data = self.coingecko_service.get_developer_activity_score(asset_symbol)
            except Exception as e:
                self.logger.warning(f"Error fetching developer activity for {asset_symbol}: {str(e)}")
                dev_activity_data = {'activity_score': 0}
            
            # Fetch tokenomics data from CoinGecko (needs symbol, not UUID)
            try:
                tokenomics_data = self.coingecko_service.get_tokenomics_score(asset_symbol)
            except Exception as e:
                self.logger.warning(f"Error fetching tokenomics for {asset_symbol}: {str(e)}")
                tokenomics_data = {'tokenomics_score': 0}
            
            # Extract metrics
            galaxy_score = lunarcrush_metrics.get('galaxy_score', 0)  # 0-100 scale
            alt_rank = lunarcrush_metrics.get('alt_rank', 999999)  # Lower is better
            social_volume = lunarcrush_metrics.get('social_volume', 0)
            
            # Developer activity score from CoinGecko (0-100 scale)
            dev_activity = dev_activity_data.get('activity_score', 0)
            
            # Tokenomics score from CoinGecko (0-100 scale)
            tokenomics_score = tokenomics_data.get('tokenomics_score', 0)
            
            # Check if we have sufficient data
            has_lunarcrush = galaxy_score > 0 or alt_rank < 999999
            has_coingecko = dev_activity > 0
            has_tokenomics = tokenomics_score > 0
            
            if not has_lunarcrush and not has_coingecko and not has_tokenomics:
                self.logger.warning(f"No data available for {asset_id}")
                return self.create_result(
                    0.0,
                    0.0,
                    {
                        'note': 'No data available from APIs',
                        'asset_id': asset_id
                    }
                )
            
            # Normalize metrics to -1 to +1
            galaxy_score_norm = self.normalize_score(galaxy_score, input_min=0, input_max=100) if has_lunarcrush else 0.0
            dev_activity_norm = self.normalize_score(dev_activity, input_min=0, input_max=100) if has_coingecko else 0.0
            tokenomics_norm = self.normalize_score(tokenomics_score, input_min=0, input_max=100) if has_tokenomics else 0.0
            
            # Alt rank: lower is better, so invert
            # Normalize assuming rank 1-1000 range (rank 1 = best, rank 1000 = worst)
            if has_lunarcrush and alt_rank < 999999:
                alt_rank_norm = self.normalize_score(1000 - alt_rank, input_min=0, input_max=999)
            else:
                alt_rank_norm = 0.0
            
            # Calculate weighted fundamental score
            # Original weights: 0.50 (galaxy) + 0.30 (dev) + 0.20 (alt_rank) = 1.0
            # Add tokenomics with 0.10 weight, adjust others proportionally
            # New weights: 0.45 (galaxy) + 0.27 (dev) + 0.18 (alt_rank) + 0.10 (tokenomics) = 1.0
            total_weight = 0.0
            weighted_score = 0.0
            
            if has_lunarcrush:
                weighted_score += 0.45 * galaxy_score_norm
                total_weight += 0.45
            
            if has_coingecko:
                weighted_score += 0.27 * dev_activity_norm
                total_weight += 0.27
            
            if has_lunarcrush and alt_rank_norm > 0:
                weighted_score += 0.18 * alt_rank_norm
                total_weight += 0.18
            
            if has_tokenomics:
                weighted_score += 0.10 * tokenomics_norm
                total_weight += 0.10
            
            # Normalize by actual weight used
            if total_weight > 0:
                fundamental_score = weighted_score / total_weight
            else:
                fundamental_score = 0.0
            
            # Calculate confidence based on data availability
            data_sources_count = sum([has_lunarcrush, has_coingecko, has_tokenomics])
            if data_sources_count >= 3:
                confidence = 0.85
            elif data_sources_count == 2:
                confidence = 0.75
            else:
                confidence = 0.6
            
            metadata = {
                'galaxy_score': galaxy_score,
                'developer_activity': dev_activity,
                'tokenomics_score': tokenomics_score,
                'alt_rank': alt_rank,
                'social_volume': social_volume,
                'code_changes_4w': dev_activity_data.get('code_additions_deletions_4_weeks', {}).get('net', 0),
                'github_forks': dev_activity_data.get('forks', 0),
                'github_stars': dev_activity_data.get('stars', 0),
                'dilution_risk': tokenomics_data.get('dilution_risk', 0),
                'fdv_mc_ratio': tokenomics_data.get('fdv_mc_ratio'),
                'circulating_supply': tokenomics_data.get('circulating_supply', 0),
                'max_supply': tokenomics_data.get('max_supply'),
                'score_breakdown': {
                    'galaxy_score_norm': galaxy_score_norm,
                    'dev_activity_norm': dev_activity_norm,
                    'alt_rank_norm': alt_rank_norm,
                    'tokenomics_norm': tokenomics_norm,
                },
                'sources': []
            }
            
            if has_lunarcrush:
                metadata['sources'].append('lunarcrush')
            if has_coingecko:
                metadata['sources'].append('coingecko')
            if has_tokenomics:
                metadata['sources'].append('coingecko_tokenomics')
            
            return self.create_result(fundamental_score, confidence, metadata)
            
        except Exception as e:
            self.logger.error(f"Error calculating crypto fundamental score: {str(e)}", exc_info=True)
            return self.create_result(
                0.0,
                0.0,
                {
                    'error': True,
                    'error_message': str(e),
                    'asset_id': asset_id
                }
            )
    
    def _calculate_stock_fundamental(
        self,
        asset_id: str,
        **kwargs
    ) -> Dict[str, Any]:
        """
        Calculate fundamental score for stocks.
        
        Analyzes news sentiment for earnings, revenue, and financial performance using FinBERT.
        
        Formula:
        fundamental_score = 0.40 * earnings_sentiment + 0.35 * revenue_sentiment + 0.25 * performance_sentiment
        
        Args:
            asset_id: Stock symbol (e.g., 'AAPL', 'TSLA')
            **kwargs: Additional parameters
        
        Returns:
            Dictionary with score, confidence, and metadata
        """
        try:
            # Fetch news from Stock News API
            news_data = self.stock_news_service.fetch_news(asset_id, limit=50)
            
            if not news_data:
                self.logger.warning(f"No news data available for {asset_id}")
                return self.create_result(
                    0.0,
                    0.0,
                    {
                        'note': 'No news data available',
                        'asset_id': asset_id
                    }
                )
            
            # Analyze earnings news sentiment
            earnings_sentiment, earnings_count = self._analyze_earnings_news(news_data)
            
            # Analyze revenue news sentiment
            revenue_sentiment, revenue_count = self._analyze_revenue_news(news_data)
            
            # Analyze financial performance news
            performance_sentiment, performance_count = self._analyze_performance_news(news_data)
            
            # Calculate weighted fundamental score
            total_news_count = earnings_count + revenue_count + performance_count
            
            if total_news_count == 0:
                # No relevant news found
                return self.create_result(
                    0.0,
                    0.3,
                    {
                        'note': 'No relevant financial news found',
                        'total_news': len(news_data),
                        'asset_id': asset_id
                    }
                )
            
            fundamental_score = (
                0.40 * earnings_sentiment +
                0.35 * revenue_sentiment +
                0.25 * performance_sentiment
            )
            
            # Confidence based on number of relevant articles
            confidence = min(0.9, 0.5 + (total_news_count / 30) * 0.4)
            
            metadata = {
                'earnings_sentiment': earnings_sentiment,
                'revenue_sentiment': revenue_sentiment,
                'performance_sentiment': performance_sentiment,
                'news_analyzed': len(news_data),
                'earnings_news_count': earnings_count,
                'revenue_news_count': revenue_count,
                'performance_news_count': performance_count,
                'score_breakdown': {
                    'earnings_weighted': 0.40 * earnings_sentiment,
                    'revenue_weighted': 0.35 * revenue_sentiment,
                    'performance_weighted': 0.25 * performance_sentiment,
                },
                'source': 'stock_news_api'
            }
            
            return self.create_result(fundamental_score, confidence, metadata)
            
        except Exception as e:
            self.logger.error(f"Error calculating stock fundamental score: {str(e)}", exc_info=True)
            return self.create_result(
                0.0,
                0.0,
                {
                    'error': True,
                    'error_message': str(e),
                    'asset_id': asset_id
                }
            )
    
    def _ensure_finbert_initialized(self) -> bool:
        """Ensure FinBERT inference is initialized."""
        if self.finbert_inference is None:
            try:
                self.finbert_inference = get_finbert_inference()
                return True
            except Exception as e:
                self.logger.error(f"Failed to initialize FinBERT: {str(e)}")
                return False
        return True
    
    def _analyze_earnings_news(self, news_data: List[Dict[str, Any]]) -> tuple:
        """
        Analyze earnings news sentiment using FinBERT.
        
        Filters news for earnings-related keywords and analyzes sentiment.
        
        Args:
            news_data: List of news article dictionaries with 'title' and 'text'
        
        Returns:
            Tuple of (sentiment_score, article_count)
            sentiment_score: Average sentiment in range [-1, 1]
            article_count: Number of earnings-related articles analyzed
        """
        if not self._ensure_finbert_initialized():
            return (0.0, 0)
        
        # Keywords for earnings-related news
        earnings_keywords = [
            'earnings', 'eps', 'profit', 'quarterly results', 'q1', 'q2', 'q3', 'q4',
            'beats expectations', 'misses expectations', 'earnings report', 'earnings call',
            'net income', 'operating income', 'earnings per share', 'guidance',
            'earnings beat', 'earnings miss', 'earnings surprise'
        ]
        
        earnings_articles = []
        for article in news_data:
            title = article.get('title', '').lower()
            text = article.get('text', '').lower()
            combined = f"{title} {text}"
            
            # Check if article contains earnings keywords
            if any(keyword in combined for keyword in earnings_keywords):
                earnings_articles.append(article)
        
        if not earnings_articles:
            return (0.0, 0)
        
        # Analyze sentiment for each earnings article
        sentiments = []
        for article in earnings_articles:
            try:
                text = article.get('text', '') or article.get('title', '')
                if text:
                    result = self.finbert_inference.analyze_financial_text(text, source='stock_news_api')
                    score = result.get('score', 0.0)
                    sentiments.append(score)
            except Exception as e:
                self.logger.warning(f"Error analyzing earnings article: {str(e)}")
                continue
        
        if not sentiments:
            return (0.0, len(earnings_articles))
        
        # Return average sentiment
        avg_sentiment = sum(sentiments) / len(sentiments)
        return (avg_sentiment, len(earnings_articles))
    
    def _analyze_revenue_news(self, news_data: List[Dict[str, Any]]) -> tuple:
        """
        Analyze revenue news sentiment using FinBERT.
        
        Filters news for revenue-related keywords and analyzes sentiment.
        
        Args:
            news_data: List of news article dictionaries with 'title' and 'text'
        
        Returns:
            Tuple of (sentiment_score, article_count)
            sentiment_score: Average sentiment in range [-1, 1]
            article_count: Number of revenue-related articles analyzed
        """
        if not self._ensure_finbert_initialized():
            return (0.0, 0)
        
        # Keywords for revenue-related news
        revenue_keywords = [
            'revenue', 'sales', 'income', 'top line', 'revenue growth', 'sales growth',
            'revenue beat', 'revenue miss', 'revenue target', 'sales target',
            'quarterly revenue', 'annual revenue', 'revenue guidance', 'sales guidance',
            'revenue increase', 'revenue decrease', 'sales increase', 'sales decrease'
        ]
        
        revenue_articles = []
        for article in news_data:
            title = article.get('title', '').lower()
            text = article.get('text', '').lower()
            combined = f"{title} {text}"
            
            # Check if article contains revenue keywords
            if any(keyword in combined for keyword in revenue_keywords):
                revenue_articles.append(article)
        
        if not revenue_articles:
            return (0.0, 0)
        
        # Analyze sentiment for each revenue article
        sentiments = []
        for article in revenue_articles:
            try:
                text = article.get('text', '') or article.get('title', '')
                if text:
                    result = self.finbert_inference.analyze_financial_text(text, source='stock_news_api')
                    score = result.get('score', 0.0)
                    sentiments.append(score)
            except Exception as e:
                self.logger.warning(f"Error analyzing revenue article: {str(e)}")
                continue
        
        if not sentiments:
            return (0.0, len(revenue_articles))
        
        # Return average sentiment
        avg_sentiment = sum(sentiments) / len(sentiments)
        return (avg_sentiment, len(revenue_articles))
    
    def _analyze_performance_news(self, news_data: List[Dict[str, Any]]) -> tuple:
        """
        Analyze financial performance news sentiment using FinBERT.
        
        Filters news for performance-related keywords and analyzes sentiment.
        
        Args:
            news_data: List of news article dictionaries with 'title' and 'text'
        
        Returns:
            Tuple of (sentiment_score, article_count)
            sentiment_score: Average sentiment in range [-1, 1]
            article_count: Number of performance-related articles analyzed
        """
        if not self._ensure_finbert_initialized():
            return (0.0, 0)
        
        # Keywords for performance-related news
        performance_keywords = [
            'performance', 'guidance', 'outlook', 'forecast', 'targets', 'expectations',
            'financial performance', 'operational performance', 'business performance',
            'upgrade guidance', 'downgrade guidance', 'raise guidance', 'lower guidance',
            'strong performance', 'weak performance', 'improved performance', 'declining performance',
            'growth outlook', 'future outlook', 'forward guidance'
        ]
        
        performance_articles = []
        for article in news_data:
            title = article.get('title', '').lower()
            text = article.get('text', '').lower()
            combined = f"{title} {text}"
            
            # Check if article contains performance keywords
            if any(keyword in combined for keyword in performance_keywords):
                performance_articles.append(article)
        
        if not performance_articles:
            return (0.0, 0)
        
        # Analyze sentiment for each performance article
        sentiments = []
        for article in performance_articles:
            try:
                text = article.get('text', '') or article.get('title', '')
                if text:
                    result = self.finbert_inference.analyze_financial_text(text, source='stock_news_api')
                    score = result.get('score', 0.0)
                    sentiments.append(score)
            except Exception as e:
                self.logger.warning(f"Error analyzing performance article: {str(e)}")
                continue
        
        if not sentiments:
            return (0.0, len(performance_articles))
        
        # Return average sentiment
        avg_sentiment = sum(sentiments) / len(sentiments)
        return (avg_sentiment, len(performance_articles))
