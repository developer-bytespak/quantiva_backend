"""
Market Signal Analyzer
Analyzes market data (price momentum, volume, social metrics) for sentiment confirmation.
Fetches OHLCV data from NestJS backend API.
"""
import logging
import requests
from typing import Dict, Any, Optional
from datetime import datetime, timedelta

from src.config import NESTJS_API_URL, NESTJS_API_TIMEOUT

logger = logging.getLogger(__name__)


class MarketSignalAnalyzer:
    """
    Analyzes market signals (price momentum, volume, social metrics) for sentiment confirmation.
    Fetches OHLCV data from NestJS backend exchange APIs.
    """
    
    def __init__(self):
        """Initialize market signal analyzer."""
        self.logger = logging.getLogger(__name__)
        self.nestjs_api_url = NESTJS_API_URL
        self.api_timeout = NESTJS_API_TIMEOUT
        self._lunarcrush_service = None  # Lazy initialization to avoid import issues
    
    def analyze(
        self,
        symbol: str,
        asset_type: str,
        exchange: str = 'binance',
        connection_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Analyze market signals for sentiment confirmation.
        
        Args:
            symbol: Asset symbol (e.g., 'BTC', 'ETH')
            asset_type: 'crypto' or 'stock'
            exchange: Exchange name ('binance' or 'bybit')
            connection_id: Optional connection ID for NestJS API (if None, will try to use default or skip)
        
        Returns:
            Dictionary with:
                - score: float in range [-1.0, 1.0]
                - confidence: float in range [0.0, 1.0]
                - signals: dict with individual signal breakdowns
        """
        if asset_type != 'crypto':
            # For stocks, return neutral for now (can be enhanced later)
            return {
                'score': 0.0,
                'confidence': 0.0,
                'signals': {
                    'note': 'Market signals not implemented for stocks yet'
                }
            }
        
        try:
            # Fetch OHLCV data from NestJS API
            ohlcv_data = self._fetch_ohlcv(symbol, exchange, connection_id)
            
            # Fetch LunarCrush social metrics (lazy import)
            if self._lunarcrush_service is None:
                from src.services.data.lunarcrush_service import LunarCrushService
                self._lunarcrush_service = LunarCrushService()
            social_metrics = self._lunarcrush_service.fetch_social_metrics(symbol)
            
            # Analyze price momentum
            momentum_score = self._analyze_price_momentum(ohlcv_data)
            
            # Analyze volume
            volume_score = self._analyze_volume(ohlcv_data, social_metrics)
            
            # Analyze social metrics
            social_score = self._analyze_social_metrics(social_metrics)
            
            # Combine signals (weighted average)
            # Momentum: 40%, Volume: 30%, Social: 30%
            final_score = (
                0.40 * momentum_score +
                0.30 * volume_score +
                0.30 * social_score
            )
            
            # Clamp to [-1.0, 1.0]
            final_score = max(-1.0, min(1.0, final_score))
            
            # Calculate confidence based on data availability
            confidence = self._calculate_confidence(ohlcv_data, social_metrics)
            
            return {
                'score': final_score,
                'confidence': confidence,
                'signals': {
                    'momentum': momentum_score,
                    'volume': volume_score,
                    'social': social_score,
                    'ohlcv_available': ohlcv_data is not None and len(ohlcv_data) > 0,
                    'social_available': bool(social_metrics)
                }
            }
            
        except Exception as e:
            self.logger.error(f"Error analyzing market signals for {symbol}: {str(e)}", exc_info=True)
            return {
                'score': 0.0,
                'confidence': 0.0,
                'signals': {
                    'error': str(e),
                    'note': 'Market signal analysis failed'
                }
            }
    
    def _fetch_ohlcv(
        self,
        symbol: str,
        exchange: str,
        connection_id: Optional[str]
    ) -> Optional[list]:
        """
        Fetch OHLCV data from NestJS API.
        
        Args:
            symbol: Asset symbol (e.g., 'BTC')
            exchange: Exchange name
            connection_id: Optional connection ID
        
        Returns:
            List of candlestick data or None if failed
        """
        # If no connection_id, we can't fetch data (graceful degradation)
        if not connection_id:
            self.logger.warning(
                f"No connection_id provided for {symbol}, skipping OHLCV fetch. "
                "Market signals will use LunarCrush data only."
            )
            return None
        
        try:
            # Convert symbol to trading pair format (e.g., BTC -> BTCUSDT)
            trading_pair = f"{symbol.upper()}USDT"
            
            # Fetch 1h candles for momentum analysis (need at least 4 hours)
            url = f"{self.nestjs_api_url}/exchanges/connections/{connection_id}/candles/{trading_pair}"
            params = {
                'interval': '1h',
                'limit': '24'  # 24 hours of data
            }
            
            self.logger.info(f"Fetching OHLCV data for {symbol} from NestJS API...")
            response = requests.get(url, params=params, timeout=self.api_timeout)
            response.raise_for_status()
            
            data = response.json()
            
            if data.get('success') and data.get('data'):
                candles = data['data']
                self.logger.info(f"Fetched {len(candles)} candles for {symbol}")
                return candles
            else:
                self.logger.warning(f"No OHLCV data returned for {symbol}")
                return None
                
        except requests.exceptions.RequestException as e:
            self.logger.warning(f"Failed to fetch OHLCV data from NestJS API: {str(e)}")
            return None
        except Exception as e:
            self.logger.error(f"Unexpected error fetching OHLCV data: {str(e)}")
            return None
    
    def _analyze_price_momentum(self, ohlcv_data: Optional[list]) -> float:
        """
        Analyze price momentum from OHLCV data.
        
        Args:
            ohlcv_data: List of candlestick data with open, high, low, close, volume
        
        Returns:
            Momentum score in range [-1.0, 1.0]
        """
        if not ohlcv_data or len(ohlcv_data) < 4:
            return 0.0
        
        try:
            # Get latest candles
            candles = sorted(ohlcv_data, key=lambda x: x.get('openTime', 0))
            
            if len(candles) < 4:
                return 0.0
            
            # Current price (latest close)
            current_price = candles[-1].get('close', 0)
            
            # Price 1 hour ago
            price_1h_ago = candles[-2].get('close', 0) if len(candles) >= 2 else current_price
            
            # Price 4 hours ago
            price_4h_ago = candles[-5].get('close', 0) if len(candles) >= 5 else current_price
            
            if current_price == 0 or price_1h_ago == 0:
                return 0.0
            
            # Calculate percentage changes
            change_1h = ((current_price - price_1h_ago) / price_1h_ago) * 100 if price_1h_ago > 0 else 0.0
            change_4h = ((current_price - price_4h_ago) / price_4h_ago) * 100 if price_4h_ago > 0 else 0.0
            
            # Weighted momentum: 1h (60%) + 4h (40%)
            momentum = (0.6 * change_1h + 0.4 * change_4h) / 10.0  # Normalize to [-1, 1] range
            
            # Clamp to [-1.0, 1.0]
            return max(-1.0, min(1.0, momentum))
            
        except Exception as e:
            self.logger.error(f"Error analyzing price momentum: {str(e)}")
            return 0.0
    
    def _analyze_volume(self, ohlcv_data: Optional[list], social_metrics: Dict[str, Any]) -> float:
        """
        Analyze volume spike.
        
        Args:
            ohlcv_data: OHLCV data
            social_metrics: LunarCrush social metrics
        
        Returns:
            Volume score in range [-1.0, 1.0]
        """
        # Use LunarCrush volume_24h if available
        volume_24h = social_metrics.get('volume_24h', 0)
        
        if volume_24h > 0 and ohlcv_data:
            try:
                # Calculate average volume from OHLCV
                volumes = [c.get('volume', 0) for c in ohlcv_data if c.get('volume', 0) > 0]
                if volumes:
                    avg_volume = sum(volumes) / len(volumes)
                    current_volume = volumes[-1] if volumes else 0
                    
                    if avg_volume > 0:
                        # Volume spike ratio
                        volume_ratio = current_volume / avg_volume
                        
                        # Normalize: 1.0 = normal, >1.5 = spike (positive), <0.7 = low (negative)
                        if volume_ratio >= 1.5:
                            score = min(1.0, (volume_ratio - 1.5) / 1.0)  # 1.5-2.5 maps to 0-1.0
                        elif volume_ratio <= 0.7:
                            score = max(-1.0, (volume_ratio - 0.7) / 0.7)  # 0-0.7 maps to -1.0-0
                        else:
                            score = 0.0  # Normal volume
                        
                        return max(-1.0, min(1.0, score))
            except Exception as e:
                self.logger.error(f"Error analyzing volume: {str(e)}")
        
        # Fallback: use LunarCrush price_change_24h as proxy
        price_change = social_metrics.get('price_change_24h', 0)
        if price_change != 0:
            # Normalize price change to [-1, 1] (assuming ±10% is significant)
            return max(-1.0, min(1.0, price_change / 10.0))
        
        return 0.0
    
    def _analyze_social_metrics(self, social_metrics: Dict[str, Any]) -> float:
        """
        Analyze social metrics from LunarCrush.
        
        Args:
            social_metrics: LunarCrush social metrics
        
        Returns:
            Social score in range [-1.0, 1.0]
        """
        if not social_metrics:
            return 0.0
        
        try:
            # Use price_change_24h as primary signal
            price_change = social_metrics.get('price_change_24h', 0)
            
            # Normalize to [-1, 1] (assuming ±10% is significant)
            score = max(-1.0, min(1.0, price_change / 10.0))
            
            return score
            
        except Exception as e:
            self.logger.error(f"Error analyzing social metrics: {str(e)}")
            return 0.0
    
    def _calculate_confidence(
        self,
        ohlcv_data: Optional[list],
        social_metrics: Dict[str, Any]
    ) -> float:
        """
        Calculate confidence based on data availability.
        
        Args:
            ohlcv_data: OHLCV data
            social_metrics: Social metrics
        
        Returns:
            Confidence in range [0.0, 1.0]
        """
        has_ohlcv = ohlcv_data is not None and len(ohlcv_data) > 0
        has_social = bool(social_metrics)
        
        if has_ohlcv and has_social:
            return 0.8
        elif has_ohlcv or has_social:
            return 0.5
        else:
            return 0.2

