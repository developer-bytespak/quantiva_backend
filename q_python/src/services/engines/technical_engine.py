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

from .base_engine import BaseEngine

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
            **kwargs: Additional parameters
        
        Returns:
            Dictionary with score, confidence, and metadata
        """
        try:
            if not self.validate_inputs(asset_id, asset_type):
                return self.handle_error(ValueError("Invalid inputs"), "validation")
            
            if ohlcv_data is None or ohlcv_data.empty:
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
            
            # Calculate trend score
            trend_score = self._calculate_trend_score(primary_indicators, ohlcv_data)
            
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
                'indicators': primary_indicators,
                'data_points': data_points,
                'data_freshness_hours': data_freshness,
                'timeframe': timeframe or 'default'
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
