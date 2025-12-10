"""
FRED API Service
Fetches economic indicators from Federal Reserve Economic Data (FRED) API.
Returns numeric time series data (dates + values).
"""
from typing import Dict, Any, Optional
from datetime import datetime, timedelta
import pandas as pd
import logging
import os

try:
    from fredapi import Fred
    FRED_AVAILABLE = True
except ImportError:
    FRED_AVAILABLE = False
    logging.warning("fredapi not installed. FRED service will not work. Install with: pip install fredapi")

logger = logging.getLogger(__name__)


class FredService:
    """
    Service for fetching economic indicators from FRED API.
    
    FRED API returns numeric time series data (dates + values).
    Data format: pandas Series with dates as index and numeric values.
    """
    
    def __init__(self, api_key: Optional[str] = None):
        """
        Initialize FRED service.
        
        Args:
            api_key: FRED API key (defaults to FRED_API_KEY env var)
        """
        self.api_key = api_key or os.getenv('FRED_API_KEY')
        
        if not FRED_AVAILABLE:
            logger.error("fredapi package not installed. FRED service unavailable.")
            self.fred = None
        elif not self.api_key:
            logger.warning("FRED_API_KEY not set. FRED service unavailable.")
            self.fred = None
        else:
            try:
                self.fred = Fred(api_key=self.api_key)
                logger.info("FRED service initialized successfully")
            except Exception as e:
                logger.error(f"Error initializing FRED service: {str(e)}")
                self.fred = None
    
    def is_available(self) -> bool:
        """Check if FRED service is available."""
        return self.fred is not None
    
    def fetch_indicator(
        self,
        series_id: str,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None
    ) -> pd.Series:
        """
        Fetch time series data for a FRED indicator.
        
        Args:
            series_id: FRED series ID (e.g., 'FEDFUNDS', 'CPIAUCSL')
            start_date: Start date in 'YYYY-MM-DD' format
            end_date: End date in 'YYYY-MM-DD' format
        
        Returns:
            pandas Series with dates as index and values
            Example:
                2024-01-01    5.25
                2024-02-01    5.25
                ...
        """
        if not self.is_available():
            logger.error("FRED service not available")
            return pd.Series()
        
        try:
            data = self.fred.get_series(
                series_id,
                start=start_date,
                end=end_date
            )
            logger.info(f"Fetched {len(data)} data points for {series_id}")
            return data
        except Exception as e:
            logger.error(f"Error fetching {series_id}: {str(e)}")
            return pd.Series()
    
    def get_latest_value(self, series_id: str) -> Optional[Dict[str, Any]]:
        """
        Get the most recent value for an indicator.
        
        Args:
            series_id: FRED series ID
        
        Returns:
            Dictionary with value, date, and series_id, or None if error
            Example: {
                'value': 5.25,
                'date': '2024-12-01',
                'series_id': 'FEDFUNDS'
            }
        """
        if not self.is_available():
            logger.error("FRED service not available")
            return None
        
        try:
            # Get latest data point - fetch recent data (last 1 year) and get latest
            end_date = datetime.now().strftime('%Y-%m-%d')
            start_date = (datetime.now() - timedelta(days=365)).strftime('%Y-%m-%d')
            data = self.fred.get_series(series_id, start=start_date, end=end_date)
            
            if len(data) == 0:
                # Fallback: try without date range
                data = self.fred.get_series(series_id)
            
            if len(data) > 0:
                latest_date = data.index[-1]
                latest_value = data.iloc[-1]
                
                # Convert date to string
                if isinstance(latest_date, pd.Timestamp):
                    date_str = latest_date.strftime('%Y-%m-%d')
                else:
                    date_str = str(latest_date)
                
                return {
                    'value': float(latest_value),
                    'date': date_str,
                    'series_id': series_id
                }
            else:
                logger.warning(f"No data available for {series_id}")
                return None
                
        except Exception as e:
            logger.error(f"Error getting latest value for {series_id}: {str(e)}")
            return None
    
    def calculate_yield_curve(self) -> Optional[Dict[str, Any]]:
        """
        Calculate 10Y-2Y Treasury spread (yield curve).
        
        Returns:
            Dictionary with spread, rates, date, and inversion status, or None if error
            Example: {
                'spread': 0.5,  # 10Y - 2Y
                '10y_rate': 4.5,
                '2y_rate': 4.0,
                'date': '2024-12-01',
                'is_inverted': False  # Negative spread = inverted = bearish
            }
        """
        if not self.is_available():
            logger.error("FRED service not available")
            return None
        
        try:
            # Fetch both series - get recent data
            end_date = datetime.now().strftime('%Y-%m-%d')
            start_date = (datetime.now() - timedelta(days=30)).strftime('%Y-%m-%d')
            dgs10 = self.fred.get_series('DGS10', start=start_date, end=end_date)  # 10-year Treasury
            dgs2 = self.fred.get_series('DGS2', start=start_date, end=end_date)    # 2-year Treasury
            
            if len(dgs10) > 0 and len(dgs2) > 0:
                rate_10y = float(dgs10.iloc[-1])
                rate_2y = float(dgs2.iloc[-1])
                spread = rate_10y - rate_2y
                
                # Get date (use 10Y date)
                date = dgs10.index[-1]
                if isinstance(date, pd.Timestamp):
                    date_str = date.strftime('%Y-%m-%d')
                else:
                    date_str = str(date)
                
                return {
                    'spread': float(spread),
                    '10y_rate': rate_10y,
                    '2y_rate': rate_2y,
                    'date': date_str,
                    'is_inverted': spread < 0
                }
            else:
                logger.warning("Insufficient data for yield curve calculation")
                return None
                
        except Exception as e:
            logger.error(f"Error calculating yield curve: {str(e)}")
            return None
    
    def check_data_updated(
        self,
        series_id: str,
        last_stored_date: str
    ) -> bool:
        """
        Check if new data is available in FRED.
        
        Args:
            series_id: FRED series ID
            last_stored_date: Last stored date in 'YYYY-MM-DD' format
        
        Returns:
            True if FRED has newer data than stored
        """
        if not self.is_available():
            return False
        
        try:
            latest = self.get_latest_value(series_id)
            if latest:
                fred_date = datetime.strptime(latest['date'], '%Y-%m-%d')
                stored_date = datetime.strptime(last_stored_date, '%Y-%m-%d')
                return fred_date > stored_date
            return False
        except Exception as e:
            logger.error(f"Error checking update for {series_id}: {str(e)}")
            return False
    
    def fetch_all_primary_indicators(self) -> Dict[str, Any]:
        """
        Fetch all primary indicators at once.
        
        Returns:
            Dictionary with all indicator data
            Example: {
                'cpi': {'value': 3.5, 'date': '2024-12-01', 'series_id': 'CPIAUCSL'},
                'fedfunds': {'value': 5.25, 'date': '2024-12-01', 'series_id': 'FEDFUNDS'},
                'yield_curve': {'spread': 0.5, '10y_rate': 4.5, '2y_rate': 4.0, ...},
                'nfp': {'value': 150000, 'date': '2024-12-01', 'series_id': 'PAYEMS'},
                'gdp': {'value': 28000.0, 'date': '2024-12-01', 'series_id': 'GDP'}
            }
        """
        indicators = {
            'cpi': self.get_latest_value('CPIAUCSL'),
            'fedfunds': self.get_latest_value('FEDFUNDS'),
            'yield_curve': self.calculate_yield_curve(),
            'nfp': self.get_latest_value('PAYEMS'),
            'gdp': self.get_latest_value('GDP')
        }
        
        logger.info(f"Fetched {sum(1 for v in indicators.values() if v is not None)} primary indicators")
        return indicators
    
    def get_primary_indicators_config(self) -> Dict[str, Dict[str, Any]]:
        """
        Get configuration for primary indicators.
        
        Returns:
            Dictionary with indicator configurations
        """
        return {
            'CPIAUCSL': {
                'name': 'Consumer Price Index',
                'update_frequency': 'monthly',
                'query_frequency': 'daily_check',
                'use': 'inflation_risk_factor'
            },
            'FEDFUNDS': {
                'name': 'Federal Funds Rate',
                'update_frequency': 'daily',
                'query_frequency': 'daily',
                'use': 'monetary_policy_trend'
            },
            'DGS10': {
                'name': '10-Year Treasury Rate',
                'update_frequency': 'daily',
                'query_frequency': 'daily',
                'use': 'yield_curve_calculation'
            },
            'DGS2': {
                'name': '2-Year Treasury Rate',
                'update_frequency': 'daily',
                'query_frequency': 'daily',
                'use': 'yield_curve_calculation'
            },
            'PAYEMS': {
                'name': 'Non-Farm Payrolls',
                'update_frequency': 'monthly',
                'query_frequency': 'daily_check',
                'use': 'job_market_strength'
            },
            'GDP': {
                'name': 'Gross Domestic Product',
                'update_frequency': 'quarterly',
                'query_frequency': 'weekly_check',
                'use': 'growth_regime_indicator'
            }
        }
    
    def detect_fed_rate_change(
        self,
        previous_rate: Optional[float] = None,
        previous_date: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        """
        Detect if Fed Funds Rate changed compared to previous value.
        
        Args:
            previous_rate: Previous stored rate value (from DB)
            previous_date: Previous stored date (from DB)
        
        Returns:
            Dictionary with rate change info if changed, None otherwise:
            {
                'current_rate': 5.25,
                'previous_rate': 5.00,
                'change': 0.25,
                'change_percentage': 5.0,
                'current_date': '2024-12-15',
                'previous_date': '2024-11-15',
                'direction': 'hike' or 'cut',
                'magnitude': 'large' (>0.5), 'medium' (0.25-0.5), 'small' (<0.25)
            }
        """
        if not self.is_available():
            return None
        
        try:
            current = self.get_latest_value('FEDFUNDS')
            if not current:
                return None
            
            # If no previous rate provided, can't detect change
            if previous_rate is None:
                return None
            
            current_rate = current['value']
            current_date = current['date']
            
            # Check if rate changed
            rate_change = current_rate - previous_rate
            
            # Only return if there's a significant change (>= 0.01 to avoid floating point issues)
            if abs(rate_change) < 0.01:
                return None
            
            # Determine direction
            direction = 'hike' if rate_change > 0 else 'cut'
            
            # Determine magnitude
            abs_change = abs(rate_change)
            if abs_change > 0.5:
                magnitude = 'large'
            elif abs_change >= 0.25:
                magnitude = 'medium'
            else:
                magnitude = 'small'
            
            # Calculate percentage change
            change_percentage = (rate_change / previous_rate) * 100 if previous_rate > 0 else 0
            
            return {
                'current_rate': current_rate,
                'previous_rate': previous_rate,
                'change': rate_change,
                'change_percentage': change_percentage,
                'current_date': current_date,
                'previous_date': previous_date or 'unknown',
                'direction': direction,
                'magnitude': magnitude
            }
            
        except Exception as e:
            logger.error(f"Error detecting Fed rate change: {str(e)}")
            return None
    
    def detect_inflation_change(
        self,
        previous_cpi: Optional[float] = None,
        previous_date: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        """
        Detect significant inflation changes.
        
        Args:
            previous_cpi: Previous stored CPI value (from DB)
            previous_date: Previous stored date (from DB)
        
        Returns:
            Dictionary with inflation change info if significant, None otherwise:
            {
                'current_cpi': 307.5,
                'previous_cpi': 305.0,
                'monthly_change': 0.82,  # Percentage
                'current_date': '2024-12-01',
                'previous_date': '2024-11-01',
                'risk_level': 'high' (>0.5%), 'medium' (0.2-0.5%), 'low' (<0.2%)
            }
        """
        if not self.is_available():
            return None
        
        try:
            current = self.get_latest_value('CPIAUCSL')
            if not current:
                return None
            
            # If no previous CPI provided, can't detect change
            if previous_cpi is None:
                return None
            
            current_cpi = current['value']
            current_date = current['date']
            
            # Calculate monthly change percentage
            monthly_change = ((current_cpi - previous_cpi) / previous_cpi) * 100
            
            # Determine risk level
            abs_change = abs(monthly_change)
            if abs_change > 0.5:
                risk_level = 'high'
            elif abs_change >= 0.2:
                risk_level = 'medium'
            else:
                risk_level = 'low'
            
            # Only return if change is significant (>= 0.1%)
            if abs_change < 0.1:
                return None
            
            return {
                'current_cpi': current_cpi,
                'previous_cpi': previous_cpi,
                'monthly_change': monthly_change,
                'current_date': current_date,
                'previous_date': previous_date or 'unknown',
                'risk_level': risk_level
            }
            
        except Exception as e:
            logger.error(f"Error detecting inflation change: {str(e)}")
            return None
    
    def calculate_economic_risk_score(
        self,
        stored_data: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """
        Calculate overall economic risk score from FRED data.
        
        Uses current values and compares with stored previous values to compute risk.
        
        Args:
            stored_data: Dictionary with previous values from DB:
            {
                'fedfunds': {'value': 5.00, 'date': '2024-11-15'},
                'cpi': {'value': 305.0, 'date': '2024-11-01'},
                'yield_curve': {'spread': 0.5, 'date': '2024-11-15'},
                ...
            }
        
        Returns:
            Dictionary with risk score and breakdown:
            {
                'overall_risk_score': -0.3,  # -1 to +1
                'components': {
                    'rate_change_risk': -0.4,
                    'inflation_risk': -0.2,
                    'yield_curve_risk': -0.1
                },
                'events': [
                    {'type': 'fed_rate_hike', 'impact': -0.7, 'date': '2024-12-15', 'description': '...'},
                    {'type': 'inflation_spike', 'impact': -0.3, 'date': '2024-12-01', 'description': '...'}
                ]
            }
        """
        if not self.is_available():
            return {
                'overall_risk_score': 0.0,
                'components': {},
                'events': []
            }
        
        events = []
        components = {}
        
        try:
            # 1. Detect Fed rate changes
            previous_fed = stored_data.get('fedfunds', {}) if stored_data else {}
            rate_change = self.detect_fed_rate_change(
                previous_rate=previous_fed.get('value'),
                previous_date=previous_fed.get('date')
            )
            
            if rate_change:
                # Calculate impact based on direction and magnitude
                if rate_change['direction'] == 'hike':
                    base_impact = -0.7  # Negative for stocks
                    event_type = 'fed_rate_hike'
                    description = f"Fed rate hike: +{rate_change['change']:.2f}% to {rate_change['current_rate']:.2f}%"
                else:
                    base_impact = 0.5  # Positive for stocks
                    event_type = 'fed_rate_cut'
                    description = f"Fed rate cut: {rate_change['change']:.2f}% to {rate_change['current_rate']:.2f}%"
                
                # Adjust impact based on magnitude
                magnitude_multiplier = {
                    'large': 1.5,
                    'medium': 1.0,
                    'small': 0.7
                }.get(rate_change['magnitude'], 1.0)
                
                impact = base_impact * magnitude_multiplier
                impact = max(-1.0, min(1.0, impact))  # Clamp to [-1, 1]
                
                components['rate_change_risk'] = impact
                
                events.append({
                    'type': event_type,
                    'impact': impact,
                    'date': rate_change['current_date'],
                    'description': description,
                    'rate_change': rate_change['change'],
                    'current_rate': rate_change['current_rate']
                })
            else:
                components['rate_change_risk'] = 0.0
            
            # 2. Detect inflation changes
            previous_cpi = stored_data.get('cpi', {}) if stored_data else {}
            inflation_change = self.detect_inflation_change(
                previous_cpi=previous_cpi.get('value'),
                previous_date=previous_cpi.get('date')
            )
            
            if inflation_change and inflation_change['risk_level'] in ['high', 'medium']:
                # High inflation = negative for stocks
                if inflation_change['risk_level'] == 'high':
                    impact = -0.4
                else:
                    impact = -0.2
                
                # If inflation is decreasing, it's positive
                if inflation_change['monthly_change'] < 0:
                    impact = abs(impact)  # Positive
                
                components['inflation_risk'] = impact
                
                events.append({
                    'type': 'inflation_spike' if inflation_change['monthly_change'] > 0 else 'inflation_decrease',
                    'impact': impact,
                    'date': inflation_change['current_date'],
                    'description': f"Inflation change: {inflation_change['monthly_change']:.2f}%",
                    'inflation_change': inflation_change['monthly_change'],
                    'current_cpi': inflation_change['current_cpi']
                })
            else:
                components['inflation_risk'] = 0.0
            
            # 3. Check yield curve inversion
            yield_curve = self.calculate_yield_curve()
            if yield_curve and yield_curve.get('is_inverted'):
                impact = -0.5  # Inverted yield curve = bearish
                components['yield_curve_risk'] = impact
                
                events.append({
                    'type': 'yield_curve_inversion',
                    'impact': impact,
                    'date': yield_curve['date'],
                    'description': f"Yield curve inverted: {yield_curve['spread']:.2f}%",
                    'spread': yield_curve['spread'],
                    '10y_rate': yield_curve['10y_rate'],
                    '2y_rate': yield_curve['2y_rate']
                })
            else:
                components['yield_curve_risk'] = 0.0
            
            # Calculate overall risk score (weighted average)
            # Rate changes are most important (50%), inflation (30%), yield curve (20%)
            overall_risk = (
                0.5 * components.get('rate_change_risk', 0.0) +
                0.3 * components.get('inflation_risk', 0.0) +
                0.2 * components.get('yield_curve_risk', 0.0)
            )
            
            # Clamp to [-1, 1]
            overall_risk = max(-1.0, min(1.0, overall_risk))
            
            return {
                'overall_risk_score': overall_risk,
                'components': components,
                'events': events
            }
            
        except Exception as e:
            logger.error(f"Error calculating economic risk score: {str(e)}", exc_info=True)
            return {
                'overall_risk_score': 0.0,
                'components': {},
                'events': []
            }

