"""
LunarCrush Service
Fetches cryptocurrency news and social metrics from LunarCrush API.
"""
import logging
import requests
from typing import List, Dict, Any, Optional
from datetime import datetime
from src.config import LUNARCRUSH_API_KEY

logger = logging.getLogger(__name__)


class LunarCrushService:
    """
    Service for fetching cryptocurrency news and social metrics from LunarCrush API.
    """
    
    BASE_URL = "https://lunarcrush.com/api3"
    
    def __init__(self):
        """Initialize LunarCrushService."""
        self.logger = logging.getLogger(__name__)
        self.api_key = LUNARCRUSH_API_KEY
        
        if not self.api_key:
            self.logger.warning(
                "LUNARCRUSH_API_KEY not set. LunarCrush fetching will fail. "
                "Set LUNARCRUSH_API_KEY environment variable."
            )
    
    def fetch_coin_news(
        self,
        symbol: str,
        limit: int = 50
    ) -> List[Dict[str, Any]]:
        """
        Fetch news for a cryptocurrency symbol.
        
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
        
        try:
            # LunarCrush API endpoint for news
            # Try v3 API format first, fallback to v2 if needed
            url = f"{self.BASE_URL}/news"
            
            params = {
                'key': self.api_key,
                'symbol': symbol.upper(),
                'limit': limit
            }
            
            self.logger.info(f"Fetching news for {symbol} from LunarCrush...")
            response = requests.get(url, params=params, timeout=30)
            response.raise_for_status()
            
            data = response.json()
            
            # Parse response (adjust based on actual API response format)
            news_items = []
            
            # LunarCrush v2 API response format - data is typically in 'data' field
            # Response can be: {'data': [...]} or {'data': {'feeds': [...]}} or direct list
            if isinstance(data, dict):
                # Try different possible response structures
                if 'data' in data:
                    data_content = data['data']
                    if isinstance(data_content, list):
                        articles = data_content
                    elif isinstance(data_content, dict):
                        # Could be {'feeds': [...]} or {'news': [...]}
                        articles = data_content.get('feeds', data_content.get('news', data_content.get('results', [])))
                    else:
                        articles = []
                else:
                    articles = data.get('news', data.get('results', data.get('feeds', [])))
            elif isinstance(data, list):
                articles = data
            else:
                self.logger.warning(f"Unexpected response format from LunarCrush: {type(data)}")
                self.logger.debug(f"Response data: {str(data)[:500]}")
                articles = []
            
            for article in articles[:limit]:
                try:
                    # Parse article fields (adjust field names based on actual API)
                    title = article.get('title', article.get('headline', ''))
                    text = article.get('text', article.get('description', article.get('summary', article.get('content', ''))))
                    source = article.get('source', article.get('source_name', article.get('site', 'unknown')))
                    url = article.get('url', article.get('link', ''))
                    
                    # Parse date
                    date_str = article.get('date', article.get('published_at', article.get('published_date', article.get('time', ''))))
                    published_at = self._parse_date(date_str)
                    
                    if title or text:
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
            return news_items
            
        except requests.exceptions.RequestException as e:
            self.logger.error(f"Error fetching news from LunarCrush: {str(e)}")
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
        
        try:
            # LunarCrush API endpoint for coin data
            # Try v3 API format first, fallback to v2 if needed
            url = f"{self.BASE_URL}/coins"
            
            params = {
                'key': self.api_key,
                'symbol': symbol.upper(),
                'data_points': 1  # Get latest data point
            }
            
            self.logger.info(f"Fetching social metrics for {symbol} from LunarCrush...")
            response = requests.get(url, params=params, timeout=30)
            response.raise_for_status()
            
            data = response.json()
            
            # Parse response (adjust based on actual API response format)
            metrics = {}
            
            # LunarCrush v2 API response format for assets
            if isinstance(data, dict):
                coin_data = data.get('data', data.get('coins', []))
                if isinstance(coin_data, list) and len(coin_data) > 0:
                    coin_data = coin_data[0]
                elif not isinstance(coin_data, dict):
                    # If data is not a dict or list, try to get it directly
                    coin_data = data
                
                # Extract metrics (adjust field names based on actual API)
                # LunarCrush v2 API field names may vary
                metrics = {
                    'social_volume': coin_data.get('social_volume', coin_data.get('social_mentions', coin_data.get('social_volume_24h', 0))),
                    'social_score': float(coin_data.get('social_score', coin_data.get('sentiment', coin_data.get('sentiment_score', 0)))),
                    'galaxy_score': float(coin_data.get('galaxy_score', coin_data.get('score', coin_data.get('galaxy', 0)))),
                    'alt_rank': int(coin_data.get('alt_rank', coin_data.get('rank', coin_data.get('altrank', 999999)))),
                    'social_dominance': float(coin_data.get('social_dominance', coin_data.get('dominance', coin_data.get('social_dominance_24h', 0)))),
                    'price_change_24h': float(coin_data.get('price_change_24h', coin_data.get('change_24h', coin_data.get('price_change', 0)))),
                    'volume_24h': float(coin_data.get('volume_24h', coin_data.get('volume', coin_data.get('volume_24h_usd', 0))))
                }
            
            self.logger.info(f"Fetched social metrics for {symbol}")
            return metrics
            
        except requests.exceptions.RequestException as e:
            self.logger.error(f"Error fetching social metrics from LunarCrush: {str(e)}")
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

