"""
Event Risk Engine
Analyzes upcoming events that could impact asset prices.
Detects events by parsing news articles from StockNewsAPI and LunarCrush.
"""
from typing import Dict, Any, Optional, List
from datetime import datetime, timedelta
import logging
import re

from .base_engine import BaseEngine
from src.services.data.stock_news_service import StockNewsService
from src.services.data.lunarcrush_service import LunarCrushService
from src.services.macro.fred_service import FredService

logger = logging.getLogger(__name__)


class EventRiskEngine(BaseEngine):
    """
    Event risk analysis engine.
    
    Monitors:
    - Upcoming earnings (stocks)
    - Token unlocks (crypto)
    - SEC/FOMC announcements
    - Hard forks
    - Exchange listings
    - Regulatory news
    """
    
    def __init__(self):
        super().__init__("EventRiskEngine")
        self.stock_news_service = StockNewsService()
        self.lunarcrush_service = LunarCrushService()
        self.fred_service = FredService()
        self.event_impacts = {
            # Positive events
            'exchange_listing': 0.8,
            'partnership': 0.6,
            'protocol_upgrade': 0.5,
            'positive_earnings': 0.7,
            
            # Negative events
            'token_unlock_large': -0.9,  # >5% supply
            'token_unlock_medium': -0.6,  # 1-5% supply
            'token_unlock_small': -0.3,   # <1% supply
            'regulatory_action': -0.8,
            'sec_investigation': -0.9,
            'hard_fork_risky': -0.5,
            'negative_earnings': -0.6,
            
            # Neutral/Mixed
            'earnings': 0.0,  # Depends on expectations
            'fomc_meeting': -0.2,  # Slight negative (uncertainty)
            'economic_release': 0.0,  # Depends on data
            
            # FRED-based economic events (from numeric value changes)
            'fed_rate_hike': -0.7,  # Negative for stocks
            'fed_rate_cut': 0.5,  # Positive for stocks
            'inflation_spike': -0.4,  # Negative
            'inflation_decrease': 0.2,  # Positive
            'yield_curve_inversion': -0.5,  # Bearish signal
        }
    
    def calculate(
        self,
        asset_id: str,
        asset_type: str,
        timeframe: Optional[str] = None,
        events: Optional[List[Dict]] = None,
        stored_fred_data: Optional[Dict[str, Any]] = None,
        **kwargs
    ) -> Dict[str, Any]:
        """
        Calculate event risk score.
        
        Args:
            asset_id: Asset identifier
            asset_type: 'crypto' or 'stock'
            timeframe: Optional timeframe
            events: Optional list of events (if not provided, will fetch)
            stored_fred_data: Previous FRED data from DB (optional)
            **kwargs: Additional parameters
        
        Returns:
            Dictionary with score, confidence, and metadata
        """
        try:
            if not self.validate_inputs(asset_id, asset_type):
                return self.handle_error(ValueError("Invalid inputs"), "validation")
            
            # Get upcoming events
            if events is None:
                events = self._get_upcoming_events(asset_id, asset_type, days_ahead=30)
            
            # Get economic risk from FRED (for stocks only)
            economic_risk = None
            if asset_type == 'stock' and self.fred_service.is_available():
                economic_risk = self._get_economic_risk_from_fred(stored_fred_data)
                
                # Add FRED-based events to events list
                events.extend(economic_risk.get('events', []))
                
                # Log FRED events
                if economic_risk.get('events'):
                    self.logger.info(
                        f"FRED economic events for {asset_id}: {len(economic_risk.get('events', []))} events, "
                        f"overall_risk={economic_risk.get('risk_score', 0.0):.3f}"
                    )
            
            if not events:
                # No events = low risk
                return self.create_result(
                    1.0,  # Low risk
                    0.8,  # High confidence if no events
                    {'events_count': 0, 'note': 'No upcoming events detected'}
                )
            
            # Score each event
            event_scores = []
            for event in events:
                score = self._score_event(event)
                if score != 0:  # Only include events with impact
                    event_scores.append({
                        'event': event,
                        'score': score
                    })
            
            if not event_scores:
                return self.create_result(
                    1.0,
                    0.8,
                    {'events_count': len(events), 'scored_events': 0}
                )
            
            # Aggregate scores (negative events have more weight)
            positive_scores = [e['score'] for e in event_scores if e['score'] > 0]
            negative_scores = [e['score'] for e in event_scores if e['score'] < 0]
            
            # Weight negative events more heavily (risk is asymmetric)
            positive_sum = sum(positive_scores) * 0.5  # Reduce positive impact
            negative_sum = sum(negative_scores) * 1.5  # Amplify negative impact
            
            total_score = positive_sum + negative_sum
            
            # Normalize to -1 to +1 range
            event_risk_score = self.clamp_score(total_score)
            
            # Calculate confidence
            confidence = self._calculate_confidence(events, event_scores)
            
            metadata = {
                'events_count': len(events),
                'scored_events': len(event_scores),
                'positive_events': len(positive_scores),
                'negative_events': len(negative_scores),
                'event_details': [
                    {
                        'type': e['event'].get('type', 'unknown'),
                        'date': e['event'].get('date', ''),
                        'score': e['score']
                    }
                    for e in event_scores[:10]  # Top 10 events
                ]
            }
            
            # Add FRED economic risk info if available
            if economic_risk and economic_risk.get('events'):
                metadata['fred_economic_risk'] = economic_risk.get('risk_score', 0.0)
                metadata['fred_events_count'] = len(economic_risk.get('events', []))
                metadata['fred_events'] = [
                    {
                        'type': e.get('type', 'unknown'),
                        'date': e.get('date', ''),
                        'description': e.get('description', '')
                    }
                    for e in economic_risk.get('events', [])[:5]
                ]
            
            return self.create_result(event_risk_score, confidence, metadata)
            
        except Exception as e:
            return self.handle_error(e, f"calculation for {asset_id}")
    
    def _extract_date_from_text(self, text: str, article_date: Optional[datetime]) -> Optional[datetime]:
        """
        Extract date from news article text.
        
        Looks for patterns like:
        - "on January 15, 2025"
        - "on 01/15/2025" or "on 2025-01-15"
        - "scheduled for [date]"
        - "announced for [date]"
        
        Args:
            text: News article text
            article_date: Publication date of the article
        
        Returns:
            Extracted date or None
        """
        if not text:
            return None
        
        text_lower = text.lower()
        
        # Pattern 1: "on [date]" or "scheduled for [date]"
        date_patterns = [
            r'(?:on|for|scheduled\s+for|announced\s+for|set\s+for)\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})',  # "on January 15, 2025"
            r'(?:on|for|scheduled\s+for|announced\s+for|set\s+for)\s+(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})',  # "on 01/15/2025"
            r'(?:on|for|scheduled\s+for|announced\s+for|set\s+for)\s+(\d{4}-\d{2}-\d{2})',  # "on 2025-01-15"
            r'([A-Za-z]+\s+\d{1,2},?\s+\d{4})',  # Just date "January 15, 2025"
            r'(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})',  # Just date "01/15/2025"
        ]
        
        for pattern in date_patterns:
            match = re.search(pattern, text_lower, re.IGNORECASE)
            if match:
                date_str = match.group(1).strip()
                try:
                    parsed_date = self._parse_date_string(date_str)
                    if parsed_date:
                        # Make timezone-naive
                        if parsed_date.tzinfo is not None:
                            parsed_date = parsed_date.replace(tzinfo=None)
                        if parsed_date > datetime.now().replace(tzinfo=None):
                            return parsed_date
                except Exception:
                    continue
        
        # Pattern 2: Relative dates
        if any(phrase in text_lower for phrase in ['upcoming', 'next week', 'next month']):
            if article_date:
                if 'next week' in text_lower:
                    return article_date + timedelta(days=7)
                elif 'next month' in text_lower:
                    return article_date + timedelta(days=30)
                elif 'upcoming' in text_lower:
                    # Estimate 7-30 days from article date
                    now = datetime.now().replace(tzinfo=None)
                    if article_date.tzinfo is not None:
                        article_date = article_date.replace(tzinfo=None)
                    days_since_article = (now - article_date).days
                    if days_since_article <= 7:
                        return article_date + timedelta(days=14)  # Middle of range
        
        return None
    
    def _parse_date_string(self, date_str: str) -> Optional[datetime]:
        """
        Parse various date string formats.
        
        Args:
            date_str: Date string in various formats
        
        Returns:
            datetime object or None
        """
        if not date_str:
            return None
        
        # Common date formats
        formats = [
            '%B %d, %Y',      # January 15, 2025
            '%b %d, %Y',       # Jan 15, 2025
            '%m/%d/%Y',        # 01/15/2025
            '%m-%d-%Y',        # 01-15-2025
            '%Y-%m-%d',        # 2025-01-15
            '%d/%m/%Y',        # 15/01/2025
            '%m/%d/%y',        # 01/15/25
        ]
        
        for fmt in formats:
            try:
                return datetime.strptime(date_str, fmt)
            except ValueError:
                continue
        
        # Try dateutil parser as fallback
        try:
            from dateutil import parser
            return parser.parse(date_str)
        except (ImportError, ValueError):
            pass
        
        return None
    
    def _detect_earnings_events(
        self,
        news_data: List[Dict[str, Any]],
        cutoff_date: datetime
    ) -> List[Dict]:
        """
        Detect earnings announcement events from stock news.
        
        Args:
            news_data: List of news articles
            cutoff_date: Maximum date to include
        
        Returns:
            List of earnings event dictionaries
        """
        events = []
        earnings_keywords = [
            'earnings report', 'earnings call', 'earnings announcement',
            'q1 earnings', 'q2 earnings', 'q3 earnings', 'q4 earnings',
            'quarterly earnings', 'earnings date', 'earnings release',
            'reports earnings', 'announces earnings', 'earnings results',
            'earnings on', 'earnings scheduled', 'earnings', 'q1', 'q2', 'q3', 'q4',
            'quarterly report', 'financial results', 'revenue report'
        ]
        
        for article in news_data:
            title = article.get('title', '').lower()
            text = article.get('text', '').lower()
            combined = f"{title} {text}"
            published_at = article.get('published_at')
            
            # Handle both datetime objects and strings
            if isinstance(published_at, str):
                try:
                    from dateutil import parser
                    published_at = parser.parse(published_at)
                except Exception:
                    self.logger.warning(f"Could not parse published_at: {published_at}")
                    continue
            
            if not published_at or not isinstance(published_at, datetime):
                continue
            
            # Check if article is about earnings (use word boundaries for better matching)
            # Check for earnings-related content
            has_earnings = any(keyword in combined for keyword in earnings_keywords)
            
            # Also check for financial reporting patterns
            has_financial = any(phrase in combined for phrase in [
                'financial results', 'revenue', 'profit', 'loss', 'eps',
                'beats estimates', 'misses estimates', 'guidance'
            ])
            
            if has_earnings or has_financial:
                # Try to extract earnings date from text
                earnings_date = self._extract_date_from_text(combined, published_at)
                
                # If no date extracted, estimate from article date
                if not earnings_date:
                    # If article mentions "upcoming earnings" and is recent, estimate
                    if any(phrase in combined for phrase in ['upcoming earnings', 'next earnings', 'scheduled earnings']):
                        now = datetime.now().replace(tzinfo=None)
                        if published_at:
                            pub_date = published_at.replace(tzinfo=None) if published_at.tzinfo else published_at
                            days_since_article = (now - pub_date).days
                            if days_since_article <= 7:
                                earnings_date = pub_date + timedelta(days=14)
                
                # Use article date as fallback if still no date
                if not earnings_date:
                    earnings_date = published_at
                
                # Ensure earnings_date is timezone-naive for comparison
                if earnings_date and earnings_date.tzinfo is not None:
                    earnings_date = earnings_date.replace(tzinfo=None)
                
                now = datetime.now().replace(tzinfo=None)
                # Allow events up to 7 days in the past (recent events still relevant)
                # and up to cutoff_date in the future
                if earnings_date and earnings_date <= cutoff_date and earnings_date > (now - timedelta(days=7)):
                    events.append({
                        'type': 'earnings',
                        'date': earnings_date.isoformat(),
                        'description': article.get('title', 'Earnings announcement')[:100],
                        'source': 'stock_news_api'
                    })
        
        return events
    
    def _detect_sec_filings(
        self,
        news_data: List[Dict[str, Any]],
        cutoff_date: datetime
    ) -> List[Dict]:
        """
        Detect SEC filing events from stock news.
        
        Args:
            news_data: List of news articles
            cutoff_date: Maximum date to include
        
        Returns:
            List of SEC filing event dictionaries
        """
        events = []
        sec_keywords = [
            'sec filing', '10-k', '10-q', '8-k', 'form 10',
            'files with sec', 'sec report', 'regulatory filing',
            'quarterly report', 'annual report'
        ]
        
        for article in news_data:
            title = article.get('title', '').lower()
            text = article.get('text', '').lower()
            combined = f"{title} {text}"
            published_at = article.get('published_at')
            
            # Handle both datetime objects and strings
            if isinstance(published_at, str):
                try:
                    from dateutil import parser
                    published_at = parser.parse(published_at)
                except Exception:
                    self.logger.warning(f"Could not parse published_at: {published_at}")
                    continue
            
            if not published_at or not isinstance(published_at, datetime):
                continue
            
            # Check for SEC filing keywords
            if any(keyword in combined for keyword in sec_keywords):
                # Allow recent past events (within 7 days)
                now = datetime.now().replace(tzinfo=None)
                if published_at <= cutoff_date and published_at > (now - timedelta(days=7)):
                    events.append({
                        'type': 'sec_filing',
                        'date': published_at.isoformat(),
                        'description': article.get('title', 'SEC filing')[:100],
                        'source': 'stock_news_api'
                    })
        
        return events
    
    def _detect_regulatory_actions(
        self,
        news_data: List[Dict[str, Any]],
        cutoff_date: datetime
    ) -> List[Dict]:
        """
        Detect regulatory action events from stock news.
        
        Args:
            news_data: List of news articles
            cutoff_date: Maximum date to include
        
        Returns:
            List of regulatory action event dictionaries
        """
        events = []
        regulatory_keywords = [
            'sec investigation', 'sec probe', 'regulatory action',
            'sec charges', 'sec settlement', 'sec fine',
            'sec enforcement', 'sec complaint', 'regulatory scrutiny'
        ]
        
        for article in news_data:
            title = article.get('title', '').lower()
            text = article.get('text', '').lower()
            combined = f"{title} {text}"
            published_at = article.get('published_at')
            
            # Handle both datetime objects and strings
            if isinstance(published_at, str):
                try:
                    from dateutil import parser
                    published_at = parser.parse(published_at)
                except Exception:
                    self.logger.warning(f"Could not parse published_at: {published_at}")
                    continue
            
            if not published_at or not isinstance(published_at, datetime):
                continue
            
            # Check for regulatory keywords
            if any(keyword in combined for keyword in regulatory_keywords):
                if published_at <= cutoff_date:
                    events.append({
                        'type': 'sec_investigation',
                        'date': published_at.isoformat(),
                        'description': article.get('title', 'Regulatory action')[:100],
                        'source': 'stock_news_api'
                    })
        
        return events
    
    def _detect_exchange_listings(
        self,
        news_data: List[Dict[str, Any]],
        cutoff_date: datetime
    ) -> List[Dict]:
        """
        Detect exchange listing events from crypto news.
        
        Args:
            news_data: List of news articles
            cutoff_date: Maximum date to include
        
        Returns:
            List of exchange listing event dictionaries
        """
        events = []
        listing_keywords = [
            'listed on', 'listing on', 'exchange listing',
            'binance listing', 'coinbase listing', 'new exchange',
            'gets listed', 'will list', 'to be listed'
        ]
        
        exchanges = ['binance', 'coinbase', 'kraken', 'ftx', 'okx', 'bybit', 'huobi']
        
        for article in news_data:
            title = article.get('title', '').lower()
            text = article.get('text', '').lower()
            combined = f"{title} {text}"
            published_at = article.get('published_at')
            
            # Handle both datetime objects and strings
            if isinstance(published_at, str):
                try:
                    from dateutil import parser
                    published_at = parser.parse(published_at)
                except Exception:
                    self.logger.warning(f"Could not parse published_at: {published_at}")
                    continue
            
            if not published_at or not isinstance(published_at, datetime):
                continue
            
            # Check for listing keywords
            if any(keyword in combined for keyword in listing_keywords):
                # Extract exchange name if mentioned
                exchange_name = None
                for exchange in exchanges:
                    if exchange in combined:
                        exchange_name = exchange.capitalize()
                        break
                
                listing_date = self._extract_date_from_text(combined, published_at)
                if not listing_date:
                    listing_date = published_at
                
                if listing_date <= cutoff_date:
                    description = f"Listing on {exchange_name}" if exchange_name else "Exchange listing"
                    events.append({
                        'type': 'exchange_listing',
                        'date': listing_date.isoformat(),
                        'description': description[:100],
                        'source': 'lunarcrush'
                    })
        
        return events
    
    def _detect_forks_upgrades(
        self,
        news_data: List[Dict[str, Any]],
        cutoff_date: datetime
    ) -> List[Dict]:
        """
        Detect hard fork and protocol upgrade events from crypto news.
        
        Args:
            news_data: List of news articles
            cutoff_date: Maximum date to include
        
        Returns:
            List of fork/upgrade event dictionaries
        """
        events = []
        fork_keywords = [
            'hard fork', 'protocol upgrade', 'network upgrade',
            'mainnet upgrade', 'consensus upgrade', 'fork scheduled'
        ]
        
        risky_keywords = ['controversial fork', 'contentious fork', 'fork split']
        upgrade_keywords = ['upgrade', 'improvement', 'enhancement']
        
        for article in news_data:
            title = article.get('title', '').lower()
            text = article.get('text', '').lower()
            combined = f"{title} {text}"
            published_at = article.get('published_at')
            
            # Handle both datetime objects and strings
            if isinstance(published_at, str):
                try:
                    from dateutil import parser
                    published_at = parser.parse(published_at)
                except Exception:
                    self.logger.warning(f"Could not parse published_at: {published_at}")
                    continue
            
            if not published_at or not isinstance(published_at, datetime):
                continue
            
            # Check for fork/upgrade keywords
            if any(keyword in combined for keyword in fork_keywords):
                # Determine if risky fork or positive upgrade
                event_type = 'hard_fork_risky' if any(keyword in combined for keyword in risky_keywords) else 'protocol_upgrade'
                
                fork_date = self._extract_date_from_text(combined, published_at)
                if not fork_date:
                    fork_date = published_at
                
                # Ensure fork_date is timezone-naive
                if fork_date.tzinfo is not None:
                    fork_date = fork_date.replace(tzinfo=None)
                
                # Allow recent past events (within 7 days)
                now = datetime.now().replace(tzinfo=None)
                if fork_date <= cutoff_date and fork_date > (now - timedelta(days=7)):
                    events.append({
                        'type': event_type,
                        'date': fork_date.isoformat(),
                        'description': article.get('title', 'Network upgrade')[:100],
                        'source': 'lunarcrush'
                    })
        
        return events
    
    def _detect_partnerships(
        self,
        news_data: List[Dict[str, Any]],
        cutoff_date: datetime
    ) -> List[Dict]:
        """
        Detect partnership events from crypto news.
        
        Args:
            news_data: List of news articles
            cutoff_date: Maximum date to include
        
        Returns:
            List of partnership event dictionaries
        """
        events = []
        partnership_keywords = [
            'partnership', 'strategic partnership', 'collaboration',
            'integration', 'adoption by', 'partners with'
        ]
        
        for article in news_data:
            title = article.get('title', '').lower()
            text = article.get('text', '').lower()
            combined = f"{title} {text}"
            published_at = article.get('published_at')
            
            # Handle both datetime objects and strings
            if isinstance(published_at, str):
                try:
                    from dateutil import parser
                    published_at = parser.parse(published_at)
                except Exception:
                    self.logger.warning(f"Could not parse published_at: {published_at}")
                    continue
            
            if not published_at or not isinstance(published_at, datetime):
                continue
            
            # Check for partnership keywords
            if any(keyword in combined for keyword in partnership_keywords):
                # Allow recent past events (within 7 days)
                now = datetime.now().replace(tzinfo=None)
                pub_date_naive = published_at.replace(tzinfo=None) if published_at.tzinfo else published_at
                if pub_date_naive <= cutoff_date and pub_date_naive > (now - timedelta(days=7)):
                    events.append({
                        'type': 'partnership',
                        'date': pub_date_naive.isoformat(),
                        'description': article.get('title', 'Partnership announcement')[:100],
                        'source': 'lunarcrush'
                    })
        
        return events
    
    def _detect_crypto_regulatory_news(
        self,
        news_data: List[Dict[str, Any]],
        cutoff_date: datetime
    ) -> List[Dict]:
        """
        Detect regulatory news events from crypto news.
        
        Args:
            news_data: List of news articles
            cutoff_date: Maximum date to include
        
        Returns:
            List of regulatory event dictionaries
        """
        events = []
        regulatory_keywords = [
            'regulatory', 'sec', 'cftc', 'ban', 'regulation',
            'legal action', 'lawsuit', 'investigation',
            'regulatory crackdown', 'government', 'regulator'
        ]
        
        for article in news_data:
            title = article.get('title', '').lower()
            text = article.get('text', '').lower()
            combined = f"{title} {text}"
            published_at = article.get('published_at')
            
            # Handle both datetime objects and strings
            if isinstance(published_at, str):
                try:
                    from dateutil import parser
                    published_at = parser.parse(published_at)
                except Exception:
                    self.logger.warning(f"Could not parse published_at: {published_at}")
                    continue
            
            if not published_at or not isinstance(published_at, datetime):
                continue
            
            # Check for regulatory keywords
            if any(keyword in combined for keyword in regulatory_keywords):
                # Allow recent past events (within 7 days)
                now = datetime.now().replace(tzinfo=None)
                pub_date_naive = published_at.replace(tzinfo=None) if published_at.tzinfo else published_at
                if pub_date_naive <= cutoff_date and pub_date_naive > (now - timedelta(days=7)):
                    events.append({
                        'type': 'regulatory_action',
                        'date': pub_date_naive.isoformat(),
                        'description': article.get('title', 'Regulatory news')[:100],
                        'source': 'lunarcrush'
                    })
        
        return events
    
    def _detect_token_unlocks(
        self,
        news_data: List[Dict[str, Any]],
        cutoff_date: datetime,
        asset_id: str
    ) -> List[Dict]:
        """
        Detect token unlock events from crypto news.
        
        Since CoinGecko doesn't provide token unlock schedules, we parse news articles
        for mentions of token unlocks, vesting releases, and supply unlocks.
        
        Args:
            news_data: List of news articles
            cutoff_date: Maximum date to include
            asset_id: Asset symbol for context
        
        Returns:
            List of token unlock event dictionaries
        """
        events = []
        unlock_keywords = [
            'token unlock', 'token release', 'vesting unlock', 'vesting release',
            'supply unlock', 'tokens unlock', 'tokens release', 'unlock schedule',
            'vesting schedule', 'token vesting', 'unlock event', 'release event',
            'tokens vesting', 'unlock date', 'release date', 'vesting cliff',
            'cliff unlock', 'linear unlock', 'unlock percentage', '% unlock'
        ]
        
        # Patterns to extract unlock percentage
        percentage_patterns = [
            r'(\d+(?:\.\d+)?)\s*%\s*(?:of\s+)?(?:supply|tokens|total)',
            r'unlock(?:ing)?\s+(\d+(?:\.\d+)?)\s*%',
            r'(\d+(?:\.\d+)?)\s*%\s*unlock',
            r'release(?:ing)?\s+(\d+(?:\.\d+)?)\s*%',
        ]
        
        for article in news_data:
            title = article.get('title', '').lower()
            text = article.get('text', '').lower()
            combined = f"{title} {text}"
            published_at = article.get('published_at')
            
            # Handle both datetime objects and strings
            if isinstance(published_at, str):
                try:
                    from dateutil import parser
                    published_at = parser.parse(published_at)
                except Exception:
                    continue
            
            if not published_at or not isinstance(published_at, datetime):
                continue
            
            # Make timezone-naive for consistency
            if published_at.tzinfo is not None:
                published_at = published_at.replace(tzinfo=None)
            
            # Check for unlock keywords
            if any(keyword in combined for keyword in unlock_keywords):
                # Try to extract unlock date
                unlock_date = self._extract_date_from_text(combined, published_at)
                if not unlock_date:
                    # If article mentions upcoming unlock and is recent, estimate
                    if any(phrase in combined for phrase in ['upcoming unlock', 'next unlock', 'scheduled unlock']):
                        now = datetime.now().replace(tzinfo=None)
                        if published_at:
                            pub_date = published_at.replace(tzinfo=None) if published_at.tzinfo else published_at
                            days_since_article = (now - pub_date).days
                            if days_since_article <= 7:
                                unlock_date = pub_date + timedelta(days=14)
                
                # Use article date as fallback
                if not unlock_date:
                    unlock_date = published_at
                
                # Extract unlock percentage if mentioned
                unlock_percentage = None
                for pattern in percentage_patterns:
                    match = re.search(pattern, combined, re.IGNORECASE)
                    if match:
                        try:
                            unlock_percentage = float(match.group(1))
                            break
                        except (ValueError, IndexError):
                            continue
                
                # Determine unlock size category
                if unlock_percentage:
                    if unlock_percentage > 5:
                        event_type = 'token_unlock_large'
                    elif unlock_percentage > 1:
                        event_type = 'token_unlock_medium'
                    else:
                        event_type = 'token_unlock_small'
                else:
                    # Default to medium if percentage not found
                    event_type = 'token_unlock_medium'
                    unlock_percentage = 2.5  # Default estimate
                
                # Ensure unlock_date is timezone-naive
                if unlock_date.tzinfo is not None:
                    unlock_date = unlock_date.replace(tzinfo=None)
                
                if unlock_date <= cutoff_date and unlock_date > datetime.now().replace(tzinfo=None):
                    events.append({
                        'type': event_type,
                        'date': unlock_date.isoformat(),
                        'unlock_percentage': unlock_percentage,
                        'description': article.get('title', 'Token unlock')[:100],
                        'source': 'lunarcrush'
                    })
        
        return events
    
    def _deduplicate_events(self, events: List[Dict]) -> List[Dict]:
        """
        Remove duplicate events (same type and date).
        
        Args:
            events: List of event dictionaries
        
        Returns:
            Deduplicated list of events
        """
        seen = set()
        unique_events = []
        
        for event in events:
            # Create key from type and date (date without time)
            event_date = event.get('date', '')
            if isinstance(event_date, str):
                date_key = event_date[:10]  # YYYY-MM-DD
            else:
                date_key = str(event_date)[:10]
            
            key = (event.get('type', 'unknown'), date_key)
            
            if key not in seen:
                seen.add(key)
                unique_events.append(event)
        
        return unique_events
    
    def _get_upcoming_events(
        self,
        asset_id: str,
        asset_type: str,
        days_ahead: int = 30
    ) -> List[Dict]:
        """
        Get upcoming events for an asset by parsing news articles.
        
        Args:
            asset_id: Asset identifier
            asset_type: 'crypto' or 'stock'
            days_ahead: Number of days to look ahead
        
        Returns:
            List of event dictionaries
        """
        events = []
        # Use timezone-naive datetime for consistency
        cutoff_date = datetime.now().replace(tzinfo=None) + timedelta(days=days_ahead)
        
        if asset_type == 'stock':
            try:
                # Fetch news from StockNewsAPI
                news_data = self.stock_news_service.fetch_news(asset_id, limit=100)
                
                self.logger.info(f"Fetched {len(news_data) if news_data else 0} news articles for {asset_id}")
                
                if news_data:
                    # Detect different types of events
                    earnings_events = self._detect_earnings_events(news_data, cutoff_date)
                    sec_events = self._detect_sec_filings(news_data, cutoff_date)
                    regulatory_events = self._detect_regulatory_actions(news_data, cutoff_date)
                    
                    events.extend(earnings_events)
                    events.extend(sec_events)
                    events.extend(regulatory_events)
                    
                    self.logger.info(
                        f"Event detection for {asset_id}: "
                        f"earnings={len(earnings_events)}, sec_filings={len(sec_events)}, "
                        f"regulatory={len(regulatory_events)}, total={len(events)}"
                    )
                    
                    # Deduplicate events
                    events = self._deduplicate_events(events)
                    
                    self.logger.info(f"Detected {len(events)} unique events for {asset_id} from news")
                else:
                    self.logger.warning(f"No news data available for {asset_id}")
                    
            except Exception as e:
                self.logger.error(f"Error fetching stock events from news: {str(e)}", exc_info=True)
        
        elif asset_type == 'crypto':
            try:
                # Fetch news from LunarCrush
                news_data = self.lunarcrush_service.fetch_coin_news(asset_id, limit=100)
                
                self.logger.info(f"Fetched {len(news_data) if news_data else 0} news articles for {asset_id}")
                
                if news_data:
                    # Detect different types of events
                    listing_events = self._detect_exchange_listings(news_data, cutoff_date)
                    fork_events = self._detect_forks_upgrades(news_data, cutoff_date)
                    partnership_events = self._detect_partnerships(news_data, cutoff_date)
                    regulatory_events = self._detect_crypto_regulatory_news(news_data, cutoff_date)
                    unlock_events = self._detect_token_unlocks(news_data, cutoff_date, asset_id)
                    
                    events.extend(listing_events)
                    events.extend(fork_events)
                    events.extend(partnership_events)
                    events.extend(regulatory_events)
                    events.extend(unlock_events)
                    
                    self.logger.info(
                        f"Event detection for {asset_id}: "
                        f"listings={len(listing_events)}, forks={len(fork_events)}, "
                        f"partnerships={len(partnership_events)}, regulatory={len(regulatory_events)}, "
                        f"unlocks={len(unlock_events)}, total={len(events)}"
                    )
                    
                    # Deduplicate events
                    events = self._deduplicate_events(events)
                    
                    self.logger.info(f"Detected {len(events)} unique events for {asset_id} from news")
                else:
                    self.logger.warning(f"No news data available for {asset_id}")
                    
            except Exception as e:
                self.logger.error(f"Error fetching crypto events from news: {str(e)}", exc_info=True)
        
        return events
    
    def _get_economic_risk_from_fred(
        self,
        stored_fred_data: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """
        Get economic risk score from FRED numeric values.
        
        Args:
            stored_fred_data: Previous FRED data from DB (optional)
        
        Returns:
            Dictionary with:
            - 'risk_score': float (-1 to +1)
            - 'events': List of economic events detected
            - 'confidence': float (0 to 1)
        """
        if not self.fred_service.is_available():
            return {
                'risk_score': 0.0,
                'events': [],
                'confidence': 0.0
            }
        
        try:
            # Calculate economic risk score
            economic_risk = self.fred_service.calculate_economic_risk_score(stored_fred_data)
            
            # Convert to events format
            events = []
            for event in economic_risk.get('events', []):
                events.append({
                    'type': event['type'],
                    'date': event.get('date', datetime.now().replace(tzinfo=None).isoformat()),
                    'description': event.get('description', ''),
                    'computed_impact': event.get('impact', 0.0),
                    'source': 'fred_api'
                })
            
            return {
                'risk_score': economic_risk.get('overall_risk_score', 0.0),
                'events': events,
                'confidence': 0.8 if economic_risk.get('events') else 0.5
            }
            
        except Exception as e:
            self.logger.error(f"Error getting economic risk from FRED: {str(e)}", exc_info=True)
            return {
                'risk_score': 0.0,
                'events': [],
                'confidence': 0.0
            }
    
    def _score_event(self, event: Dict) -> float:
        """
        Score an individual event.
        
        Args:
            event: Event dictionary with type, date, etc.
        
        Returns:
            Event score in range [-1, 1]
        """
        try:
            event_type = event.get('type', 'unknown')
            
            # If event has computed_impact (from FRED), use it instead of base impact
            if 'computed_impact' in event:
                base_impact = event['computed_impact']
            else:
                # Get base impact from event_impacts dictionary
                base_impact = self.event_impacts.get(event_type, 0.0)
            
            # Adjust for token unlock magnitude
            if event_type == 'token_unlock':
                unlock_percentage = event.get('unlock_percentage', 0)
                if unlock_percentage > 5:
                    base_impact = -0.9
                elif unlock_percentage > 1:
                    base_impact = -0.6
                else:
                    base_impact = -0.3
            
            # Calculate time proximity weight
            event_date_str = event.get('date', '')
            if event_date_str:
                try:
                    if isinstance(event_date_str, str):
                        event_date = datetime.fromisoformat(event_date_str.replace('Z', '+00:00'))
                    else:
                        event_date = event_date_str
                    
                    now = datetime.now().replace(tzinfo=None)
                    # Make event_date timezone-naive if needed
                    if event_date.tzinfo is not None:
                        event_date = event_date.replace(tzinfo=None)
                    days_away = (event_date - now).days
                    
                    # Allow events up to 7 days in the past (still relevant)
                    if days_away < -7:
                        return 0.0  # Too far in the past
                    
                    # Time weight: events within 7 days = full weight
                    if days_away <= 7:
                        time_weight = 1.0
                    else:
                        # Decay after 7 days
                        time_weight = max(0.3, 1.0 - (days_away - 7) * 0.1)
                    
                    # Calculate final score
                    event_score = base_impact * time_weight
                    return self.clamp_score(event_score)
                    
                except Exception as e:
                    self.logger.warning(f"Error parsing event date: {str(e)}")
                    return base_impact * 0.5  # Default time weight
            
            return base_impact * 0.5  # Default if no date
            
        except Exception as e:
            self.logger.error(f"Error scoring event: {str(e)}")
            return 0.0
    
    def _calculate_confidence(
        self,
        events: List[Dict],
        event_scores: List[Dict]
    ) -> float:
        """
        Calculate confidence based on event data quality.
        
        Args:
            events: List of all events
            event_scores: List of scored events
        
        Returns:
            Confidence in range [0, 1]
        """
        if not events:
            return 0.8  # High confidence if no events
        
        # Confidence factors
        factors = []
        
        # Data completeness: more events with dates = higher confidence
        events_with_dates = sum(1 for e in events if e.get('date'))
        if events_with_dates > 0:
            factors.append(min(1.0, events_with_dates / len(events)))
        else:
            factors.append(0.5)
        
        # Source diversity: multiple sources = higher confidence
        sources = set(e.get('source', 'unknown') for e in events)
        if len(sources) > 1:
            factors.append(1.0)
        elif len(sources) == 1:
            factors.append(0.7)
        else:
            factors.append(0.4)
        
        return sum(factors) / len(factors) if factors else 0.5
