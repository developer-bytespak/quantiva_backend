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
            # Get latest data point
            data = self.fred.get_series(series_id, limit=1)
            
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
            # Fetch both series
            dgs10 = self.fred.get_series('DGS10', limit=1)  # 10-year Treasury
            dgs2 = self.fred.get_series('DGS2', limit=1)    # 2-year Treasury
            
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

