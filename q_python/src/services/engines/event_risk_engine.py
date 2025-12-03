"""
Event Risk Engine
Analyzes upcoming events that could impact asset prices.
TODO: Integrate Stock News API for stocks and LunarCrush API for crypto.
"""
from typing import Dict, Any, Optional, List
from datetime import datetime, timedelta
import logging

from .base_engine import BaseEngine

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
        }
    
    def calculate(
        self,
        asset_id: str,
        asset_type: str,
        timeframe: Optional[str] = None,
        events: Optional[List[Dict]] = None,
        **kwargs
    ) -> Dict[str, Any]:
        """
        Calculate event risk score.
        
        Args:
            asset_id: Asset identifier
            asset_type: 'crypto' or 'stock'
            timeframe: Optional timeframe
            events: Optional list of events (if not provided, will fetch)
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
            
            return self.create_result(event_risk_score, confidence, metadata)
            
        except Exception as e:
            return self.handle_error(e, f"calculation for {asset_id}")
    
    def _get_upcoming_events(
        self,
        asset_id: str,
        asset_type: str,
        days_ahead: int = 30
    ) -> List[Dict]:
        """
        Get upcoming events for an asset.
        
        TODO: Integrate Stock News API for stocks and LunarCrush API for crypto.
        
        Args:
            asset_id: Asset identifier
            asset_type: 'crypto' or 'stock'
            days_ahead: Number of days to look ahead
        
        Returns:
            List of event dictionaries
        """
        events = []
        cutoff_date = datetime.now() + timedelta(days=days_ahead)
        
        if asset_type == 'stock':
            # TODO: Uncomment when Stock News API is integrated
            # try:
            #     # From Stock News API
            #     earnings = stock_news_api.get_upcoming_earnings(asset_id)
            #     sec_filings = stock_news_api.get_upcoming_filings(asset_id)
            #     
            #     for earning in earnings:
            #         if earning.get('date') and datetime.fromisoformat(earning['date']) <= cutoff_date:
            #             events.append({
            #                 'type': 'earnings',
            #                 'date': earning['date'],
            #                 'description': earning.get('description', ''),
            #                 'source': 'stock_news_api'
            #             })
            #     
            #     for filing in sec_filings:
            #         if filing.get('date') and datetime.fromisoformat(filing['date']) <= cutoff_date:
            #             events.append({
            #                 'type': 'sec_filing',
            #                 'date': filing['date'],
            #                 'description': filing.get('description', ''),
            #                 'source': 'stock_news_api'
            #             })
            # except Exception as e:
            #     self.logger.error(f"Error fetching Stock News API data: {str(e)}")
            
            # TODO: Uncomment when FRED API service is available
            # try:
            #     # From FRED API (FOMC meetings, economic releases)
            #     fomc_meetings = fred_service.get_fomc_schedule(days_ahead)
            #     economic_releases = fred_service.get_economic_calendar(days_ahead)
            #     
            #     for meeting in fomc_meetings:
            #         if meeting.get('date') and datetime.fromisoformat(meeting['date']) <= cutoff_date:
            #             events.append({
            #                 'type': 'fomc_meeting',
            #                 'date': meeting['date'],
            #                 'description': 'FOMC Meeting',
            #                 'source': 'fred_api'
            #             })
            #     
            #     for release in economic_releases:
            #         if release.get('date') and datetime.fromisoformat(release['date']) <= cutoff_date:
            #             events.append({
            #                 'type': 'economic_release',
            #                 'date': release['date'],
            #                 'description': release.get('indicator', 'Economic Release'),
            #                 'source': 'fred_api'
            #             })
            # except Exception as e:
            #     self.logger.error(f"Error fetching FRED data: {str(e)}")
            
            self.logger.warning(
                f"Stock News API not integrated. No events fetched for {asset_id}. "
                "TODO: Integrate Stock News API for stock event detection."
            )
        
        elif asset_type == 'crypto':
            # TODO: Uncomment when LunarCrush API is integrated
            # try:
            #     # From LunarCrush API
            #     lunarcrush_events = lunarcrush_api.get_coin_events(asset_id)
            #     
            #     for event in lunarcrush_events:
            #         if event.get('date') and datetime.fromisoformat(event['date']) <= cutoff_date:
            #             events.append({
            #                 'type': event.get('type', 'unknown'),
            #                 'date': event['date'],
            #                 'description': event.get('description', ''),
            #                 'source': 'lunarcrush'
            #             })
            # except Exception as e:
            #     self.logger.error(f"Error fetching LunarCrush data: {str(e)}")
            
            # TODO: Uncomment when exchange APIs are available
            # try:
            #     # From Exchange APIs
            #     listings = exchange_api.get_upcoming_listings()
            #     hard_forks = exchange_api.get_upcoming_forks(asset_id)
            #     
            #     for listing in listings:
            #         if listing.get('symbol') == asset_id and listing.get('date'):
            #             if datetime.fromisoformat(listing['date']) <= cutoff_date:
            #                 events.append({
            #                     'type': 'exchange_listing',
            #                     'date': listing['date'],
            #                     'description': f"Listing on {listing.get('exchange', 'exchange')}",
            #                     'source': 'exchange_api'
            #                 })
            #     
            #     for fork in hard_forks:
            #         if fork.get('date') and datetime.fromisoformat(fork['date']) <= cutoff_date:
            #             events.append({
            #                 'type': 'hard_fork',
            #                 'date': fork['date'],
            #                 'description': fork.get('description', 'Hard Fork'),
            #                 'source': 'exchange_api'
            #             })
            # except Exception as e:
            #     self.logger.error(f"Error fetching exchange data: {str(e)}")
            
            # TODO: Uncomment when database token unlock data is available
            # try:
            #     # From database (token unlock schedules)
            #     token_unlocks = db.get_token_unlocks(asset_id, days_ahead)
            #     
            #     for unlock in token_unlocks:
            #         if unlock.get('unlock_date') and datetime.fromisoformat(unlock['unlock_date']) <= cutoff_date:
            #             unlock_percentage = unlock.get('unlock_percentage', 0)
            #             events.append({
            #                 'type': 'token_unlock',
            #                 'date': unlock['unlock_date'],
            #                 'unlock_percentage': unlock_percentage,
            #                 'description': f"Token unlock: {unlock_percentage}% of supply",
            #                 'source': 'database'
            #             })
            # except Exception as e:
            #     self.logger.error(f"Error fetching token unlock data: {str(e)}")
            
            self.logger.warning(
                f"LunarCrush API not integrated. No events fetched for {asset_id}. "
                "TODO: Integrate LunarCrush API for crypto event detection."
            )
        
        return events
    
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
            
            # Get base impact
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
                    
                    days_away = (event_date - datetime.now()).days
                    
                    if days_away < 0:
                        return 0.0  # Past event
                    
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
