"""
Technical Engine
Calculates technical indicators and trend scores based on OHLCV data.
"""
from typing import Dict, Any, Optional, List
import pandas as pd
import numpy as np
import pandas_ta as ta
from datetime import datetime, timedelta
import logging
import requests

from .base_engine import BaseEngine
from src.config import NESTJS_API_URL, NESTJS_API_TIMEOUT

logger = logging.getLogger(__name__)


class TechnicalEngine(BaseEngine):
    """
    Technical analysis engine that calculates:
    - Moving Averages (MA20, MA50, MA200)
    - RSI (14, 30 periods)
    - MACD (12, 26, 9)
    - ATR (14 period)
    - Trend structure analysis
    - Multi-timeframe analysis
    """
    
    def __init__(self):
        super().__init__("TechnicalEngine")
        self.nestjs_api_url = NESTJS_API_URL
        self.api_timeout = NESTJS_API_TIMEOUT
    
    def calculate(
        self,
        asset_id: str,
        asset_type: str,
        timeframe: Optional[str] = None,
        ohlcv_data: Optional[pd.DataFrame] = None,
        **kwargs
    ) -> Dict[str, Any]:
        """
        Calculate technical trend score.
        
        Args:
            asset_id: Asset identifier
            asset_type: 'crypto' or 'stock'
            timeframe: Primary timeframe (e.g., '1h', '4h', '1d')
            ohlcv_data: DataFrame with OHLCV data (columns: open, high, low, close, volume)
            **kwargs: Additional parameters (connection_id, exchange for multi-timeframe fetching)
        
        Returns:
            Dictionary with score, confidence, and metadata
        """
        try:
            if not self.validate_inputs(asset_id, asset_type):
                return self.handle_error(ValueError("Invalid inputs"), "validation")
            
            # Try to fetch multi-timeframe data if connection_id provided
            connection_id = kwargs.get('connection_id')
            exchange = kwargs.get('exchange', 'binance')
            # Use asset_symbol if provided (for OHLCV fetching), otherwise use asset_id
            asset_symbol = kwargs.get('asset_symbol', asset_id)
            
            multi_timeframe_data = None
            if connection_id:
                try:
                    multi_timeframe_data = self._fetch_multi_timeframe_ohlcv(
                        asset_symbol, exchange, connection_id
                    )
                except Exception as e:
                    self.logger.warning(f"Failed to fetch multi-timeframe data: {str(e)}")
                    multi_timeframe_data = None
            
            # Use multi-timeframe data if available, otherwise fallback to provided ohlcv_data
            if multi_timeframe_data:
                ohlcv_1d = multi_timeframe_data.get('1d')
                ohlcv_4h = multi_timeframe_data.get('4h')
                ohlcv_1h = multi_timeframe_data.get('1h')
                
                # Calculate trend score using multi-timeframe formula
                trend_score, indicators_by_timeframe = self._calculate_multi_timeframe_trend_score(
                    ohlcv_1d, ohlcv_4h, ohlcv_1h, ohlcv_data
                )
                
                # Calculate confidence based on data quality
                data_points = max(
                    len(ohlcv_1d) if ohlcv_1d is not None else 0,
                    len(ohlcv_4h) if ohlcv_4h is not None else 0,
                    len(ohlcv_1h) if ohlcv_1h is not None else 0,
                    len(ohlcv_data) if ohlcv_data is not None else 0
                )
                data_freshness = self._calculate_data_freshness(
                    ohlcv_1d if ohlcv_1d is not None else (ohlcv_data if ohlcv_data is not None else pd.DataFrame())
                )
            else:
                # Fallback to single timeframe calculation
                if ohlcv_data is None or ohlcv_data.empty:
                    # If no OHLCV data and no connection_id, return neutral score instead of error
                    # This allows preview to work even without user connection
                    if not connection_id:
                        self.logger.warning(
                            f"No OHLCV data and no connection_id for {asset_id}. "
                            f"Returning neutral trend score. For real scores, ensure user has active exchange connection."
                        )
                        return self.create_result(
                            0.0,
                            0.0,
                            {
                                'note': 'No OHLCV data available - connection_id required for data fetching',
                                'indicators': {},
                                'data_available': False
                            }
                        )
                    else:
                        return self.handle_error(ValueError("No OHLCV data provided"), "data")
                
                # Ensure required columns exist
                required_cols = ['open', 'high', 'low', 'close', 'volume']
                if not all(col in ohlcv_data.columns for col in required_cols):
                    return self.handle_error(
                        ValueError(f"Missing required columns. Need: {required_cols}"),
                        "data"
                    )
                
                # Calculate indicators for primary timeframe
                primary_indicators = self._calculate_indicators(ohlcv_data)
                
                # Calculate trend score (single timeframe)
                trend_score = self._calculate_trend_score(primary_indicators, ohlcv_data)
                
                indicators_by_timeframe = {
                    'primary': primary_indicators
                }
                
                # Calculate confidence based on data quality
                data_points = len(ohlcv_data)
                data_freshness = self._calculate_data_freshness(ohlcv_data)
            
            confidence = self.calculate_confidence(
                data_points,
                data_freshness,
                required_points=50,
                max_age_hours=24.0
            )
            
            metadata = {
                'indicators': indicators_by_timeframe.get('primary', {}),
                'timeframes': {
                    '1d': indicators_by_timeframe.get('1d', {}),
                    '4h': indicators_by_timeframe.get('4h', {}),
                    '1h': indicators_by_timeframe.get('1h', {})
                },
                'data_points': data_points,
                'data_freshness_hours': data_freshness,
                'timeframe': timeframe or 'default',
                'multi_timeframe': multi_timeframe_data is not None
            }
            
            return self.create_result(trend_score, confidence, metadata)
            
        except Exception as e:
            return self.handle_error(e, f"calculation for {asset_id}")
    
    def _calculate_indicators(self, df: pd.DataFrame) -> Dict[str, float]:
        """
        Calculate all technical indicators.
        
        Args:
            df: DataFrame with OHLCV data
        
        Returns:
            Dictionary of indicator values
        """
        indicators = {}
        
        try:
            # Moving Averages
            indicators['ma20'] = float(df['close'].rolling(window=20).mean().iloc[-1]) if len(df) >= 20 else None
            indicators['ma50'] = float(df['close'].rolling(window=50).mean().iloc[-1]) if len(df) >= 50 else None
            indicators['ma200'] = float(df['close'].rolling(window=200).mean().iloc[-1]) if len(df) >= 200 else None
            
            # RSI (14 and 30 periods)
            if len(df) >= 30:
                rsi_14 = ta.rsi(df['close'], length=14)
                rsi_30 = ta.rsi(df['close'], length=30)
                indicators['rsi_14'] = float(rsi_14.iloc[-1]) if not rsi_14.empty else None
                indicators['rsi_30'] = float(rsi_30.iloc[-1]) if not rsi_30.empty else None
            else:
                indicators['rsi_14'] = None
                indicators['rsi_30'] = None
            
            # MACD (12, 26, 9)
            if len(df) >= 26:
                macd = ta.macd(df['close'], fast=12, slow=26, signal=9)
                if macd is not None and not macd.empty:
                    indicators['macd'] = float(macd.iloc[-1, 0]) if macd.shape[1] > 0 else None
                    indicators['macd_signal'] = float(macd.iloc[-1, 1]) if macd.shape[1] > 1 else None
                    indicators['macd_hist'] = float(macd.iloc[-1, 2]) if macd.shape[1] > 2 else None
                else:
                    indicators['macd'] = None
                    indicators['macd_signal'] = None
                    indicators['macd_hist'] = None
            else:
                indicators['macd'] = None
                indicators['macd_signal'] = None
                indicators['macd_hist'] = None
            
            # ATR (14 period)
            if len(df) >= 14:
                atr = ta.atr(df['high'], df['low'], df['close'], length=14)
                indicators['atr'] = float(atr.iloc[-1]) if not atr.empty else None
            else:
                indicators['atr'] = None
            
            # Current price
            indicators['current_price'] = float(df['close'].iloc[-1])
            
            # Rate of Change (ROC)
            if len(df) >= 2:
                roc = ((df['close'].iloc[-1] - df['close'].iloc[-2]) / df['close'].iloc[-2]) * 100
                indicators['roc'] = float(roc)
            else:
                indicators['roc'] = 0.0
            
        except Exception as e:
            self.logger.error(f"Error calculating indicators: {str(e)}")
        
        return indicators
    
    def _calculate_trend_score(
        self,
        indicators: Dict[str, float],
        df: pd.DataFrame
    ) -> float:
        """
        Calculate trend score using formula:
        trend_score = 0.4*(MA50 vs MA200) + 0.3*(MA20 vs MA50) + 0.2*(ROC) + 0.1*(structure)
        
        Args:
            indicators: Dictionary of indicator values
            df: DataFrame with price data
        
        Returns:
            Trend score in range [-1, 1]
        """
        score_components = []
        
        # Component 1: MA50 vs MA200 (40% weight)
        if indicators.get('ma50') and indicators.get('ma200'):
            ma_comparison = (indicators['ma50'] - indicators['ma200']) / indicators['ma200']
            # Normalize: positive = uptrend, negative = downtrend
            ma_score = self.normalize_score(ma_comparison * 100, input_min=-10, input_max=10)
            score_components.append(('ma_trend', ma_score, 0.4))
        else:
            score_components.append(('ma_trend', 0.0, 0.4))
        
        # Component 2: MA20 vs MA50 (30% weight)
        if indicators.get('ma20') and indicators.get('ma50'):
            ma20_50_comparison = (indicators['ma20'] - indicators['ma50']) / indicators['ma50']
            ma20_50_score = self.normalize_score(ma20_50_comparison * 100, input_min=-5, input_max=5)
            score_components.append(('ma20_50', ma20_50_score, 0.3))
        else:
            score_components.append(('ma20_50', 0.0, 0.3))
        
        # Component 3: Rate of Change (20% weight)
        roc = indicators.get('roc', 0.0)
        roc_score = self.normalize_score(roc, input_min=-10, input_max=10)
        score_components.append(('roc', roc_score, 0.2))
        
        # Component 4: Trend Structure (10% weight)
        structure_score = self._analyze_trend_structure(df)
        score_components.append(('structure', structure_score, 0.1))
        
        # Calculate weighted average
        total_weight = sum(weight for _, _, weight in score_components)
        if total_weight > 0:
            weighted_score = sum(score * weight for _, score, weight in score_components) / total_weight
        else:
            weighted_score = 0.0
        
        return self.clamp_score(weighted_score)
    
    def _analyze_trend_structure(self, df: pd.DataFrame) -> float:
        """
        Analyze trend structure (higher highs, lower lows, support/resistance).
        
        Args:
            df: DataFrame with price data
        
        Returns:
            Structure score in range [-1, 1]
        """
        if len(df) < 20:
            return 0.0
        
        try:
            # Get recent highs and lows
            recent_data = df.tail(20)
            highs = recent_data['high']
            lows = recent_data['low']
            
            # Check for higher highs (uptrend) or lower lows (downtrend)
            recent_highs = highs.tail(10)
            recent_lows = lows.tail(10)
            
            # Higher highs indicator
            higher_highs = 0
            for i in range(1, len(recent_highs)):
                if recent_highs.iloc[i] > recent_highs.iloc[i-1]:
                    higher_highs += 1
            
            # Lower lows indicator
            lower_lows = 0
            for i in range(1, len(recent_lows)):
                if recent_lows.iloc[i] < recent_lows.iloc[i-1]:
                    lower_lows += 1
            
            # Calculate structure score
            # Positive for higher highs, negative for lower lows
            structure_ratio = (higher_highs - lower_lows) / max(len(recent_highs) - 1, 1)
            structure_score = self.normalize_score(structure_ratio, input_min=-1, input_max=1)
            
            return structure_score
            
        except Exception as e:
            self.logger.error(f"Error analyzing trend structure: {str(e)}")
            return 0.0
    
    def _calculate_data_freshness(self, df: pd.DataFrame) -> float:
        """
        Calculate data freshness in hours.
        
        Args:
            df: DataFrame with datetime index or timestamp column
        
        Returns:
            Hours since last data point
        """
        try:
            if df is None or df.empty:
                return 24.0  # Assume stale data
            
            if df.index.dtype == 'datetime64[ns]' or isinstance(df.index[0], datetime):
                last_timestamp = df.index[-1]
                if isinstance(last_timestamp, pd.Timestamp):
                    last_timestamp = last_timestamp.to_pydatetime()
                hours_ago = (datetime.now() - last_timestamp).total_seconds() / 3600
                return max(0.0, hours_ago)
            else:
                # Assume data is recent if no timestamp available
                return 0.0
        except Exception as e:
            self.logger.warning(f"Could not calculate data freshness: {str(e)}")
            return 24.0  # Assume stale data
    
    def _fetch_multi_timeframe_ohlcv(
        self,
        symbol: str,
        exchange: str,
        connection_id: str
    ) -> Optional[Dict[str, pd.DataFrame]]:
        """
        Fetch OHLCV data for multiple timeframes (1d, 4h, 1h) from NestJS API.
        
        Args:
            symbol: Asset symbol (e.g., 'BTC')
            exchange: Exchange name ('binance' or 'bybit')
            connection_id: NestJS connection ID
        
        Returns:
            Dictionary with '1d', '4h', '1h' DataFrames, or None if failed
        """
        if not connection_id:
            return None
        
        try:
            # Convert symbol to trading pair format (e.g., BTC -> BTCUSDT)
            trading_pair = f"{symbol.upper()}USDT"
            
            result = {}
            
            # Fetch 1d candles (for MA50 vs MA200)
            ohlcv_1d = self._fetch_ohlcv_from_api(trading_pair, '1d', 200, connection_id)
            if ohlcv_1d is not None:
                result['1d'] = ohlcv_1d
            
            # Fetch 4h candles (for MA20 vs MA50)
            ohlcv_4h = self._fetch_ohlcv_from_api(trading_pair, '4h', 200, connection_id)
            if ohlcv_4h is not None:
                result['4h'] = ohlcv_4h
            
            # Fetch 1h candles (for ROC)
            ohlcv_1h = self._fetch_ohlcv_from_api(trading_pair, '1h', 24, connection_id)
            if ohlcv_1h is not None:
                result['1h'] = ohlcv_1h
            
            return result if result else None
            
        except Exception as e:
            self.logger.error(f"Error fetching multi-timeframe OHLCV: {str(e)}")
            return None
    
    def _fetch_ohlcv_from_api(
        self,
        trading_pair: str,
        interval: str,
        limit: int,
        connection_id: str
    ) -> Optional[pd.DataFrame]:
        """
        Fetch OHLCV data from NestJS API and convert to DataFrame.
        
        Args:
            trading_pair: Trading pair (e.g., 'BTCUSDT')
            interval: Timeframe interval ('1d', '4h', '1h')
            limit: Number of candles to fetch
            connection_id: NestJS connection ID
        
        Returns:
            DataFrame with OHLCV data, or None if failed
        """
        try:
            url = f"{self.nestjs_api_url}/exchanges/connections/{connection_id}/candles/{trading_pair}"
            params = {
                'interval': interval,
                'limit': str(limit)
            }
            
            response = requests.get(url, params=params, timeout=self.api_timeout)
            response.raise_for_status()
            
            data = response.json()
            
            if data.get('success') and data.get('data'):
                candles = data['data']
                
                # Convert to DataFrame
                df_data = []
                for candle in candles:
                    df_data.append({
                        'open': float(candle.get('open', 0)),
                        'high': float(candle.get('high', 0)),
                        'low': float(candle.get('low', 0)),
                        'close': float(candle.get('close', 0)),
                        'volume': float(candle.get('volume', 0)),
                        'timestamp': pd.to_datetime(candle.get('openTime', 0), unit='ms')
                    })
                
                df = pd.DataFrame(df_data)
                if not df.empty:
                    df.set_index('timestamp', inplace=True)
                    df.sort_index(inplace=True)
                
                return df
            else:
                self.logger.warning(f"No OHLCV data returned for {trading_pair} {interval}")
                return None
                
        except requests.exceptions.RequestException as e:
            self.logger.warning(f"Failed to fetch OHLCV data from NestJS API: {str(e)}")
            return None
        except Exception as e:
            self.logger.error(f"Unexpected error fetching OHLCV data: {str(e)}")
            return None
    
    def _calculate_multi_timeframe_trend_score(
        self,
        ohlcv_1d: Optional[pd.DataFrame],
        ohlcv_4h: Optional[pd.DataFrame],
        ohlcv_1h: Optional[pd.DataFrame],
        fallback_ohlcv: Optional[pd.DataFrame]
    ) -> tuple:
        """
        Calculate trend score using multi-timeframe formula:
        trend_score = 0.4*(MA50_1d vs MA200_1d) + 0.3*(MA20_4h vs MA50_4h) + 0.2*(ROC_1h) + 0.1*(structure)
        
        Args:
            ohlcv_1d: 1-day OHLCV DataFrame
            ohlcv_4h: 4-hour OHLCV DataFrame
            ohlcv_1h: 1-hour OHLCV DataFrame
            fallback_ohlcv: Fallback DataFrame if multi-timeframe data unavailable
        
        Returns:
            Tuple of (trend_score, indicators_by_timeframe)
        """
        indicators_by_timeframe = {}
        score_components = []
        
        # Component 1 (40%): MA50 vs MA200 on 1d timeframe
        if ohlcv_1d is not None and not ohlcv_1d.empty and len(ohlcv_1d) >= 200:
            indicators_1d = self._calculate_indicators(ohlcv_1d)
            indicators_by_timeframe['1d'] = indicators_1d
            
            if indicators_1d.get('ma50') and indicators_1d.get('ma200'):
                ma_comparison = (indicators_1d['ma50'] - indicators_1d['ma200']) / indicators_1d['ma200']
                ma_score = self.normalize_score(ma_comparison * 100, input_min=-10, input_max=10)
                score_components.append(('ma50_200_1d', ma_score, 0.4))
            else:
                score_components.append(('ma50_200_1d', 0.0, 0.4))
        else:
            indicators_by_timeframe['1d'] = {}
            score_components.append(('ma50_200_1d', 0.0, 0.4))
        
        # Component 2 (30%): MA20 vs MA50 on 4h timeframe
        if ohlcv_4h is not None and not ohlcv_4h.empty and len(ohlcv_4h) >= 50:
            indicators_4h = self._calculate_indicators(ohlcv_4h)
            indicators_by_timeframe['4h'] = indicators_4h
            
            if indicators_4h.get('ma20') and indicators_4h.get('ma50'):
                ma20_50_comparison = (indicators_4h['ma20'] - indicators_4h['ma50']) / indicators_4h['ma50']
                ma20_50_score = self.normalize_score(ma20_50_comparison * 100, input_min=-5, input_max=5)
                score_components.append(('ma20_50_4h', ma20_50_score, 0.3))
            else:
                score_components.append(('ma20_50_4h', 0.0, 0.3))
        else:
            indicators_by_timeframe['4h'] = {}
            score_components.append(('ma20_50_4h', 0.0, 0.3))
        
        # Component 3 (20%): ROC on 1h timeframe
        if ohlcv_1h is not None and not ohlcv_1h.empty and len(ohlcv_1h) >= 2:
            indicators_1h = self._calculate_indicators(ohlcv_1h)
            indicators_by_timeframe['1h'] = indicators_1h
            
            roc = indicators_1h.get('roc', 0.0)
            roc_score = self.normalize_score(roc, input_min=-10, input_max=10)
            score_components.append(('roc_1h', roc_score, 0.2))
        else:
            indicators_by_timeframe['1h'] = {}
            score_components.append(('roc_1h', 0.0, 0.2))
        
        # Component 4 (10%): Structure analysis (use primary timeframe or fallback)
        structure_df = ohlcv_1d if ohlcv_1d is not None else (ohlcv_4h if ohlcv_4h is not None else fallback_ohlcv)
        if structure_df is not None and not structure_df.empty:
            structure_score = self._analyze_trend_structure(structure_df)
            score_components.append(('structure', structure_score, 0.1))
        else:
            score_components.append(('structure', 0.0, 0.1))
        
        # Calculate weighted average
        total_weight = sum(weight for _, _, weight in score_components)
        if total_weight > 0:
            weighted_score = sum(score * weight for _, score, weight in score_components) / total_weight
        else:
            weighted_score = 0.0
        
        # Store primary indicators (use 1d if available, otherwise 4h, otherwise fallback)
        if ohlcv_1d is not None and not ohlcv_1d.empty:
            indicators_by_timeframe['primary'] = indicators_by_timeframe.get('1d', {})
        elif ohlcv_4h is not None and not ohlcv_4h.empty:
            indicators_by_timeframe['primary'] = indicators_by_timeframe.get('4h', {})
        elif fallback_ohlcv is not None and not fallback_ohlcv.empty:
            indicators_by_timeframe['primary'] = self._calculate_indicators(fallback_ohlcv)
        else:
            indicators_by_timeframe['primary'] = {}
        
        return self.clamp_score(weighted_score), indicators_by_timeframe
