"""
Market Data Service
Fetches OHLCV, order book, and volume data from exchanges.
TODO: Integrate with Binance/Bybit exchange services.
"""
from typing import Dict, Any, Optional, List
import pandas as pd
import logging
import requests
import os
from datetime import datetime, timedelta
from src.config import NESTJS_API_URL, NESTJS_API_TIMEOUT

logger = logging.getLogger(__name__)


class MarketDataService:
    """
    Service for fetching market data from exchanges.
    Provides OHLCV data, order book data, and volume statistics.
    """
    
    def __init__(self):
        self.logger = logging.getLogger(__name__)
        # TODO: Initialize exchange API clients (Binance, Bybit)
        # self.binance_client = None
        # self.bybit_client = None
    
    def fetch_ohlcv(
        self,
        symbol: str,
        exchange: str = 'binance',
        interval: str = '1h',
        limit: int = 200
    ) -> Optional[pd.DataFrame]:
        """
        Fetch OHLCV (Open, High, Low, Close, Volume) data.
        
        Args:
            symbol: Trading pair symbol (e.g., 'BTCUSDT')
            exchange: Exchange name ('binance' or 'bybit')
            interval: Timeframe ('1m', '5m', '15m', '1h', '4h', '1d', etc.)
            limit: Number of candles to fetch
        
        Returns:
            DataFrame with columns: open, high, low, close, volume, timestamp
        """
        try:
            # Prefer fetching OHLCV from NestJS backend if available
            connection_id = os.getenv('NESTJS_DEFAULT_CONNECTION_ID')

            # Convert simple symbol (e.g., 'BTC') to trading pair 'BTCUSDT' if needed
            pair = symbol.upper()
            if not pair.endswith('USDT') and len(pair) <= 5:
                pair = f"{pair}USDT"

            if not connection_id:
                self.logger.debug(
                    "NESTJS_DEFAULT_CONNECTION_ID not set; MarketDataService cannot fetch OHLCV from NestJS."
                )
                return pd.DataFrame(columns=['open', 'high', 'low', 'close', 'volume', 'timestamp'])

            url = f"{NESTJS_API_URL}/exchanges/connections/{connection_id}/candles/{pair}"
            params = {
                'interval': interval,
                'limit': str(limit)
            }

            self.logger.info(f"Fetching OHLCV from NestJS: {url} params={params}")
            resp = requests.get(url, params=params, timeout=int(NESTJS_API_TIMEOUT))
            resp.raise_for_status()

            data = resp.json()
            if not data:
                self.logger.warning(f"Empty response fetching OHLCV for {pair}")
                return pd.DataFrame(columns=['open', 'high', 'low', 'close', 'volume', 'timestamp'])

            # NestJS endpoints return { success: true, data: [...] }
            candles = None
            if isinstance(data, dict) and data.get('success') and data.get('data'):
                candles = data.get('data')
            elif isinstance(data, dict) and data.get('data'):
                candles = data.get('data')
            elif isinstance(data, list):
                candles = data

            if not candles:
                self.logger.warning(f"No candle data for {pair}")
                return pd.DataFrame(columns=['open', 'high', 'low', 'close', 'volume', 'timestamp'])

            # Normalize to DataFrame
            df = pd.DataFrame(candles)

            # Expecting fields: openTime/open, high, low, close, volume
            if 'openTime' in df.columns:
                df['timestamp'] = pd.to_datetime(df['openTime'], unit='ms')
            elif 'timestamp' in df.columns:
                df['timestamp'] = pd.to_datetime(df['timestamp'], unit='ms')
            else:
                df['timestamp'] = pd.to_datetime(df.index)

            # Ensure numeric columns
            for col in ['open', 'high', 'low', 'close', 'volume']:
                if col in df.columns:
                    df[col] = pd.to_numeric(df[col], errors='coerce').fillna(0)
                else:
                    df[col] = 0

            return df[['open', 'high', 'low', 'close', 'volume', 'timestamp']]

        except Exception as e:
            self.logger.error(f"Error fetching OHLCV data from NestJS: {str(e)}", exc_info=True)
            return pd.DataFrame(columns=['open', 'high', 'low', 'close', 'volume', 'timestamp'])
    
    def fetch_order_book(
        self,
        symbol: str,
        exchange: str = 'binance',
        limit: int = 100
    ) -> Optional[Dict[str, Any]]:
        """
        Fetch order book data.
        
        Args:
            symbol: Trading pair symbol
            exchange: Exchange name
            limit: Number of price levels to fetch
        
        Returns:
            Dictionary with 'bids' and 'asks' arrays
        """
        try:
            # TODO: Implement actual exchange API calls
            # if exchange == 'binance':
            #     return self._fetch_binance_orderbook(symbol, limit)
            # elif exchange == 'bybit':
            #     return self._fetch_bybit_orderbook(symbol, limit)
            
            self.logger.warning(
                f"Order book fetching not yet implemented. "
                f"TODO: Integrate {exchange} API for {symbol}"
            )
            
            return {
                'bids': [],
                'asks': []
            }
            
        except Exception as e:
            self.logger.error(f"Error fetching order book: {str(e)}")
            return None
    
    def fetch_24h_ticker(
        self,
        symbol: str,
        exchange: str = 'binance'
    ) -> Optional[Dict[str, Any]]:
        """
        Fetch 24-hour ticker statistics.
        
        Args:
            symbol: Trading pair symbol
            exchange: Exchange name
        
        Returns:
            Dictionary with price, volume, and other statistics
        """
        try:
            # TODO: Implement actual exchange API calls
            self.logger.warning(
                f"24h ticker fetching not yet implemented. "
                f"TODO: Integrate {exchange} API for {symbol}"
            )
            
            return {
                'price': 0.0,
                'volume_24h': 0.0,
                'high_24h': 0.0,
                'low_24h': 0.0,
                'change_24h': 0.0
            }
            
        except Exception as e:
            self.logger.error(f"Error fetching 24h ticker: {str(e)}")
            return None
    
    def calculate_avg_volume(
        self,
        symbol: str,
        exchange: str = 'binance',
        days: int = 30
    ) -> Optional[float]:
        """
        Calculate average volume over specified days.
        
        Args:
            symbol: Trading pair symbol
            exchange: Exchange name
            days: Number of days to average
        
        Returns:
            Average volume
        """
        try:
            # Fetch daily candles for the period
            ohlcv = self.fetch_ohlcv(symbol, exchange, interval='1d', limit=days)
            
            if ohlcv is None or ohlcv.empty:
                return None
            
            # Calculate average volume
            avg_volume = ohlcv['volume'].mean()
            return float(avg_volume)
            
        except Exception as e:
            self.logger.error(f"Error calculating average volume: {str(e)}")
            return None
    
    # TODO: Implement these methods when exchange APIs are integrated
    # def _fetch_binance_ohlcv(self, symbol: str, interval: str, limit: int) -> pd.DataFrame:
    #     """Fetch OHLCV from Binance API."""
    #     pass
    #
    # def _fetch_bybit_ohlcv(self, symbol: str, interval: str, limit: int) -> pd.DataFrame:
    #     """Fetch OHLCV from Bybit API."""
    #     pass
    #
    # def _fetch_binance_orderbook(self, symbol: str, limit: int) -> Dict[str, Any]:
    #     """Fetch order book from Binance API."""
    #     pass
    #
    # def _fetch_bybit_orderbook(self, symbol: str, limit: int) -> Dict[str, Any]:
    #     """Fetch order book from Bybit API."""
    #     pass

