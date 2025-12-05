"""
Stock News Service
Fetches stock market news from StockNewsAPI.
"""
import logging
import requests
from typing import List, Dict, Any, Optional
from datetime import datetime
from src.config import STOCK_NEWS_API_KEY

logger = logging.getLogger(__name__)


class StockNewsService:
    """
    Service for fetching stock market news from StockNewsAPI.
    """
    
    BASE_URL = "https://stocknewsapi.com/api/v1"
    
    def __init__(self):
        """Initialize StockNewsService."""
        self.logger = logging.getLogger(__name__)
        self.api_key = STOCK_NEWS_API_KEY
        
        if not self.api_key:
            self.logger.warning(
                "STOCK_NEWS_API_KEY not set. Stock news fetching will fail. "
                "Set STOCK_NEWS_API_KEY environment variable."
            )
    
    def fetch_news(
        self,
        symbol: str,
        limit: int = 50,
        items: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        Fetch news for a stock symbol.
        
        Args:
            symbol: Stock symbol (e.g., 'AAPL', 'TSLA')
            limit: Maximum number of news items to fetch (default: 50)
            items: Type of news items ('news', 'tweets', 'all') - default: 'news'
        
        Returns:
            List of news dictionaries with:
            - 'title': str - News headline
            - 'text': str - News content/description
            - 'source': str - News source
            - 'published_at': datetime - Publication timestamp
            - 'url': str - News article URL
        """
        if not self.api_key:
            self.logger.error("STOCK_NEWS_API_KEY not configured")
            return []
        
        try:
            # StockNewsAPI endpoint - using query parameters format
            url = self.BASE_URL
            
            params = {
                'tickers': symbol.upper(),
                'items': str(limit) if limit else (items or '10'),
                'token': self.api_key
            }
            
            # Note: StockNewsAPI uses 'items' parameter for limit, not 'page'
            
            self.logger.info(f"Fetching news for {symbol} from StockNewsAPI...")
            response = requests.get(url, params=params, timeout=30)
            response.raise_for_status()
            
            data = response.json()
            
            # Parse response (adjust based on actual API response format)
            news_items = []
            
            # StockNewsAPI response format - typically returns data directly or in 'data' field
            if isinstance(data, dict):
                # Check for different possible response structures
                articles = data.get('data', data.get('news', data.get('results', data.get('articles', []))))
                # If still empty, check if the dict itself contains article-like fields
                if not articles and any(key in data for key in ['title', 'headline', 'text']):
                    # Single article response
                    articles = [data]
            elif isinstance(data, list):
                articles = data
            else:
                self.logger.warning(f"Unexpected response format from StockNewsAPI: {type(data)}")
                self.logger.debug(f"Response data: {str(data)[:500]}")
                articles = []
            
            for article in articles[:limit]:
                try:
                    # Parse article fields (adjust field names based on actual API)
                    title = article.get('title', article.get('headline', ''))
                    text = article.get('text', article.get('description', article.get('summary', '')))
                    source = article.get('source', article.get('source_name', 'unknown'))
                    url = article.get('url', article.get('link', ''))
                    
                    # Parse date
                    date_str = article.get('date', article.get('published_at', article.get('published_date', '')))
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
            self.logger.error(f"Error fetching news from StockNewsAPI: {str(e)}")
            return []
        except Exception as e:
            self.logger.error(f"Unexpected error fetching news: {str(e)}", exc_info=True)
            return []
    
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
        
        self.logger.warning(f"Could not parse date: {date_str}")
        return None
    
    def fetch_company_news(self, symbol: str, limit: int = 50) -> List[Dict[str, Any]]:
        """
        Fetch company-specific news (alias for fetch_news).
        
        Args:
            symbol: Stock symbol
            limit: Maximum number of news items
        
        Returns:
            List of news dictionaries
        """
        return self.fetch_news(symbol, limit=limit, items='news')

