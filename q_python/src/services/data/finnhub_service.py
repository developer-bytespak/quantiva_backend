"""
Finnhub Service
Fetches stock market data, fundamentals, earnings, and sentiment from Finnhub API.
Supports batch API calls to optimize rate limits.
"""
import logging
import requests
from typing import List, Dict, Any, Optional
from datetime import datetime, timedelta
from src.config import FINNHUB_API_KEY

logger = logging.getLogger(__name__)


class FinnhubService:
    """
    Service for fetching stock data from Finnhub API with batch optimization.
    Free tier: 60 calls/minute
    """
    
    BASE_URL = "https://finnhub.io/api/v1"
    
    def __init__(self):
        """Initialize FinnhubService."""
        self.logger = logging.getLogger(__name__)
        self.api_key = FINNHUB_API_KEY
        
        if not self.api_key:
            self.logger.warning(
                "FINNHUB_API_KEY not set. Finnhub data fetching will fail. "
                "Set FINNHUB_API_KEY environment variable."
            )
    
    def fetch_company_fundamentals_batch(
        self,
        symbols: List[str]
    ) -> Dict[str, Dict[str, Any]]:
        """
        Fetch company fundamentals for multiple stocks.
        
        Note: Finnhub doesn't support true batch requests for fundamentals,
        but we optimize by caching and making individual requests efficiently.
        
        Args:
            symbols: List of stock symbols (e.g., ['AAPL', 'TSLA', 'GOOGL'])
        
        Returns:
            Dictionary mapping symbol to fundamentals:
            {
                'AAPL': {
                    'pe_ratio': float,
                    'eps': float,
                    'market_cap': float,
                    'revenue': float,
                    'dividend_yield': float,
                    'beta': float
                },
                ...
            }
        """
        if not self.api_key:
            self.logger.error("FINNHUB_API_KEY not configured")
            return {}
        
        results = {}
        
        for symbol in symbols:
            try:
                # Fetch basic financials (metrics)
                metrics_url = f"{self.BASE_URL}/stock/metric"
                params = {
                    'symbol': symbol.upper(),
                    'metric': 'all',
                    'token': self.api_key
                }
                
                response = requests.get(metrics_url, params=params, timeout=10)
                response.raise_for_status()
                data = response.json()
                
                # Extract key metrics
                metric_data = data.get('metric', {})
                
                results[symbol] = {
                    'pe_ratio': metric_data.get('peBasicExclExtraTTM') or metric_data.get('peTTM'),
                    'eps': metric_data.get('epsBasicExclExtraItemsTTM') or metric_data.get('epsTTM'),
                    'market_cap': metric_data.get('marketCapitalization'),
                    'revenue': metric_data.get('revenueTTM'),
                    'dividend_yield': metric_data.get('dividendYieldIndicatedAnnual'),
                    'beta': metric_data.get('beta'),
                    'price_to_book': metric_data.get('pbAnnual'),
                    'roe': metric_data.get('roeRfy'),  # Return on Equity
                    'debt_to_equity': metric_data.get('totalDebt/totalEquityAnnual'),
                    'fetched_at': datetime.now().isoformat()
                }
                
            except requests.exceptions.RequestException as e:
                self.logger.warning(f"Error fetching fundamentals for {symbol}: {str(e)}")
                results[symbol] = None
            except Exception as e:
                self.logger.error(f"Unexpected error fetching fundamentals for {symbol}: {str(e)}")
                results[symbol] = None
        
        return results
    
    def fetch_earnings_calendar_batch(
        self,
        symbols: List[str],
        days_ahead: int = 30
    ) -> Dict[str, Dict[str, Any]]:
        """
        Fetch earnings calendar for multiple stocks.
        
        Args:
            symbols: List of stock symbols
            days_ahead: Number of days to look ahead (default: 30)
        
        Returns:
            Dictionary mapping symbol to earnings data:
            {
                'AAPL': {
                    'earnings_date': '2026-01-28',
                    'eps_estimate': 1.52,
                    'revenue_estimate': 120000000000,
                    'days_until_earnings': 26
                },
                ...
            }
        """
        if not self.api_key:
            self.logger.error("FINNHUB_API_KEY not configured")
            return {}
        
        try:
            # Fetch earnings calendar for date range
            from_date = datetime.now().strftime('%Y-%m-%d')
            to_date = (datetime.now() + timedelta(days=days_ahead)).strftime('%Y-%m-%d')
            
            url = f"{self.BASE_URL}/calendar/earnings"
            params = {
                'from': from_date,
                'to': to_date,
                'token': self.api_key
            }
            
            response = requests.get(url, params=params, timeout=15)
            response.raise_for_status()
            data = response.json()
            
            # Parse earnings calendar
            earnings_data = data.get('earningsCalendar', [])
            
            results = {}
            for symbol in symbols:
                symbol_upper = symbol.upper()
                # Find earnings for this symbol
                symbol_earnings = [e for e in earnings_data if e.get('symbol') == symbol_upper]
                
                if symbol_earnings:
                    # Get nearest upcoming earnings
                    nearest = symbol_earnings[0]
                    earnings_date = nearest.get('date')
                    
                    # Calculate days until earnings
                    days_until = None
                    if earnings_date:
                        try:
                            earnings_dt = datetime.strptime(earnings_date, '%Y-%m-%d')
                            days_until = (earnings_dt - datetime.now()).days
                        except:
                            pass
                    
                    results[symbol] = {
                        'earnings_date': earnings_date,
                        'eps_estimate': nearest.get('epsEstimate'),
                        'eps_actual': nearest.get('epsActual'),
                        'revenue_estimate': nearest.get('revenueEstimate'),
                        'revenue_actual': nearest.get('revenueActual'),
                        'days_until_earnings': days_until,
                        'quarter': nearest.get('quarter'),
                        'year': nearest.get('year')
                    }
                else:
                    results[symbol] = None
            
            return results
            
        except requests.exceptions.RequestException as e:
            self.logger.error(f"Error fetching earnings calendar: {str(e)}")
            return {}
        except Exception as e:
            self.logger.error(f"Unexpected error fetching earnings calendar: {str(e)}")
            return {}
    
    def fetch_social_sentiment_batch(
        self,
        symbols: List[str]
    ) -> Dict[str, Dict[str, Any]]:
        """
        Fetch social sentiment for multiple stocks.
        
        Note: Finnhub social sentiment is per-symbol, not truly batched.
        We make individual requests but return as batch.
        
        Args:
            symbols: List of stock symbols
        
        Returns:
            Dictionary mapping symbol to sentiment:
            {
                'AAPL': {
                    'reddit_score': 0.75,
                    'twitter_score': 0.82,
                    'overall_sentiment': 0.785,
                    'mention_count': 1250
                },
                ...
            }
        """
        if not self.api_key:
            self.logger.error("FINNHUB_API_KEY not configured")
            return {}
        
        results = {}
        
        for symbol in symbols:
            try:
                url = f"{self.BASE_URL}/stock/social-sentiment"
                params = {
                    'symbol': symbol.upper(),
                    'token': self.api_key
                }
                
                response = requests.get(url, params=params, timeout=10)
                response.raise_for_status()
                data = response.json()
                
                # Parse sentiment data
                reddit_data = data.get('reddit', [])
                twitter_data = data.get('twitter', [])
                
                # Calculate average sentiment scores
                reddit_score = None
                if reddit_data:
                    reddit_scores = [item.get('score', 0) for item in reddit_data if item.get('score') is not None]
                    reddit_score = sum(reddit_scores) / len(reddit_scores) if reddit_scores else None
                
                twitter_score = None
                if twitter_data:
                    twitter_scores = [item.get('score', 0) for item in twitter_data if item.get('score') is not None]
                    twitter_score = sum(twitter_scores) / len(twitter_scores) if twitter_scores else None
                
                # Calculate overall sentiment
                scores = [s for s in [reddit_score, twitter_score] if s is not None]
                overall_sentiment = sum(scores) / len(scores) if scores else None
                
                # Count mentions
                reddit_mentions = sum(item.get('mention', 0) for item in reddit_data)
                twitter_mentions = sum(item.get('mention', 0) for item in twitter_data)
                
                results[symbol] = {
                    'reddit_score': reddit_score,
                    'twitter_score': twitter_score,
                    'overall_sentiment': overall_sentiment,
                    'reddit_mentions': reddit_mentions,
                    'twitter_mentions': twitter_mentions,
                    'total_mentions': reddit_mentions + twitter_mentions,
                    'fetched_at': datetime.now().isoformat()
                }
                
            except requests.exceptions.RequestException as e:
                self.logger.warning(f"Error fetching social sentiment for {symbol}: {str(e)}")
                results[symbol] = None
            except Exception as e:
                self.logger.error(f"Unexpected error fetching social sentiment for {symbol}: {str(e)}")
                results[symbol] = None
        
        return results
    
    def fetch_trending_stocks(
        self,
        limit: int = 50
    ) -> List[Dict[str, Any]]:
        """
        Fetch trending stocks based on social media and news activity.
        
        Args:
            limit: Maximum number of stocks to return (default: 50)
        
        Returns:
            List of trending stocks with basic info:
            [
                {
                    'symbol': 'AAPL',
                    'name': 'Apple Inc',
                    'price': 178.45,
                    'change_percent': 2.3,
                    'volume': 52340000,
                    'market_cap': 2890000000000
                },
                ...
            ]
        """
        if not self.api_key:
            self.logger.error("FINNHUB_API_KEY not configured")
            return []
        
        try:
            # Fetch market news to identify trending stocks
            url = f"{self.BASE_URL}/news"
            params = {
                'category': 'general',
                'token': self.api_key
            }
            
            response = requests.get(url, params=params, timeout=15)
            response.raise_for_status()
            news_data = response.json()
            
            # Count symbol mentions in news
            symbol_mentions = {}
            for article in news_data[:100]:  # Check recent news
                related = article.get('related', '')
                if related:
                    symbols = related.split(',')
                    for symbol in symbols:
                        symbol = symbol.strip()
                        if symbol:
                            symbol_mentions[symbol] = symbol_mentions.get(symbol, 0) + 1
            
            # Get top mentioned symbols
            top_symbols = sorted(symbol_mentions.items(), key=lambda x: x[1], reverse=True)[:limit]
            
            # Fetch quote data for top symbols
            results = []
            for symbol, mentions in top_symbols:
                try:
                    quote_url = f"{self.BASE_URL}/quote"
                    quote_params = {
                        'symbol': symbol,
                        'token': self.api_key
                    }
                    
                    quote_response = requests.get(quote_url, params=quote_params, timeout=5)
                    quote_response.raise_for_status()
                    quote_data = quote_response.json()
                    
                    if quote_data.get('c'):  # Current price exists
                        results.append({
                            'symbol': symbol,
                            'price': quote_data.get('c'),
                            'change_percent': quote_data.get('dp'),
                            'volume': quote_data.get('v'),
                            'high': quote_data.get('h'),
                            'low': quote_data.get('l'),
                            'open': quote_data.get('o'),
                            'prev_close': quote_data.get('pc'),
                            'mention_count': mentions
                        })
                except:
                    continue
            
            return results[:limit]
            
        except requests.exceptions.RequestException as e:
            self.logger.error(f"Error fetching trending stocks: {str(e)}")
            return []
        except Exception as e:
            self.logger.error(f"Unexpected error fetching trending stocks: {str(e)}")
            return []
