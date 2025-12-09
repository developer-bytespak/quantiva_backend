"""
LunarCrush Service
Fetches cryptocurrency news and social metrics from LunarCrush API v4.
"""
import logging
import requests
import time
from typing import List, Dict, Any, Optional
from datetime import datetime, timezone
from src.config import LUNARCRUSH_API_KEY

logger = logging.getLogger(__name__)


class LunarCrushService:
    """
    Service for fetching cryptocurrency news and social metrics from LunarCrush API v4.
    Includes rate limiting and caching to avoid 429 errors.
    """
    
    BASE_URL = "https://lunarcrush.com/api4"
    
    def __init__(self):
        """Initialize LunarCrushService."""
        self.logger = logging.getLogger(__name__)
        self.api_key = LUNARCRUSH_API_KEY
        
        # Simple in-memory cache (5 minutes TTL for social metrics, 1 minute for news)
        self._social_metrics_cache: Dict[str, tuple] = {}  # {symbol: (data, timestamp)}
        self._news_cache: Dict[str, tuple] = {}  # {symbol: (data, timestamp)}
        self.SOCIAL_METRICS_TTL = 5 * 60  # 5 minutes
        self.NEWS_TTL = 1 * 60  # 1 minute
        
        # Rate limiting: track last request time and wait if needed
        self._last_request_time = 0
        self._min_request_interval = 0.5  # Minimum 0.5 seconds between requests (2 requests/second max)
        
        if not self.api_key:
            self.logger.warning(
                "LUNARCRUSH_API_KEY not set. LunarCrush fetching will fail. "
                "Set LUNARCRUSH_API_KEY environment variable."
            )
    
    def _rate_limit(self):
        """Enforce rate limiting between API requests."""
        current_time = time.time()
        time_since_last = current_time - self._last_request_time
        if time_since_last < self._min_request_interval:
            sleep_time = self._min_request_interval - time_since_last
            time.sleep(sleep_time)
        self._last_request_time = time.time()
    
    def _cleanup_cache(self):
        """Remove expired cache entries to prevent memory growth."""
        current_time = time.time()
        
        # Clean social metrics cache
        expired_keys = [
            key for key, (_, timestamp) in self._social_metrics_cache.items()
            if current_time - timestamp > self.SOCIAL_METRICS_TTL * 2
        ]
        for key in expired_keys:
            del self._social_metrics_cache[key]
        
        # Clean news cache
        expired_keys = [
            key for key, (_, timestamp) in self._news_cache.items()
            if current_time - timestamp > self.NEWS_TTL * 2
        ]
        for key in expired_keys:
            del self._news_cache[key]
    
    def fetch_coin_news(
        self,
        symbol: str,
        limit: int = 50
    ) -> List[Dict[str, Any]]:
        """
        Fetch news for a cryptocurrency symbol.
        Uses caching to reduce API calls and avoid rate limits.
        
        Args:
            symbol: Cryptocurrency symbol (e.g., 'BTC', 'ETH', 'SOL')
            limit: Maximum number of news items to fetch (default: 50)
        
        Returns:
            List of news dictionaries with:
            - 'title': str - News headline
            - 'text': str - News content/description
            - 'source': str - News source
            - 'published_at': datetime - Publication timestamp
            - 'url': str - News article URL
        """
        if not self.api_key:
            self.logger.error("LUNARCRUSH_API_KEY not configured")
            return []
        
        # Check cache first
        cache_key = f"{symbol.upper()}_{limit}"
        if cache_key in self._news_cache:
            data, timestamp = self._news_cache[cache_key]
            if time.time() - timestamp < self.NEWS_TTL:
                self.logger.debug(f"Returning cached news for {symbol}")
                return data
        
        try:
            # Enforce rate limiting
            self._rate_limit()
            # LunarCrush API v4 endpoint for news
            # Endpoint: /public/topic/:topic/news/v1
            # Note: API v4 doesn't accept limit parameter - we limit results client-side
            url = f"{self.BASE_URL}/public/topic/{symbol.upper()}/news/v1"
            
            # LunarCrush API v4 uses Bearer token authentication
            headers = {}
            if self.api_key:
                # Use Bearer token authentication (standard for LunarCrush API v4)
                headers['Authorization'] = f'Bearer {self.api_key}'
            
            self.logger.info(f"Fetching news for {symbol} from LunarCrush API v4...")
            response = requests.get(url, headers=headers, timeout=30)
            response.raise_for_status()
            
            data = response.json()
            
            # Parse API v4 response format
            news_items = []
            
            # API v4 response structure: {'config': {...}, 'data': [...]}
            # Actual response has 'data' as a list of news items
            if isinstance(data, dict):
                articles = data.get('data', [])
                
                # Ensure articles is a list
                if not isinstance(articles, list):
                    articles = []
            elif isinstance(data, list):
                articles = data
            else:
                self.logger.warning(f"Unexpected response format from LunarCrush: {type(data)}")
                self.logger.debug(f"Response data: {str(data)[:500]}")
                articles = []
            
            for article in articles[:limit]:
                try:
                    # Parse API v4 article fields - actual field names from the API
                    # API returns: post_title, post_link, post_created (Unix timestamp), creator_display_name
                    title = article.get('post_title', article.get('title', ''))
                    url = article.get('post_link', article.get('url', article.get('link', '')))
                    
                    # Source is creator_display_name or creator_name
                    source = article.get('creator_display_name', article.get('creator_name', article.get('source', 'unknown')))
                    
                    # Description/text - API doesn't provide this, use title as fallback
                    text = article.get('description', title)
                    
                    # Use date as returned by LunarCrush API
                    published_at = article.get('date', article.get('published_at', article.get('post_created', article.get('created_at', None))))
                    
                    if title:
                        news_items.append({
                            'title': title,
                            'text': text or title,  # Use title if text is empty
                            'source': source,
                            'published_at': published_at,
                            'url': url
                        })
                except Exception as e:
                    self.logger.warning(f"Error parsing article: {str(e)}")
                    continue
            
            self.logger.info(f"Fetched {len(news_items)} news items for {symbol}")
            
            # Cache the result
            self._news_cache[cache_key] = (news_items, time.time())
            
            # Cleanup old cache entries periodically
            if len(self._news_cache) > 50:  # Cleanup if cache gets too large
                self._cleanup_cache()
            
            return news_items
            
        except requests.exceptions.HTTPError as e:
            if hasattr(e, 'response') and e.response is not None:
                if e.response.status_code == 429:
                    self.logger.warning(f"LunarCrush rate limit exceeded for {symbol}. Using cached data if available.")
                    # Try to return cached data even if expired
                    if cache_key in self._news_cache:
                        data, _ = self._news_cache[cache_key]
                        self.logger.info(f"Returning expired cache for {symbol} due to rate limit")
                        return data
                    return []
            self.logger.error(f"Error fetching news from LunarCrush: {str(e)}")
            if hasattr(e, 'response') and e.response is not None:
                self.logger.error(f"Response status: {e.response.status_code}")
                self.logger.error(f"Response body: {e.response.text[:500]}")
            return []
        except requests.exceptions.RequestException as e:
            self.logger.error(f"Error fetching news from LunarCrush: {str(e)}")
            if hasattr(e, 'response') and e.response is not None:
                self.logger.error(f"Response status: {e.response.status_code}")
                self.logger.error(f"Response body: {e.response.text[:500]}")
            return []
        except Exception as e:
            self.logger.error(f"Unexpected error fetching news: {str(e)}", exc_info=True)
            return []
    
    def fetch_social_metrics(
        self,
        symbol: str
    ) -> Dict[str, Any]:
        """
        Fetch social metrics for a cryptocurrency.
        Uses caching to reduce API calls and avoid rate limits.
        
        Args:
            symbol: Cryptocurrency symbol (e.g., 'BTC', 'ETH')
        
        Returns:
            Dictionary with social metrics:
            - 'social_volume': int - Social media mentions
            - 'social_score': float - Social sentiment score
            - 'galaxy_score': float - Galaxy score (0-100)
            - 'alt_rank': int - AltRank (lower is better)
            - 'social_dominance': float - Social dominance percentage
        """
        if not self.api_key:
            self.logger.error("LUNARCRUSH_API_KEY not configured")
            return {}
        
        # Check cache first
        cache_key = symbol.upper()
        if cache_key in self._social_metrics_cache:
            data, timestamp = self._social_metrics_cache[cache_key]
            if time.time() - timestamp < self.SOCIAL_METRICS_TTL:
                self.logger.debug(f"Returning cached social metrics for {symbol}")
                return data
        
        try:
            # Enforce rate limiting
            self._rate_limit()
            # LunarCrush API v4 endpoint for coin data
            # Endpoint: /public/coins/:coin/v1
            url = f"{self.BASE_URL}/public/coins/{symbol.upper()}/v1"
            
            params = {}
            # LunarCrush API v4 uses Bearer token authentication
            headers = {}
            if self.api_key:
                headers['Authorization'] = f'Bearer {self.api_key}'
            
            self.logger.info(f"Fetching social metrics for {symbol} from LunarCrush API v4...")
            response = requests.get(url, params=params, headers=headers, timeout=30)
            response.raise_for_status()
            
            data = response.json()
            
            # Parse API v4 response format
            metrics = {}
            
            if isinstance(data, dict):
                # API v4 response structure: {'config': {...}, 'data': {...}}
                coin_data = data.get('data', data)
                
                # Handle case where data might be a list with one item
                if isinstance(coin_data, list) and len(coin_data) > 0:
                    coin_data = coin_data[0]
                
                # Extract metrics from API v4 response
                metrics = {
                    'social_volume': coin_data.get('social_volume_24h', coin_data.get('interactions_24h', coin_data.get('social_mentions', coin_data.get('social_volume', 0)))),
                    'social_score': float(coin_data.get('sentiment', coin_data.get('sentiment_score', coin_data.get('social_score', 0)))),
                    'galaxy_score': float(coin_data.get('galaxy_score', coin_data.get('score', coin_data.get('galaxy', 0)))),
                    'alt_rank': int(coin_data.get('alt_rank', coin_data.get('altrank', coin_data.get('rank', 999999)))),
                    'social_dominance': float(coin_data.get('social_dominance', coin_data.get('social_dominance_24h', coin_data.get('dominance', 0)))),
                    'price_change_24h': float(coin_data.get('percent_change_24h', coin_data.get('price_change_24h', coin_data.get('change_24h', coin_data.get('price_change', 0))))),
                    'volume_24h': float(coin_data.get('volume_24h', coin_data.get('volume_24h_usd', coin_data.get('volume', 0)))),
                    'interactions_24h': coin_data.get('interactions_24h', 0),
                    'market_cap': float(coin_data.get('market_cap', 0)),
                    'price': float(coin_data.get('price', coin_data.get('price_usd', 0))),
                }
            
            self.logger.info(f"Fetched social metrics for {symbol}")
            
            # Cache the result
            self._social_metrics_cache[cache_key] = (metrics, time.time())
            
            # Cleanup old cache entries periodically
            if len(self._social_metrics_cache) > 50:  # Cleanup if cache gets too large
                self._cleanup_cache()
            
            return metrics
            
        except requests.exceptions.HTTPError as e:
            if hasattr(e, 'response') and e.response is not None:
                if e.response.status_code == 429:
                    self.logger.warning(f"LunarCrush rate limit exceeded for {symbol}. Using cached data if available.")
                    # Try to return cached data even if expired
                    if cache_key in self._social_metrics_cache:
                        data, _ = self._social_metrics_cache[cache_key]
                        self.logger.info(f"Returning expired cache for {symbol} due to rate limit")
                        return data
                    return {}
            self.logger.error(f"Error fetching social metrics from LunarCrush: {str(e)}")
            if hasattr(e, 'response') and e.response is not None:
                self.logger.error(f"Response status: {e.response.status_code}")
                self.logger.error(f"Response body: {e.response.text[:500]}")
            return {}
        except requests.exceptions.RequestException as e:
            self.logger.error(f"Error fetching social metrics from LunarCrush: {str(e)}")
            if hasattr(e, 'response') and e.response is not None:
                self.logger.error(f"Response status: {e.response.status_code}")
                self.logger.error(f"Response body: {e.response.text[:500]}")
            return {}
        except Exception as e:
            self.logger.error(f"Unexpected error fetching social metrics: {str(e)}", exc_info=True)
            return {}
    
    def _parse_date(self, date_str: str) -> Optional[datetime]:
        """
        Parse date string to datetime object.
        
        Args:
            date_str: Date string in various formats
        
        Returns:
            datetime object or None if parsing fails
        """
        if not date_str:
            return None
        
        # Try common date formats
        date_formats = [
            '%Y-%m-%d %H:%M:%S',
            '%Y-%m-%dT%H:%M:%S',
            '%Y-%m-%dT%H:%M:%SZ',
            '%Y-%m-%d',
            '%m/%d/%Y',
            '%d/%m/%Y'
        ]
        
        for fmt in date_formats:
            try:
                return datetime.strptime(date_str, fmt)
            except ValueError:
                continue
        
        # Try parsing ISO format with timezone
        try:
            from dateutil import parser
            return parser.parse(date_str)
        except (ImportError, ValueError):
            pass
        
        # Try Unix timestamp
        try:
            timestamp = int(date_str)
            return datetime.fromtimestamp(timestamp)
        except (ValueError, TypeError):
            pass
        
        self.logger.warning(f"Could not parse date: {date_str}")
        return None

