"""
Liquidity Engine
Analyzes market liquidity based on order book depth, spread, volume, and slippage.
"""
from typing import Dict, Any, Optional
import logging

from .base_engine import BaseEngine

logger = logging.getLogger(__name__)


class LiquidityEngine(BaseEngine):
    """
    Liquidity analysis engine.
    Calculates liquidity score based on:
    - Order book depth
    - Bid-ask spread
    - Volume vs average volume
    - Slippage estimation
    - Market depth analysis
    """
    
    def __init__(self):
        super().__init__("LiquidityEngine")
    
    def calculate(
        self,
        asset_id: str,
        asset_type: str,
        timeframe: Optional[str] = None,
        order_book: Optional[Dict] = None,
        volume_24h: Optional[float] = None,
        avg_volume_30d: Optional[float] = None,
        current_price: Optional[float] = None,
        **kwargs
    ) -> Dict[str, Any]:
        """
        Calculate liquidity score.
        
        Args:
            asset_id: Asset identifier
            asset_type: 'crypto' or 'stock'
            timeframe: Optional timeframe
            order_book: Order book data with 'bids' and 'asks' arrays
            volume_24h: 24-hour volume
            avg_volume_30d: 30-day average volume
            current_price: Current market price
            **kwargs: Additional parameters
        
        Returns:
            Dictionary with score, confidence, and metadata
        """
        try:
            if not self.validate_inputs(asset_id, asset_type):
                return self.handle_error(ValueError("Invalid inputs"), "validation")

            # STOCKS — no order book available (the stock cron doesn't pre-fetch
            # an L2 book the way the crypto cron does for Binance). Use the
            # data the cron actually ships: 24h volume + current price (+ market
            # cap and avg-volume if present) and score by absolute dollar
            # liquidity. Without this branch, every stock was getting `None`
            # from the upstream check in signal_generator, which Phase 1 fixed
            # the null contract for — but no real signal was ever computed.
            if asset_type == 'stock':
                return self._calculate_stock_liquidity(
                    current_price=current_price,
                    volume_24h=volume_24h,
                    avg_volume_30d=avg_volume_30d,
                    market_cap=kwargs.get('market_cap'),
                )

            # CRYPTO path — needs the order book pre-fetch from the cron.
            if not order_book or not current_price:
                return self.handle_no_data(
                    "Order book and current price required for crypto liquidity",
                    context=f"asset_id={asset_id}",
                )

            # Calculate spread score (40% weight)
            spread_score = self._calculate_spread_score(order_book, current_price)

            # Calculate depth score (30% weight)
            depth_score = self._calculate_depth_score(order_book, current_price)

            # Calculate volume score (20% weight)
            volume_score = self._calculate_volume_score(volume_24h, avg_volume_30d)

            # Calculate slippage score (10% weight)
            slippage_score = self._calculate_slippage_score(
                order_book,
                current_price,
                volume_24h
            )

            # Weighted combination
            liquidity_score = (
                0.40 * spread_score +
                0.30 * depth_score +
                0.20 * volume_score +
                0.10 * slippage_score
            )

            # Calculate confidence
            confidence = self._calculate_confidence(
                order_book,
                volume_24h,
                avg_volume_30d
            )

            metadata = {
                'spread_score': spread_score,
                'depth_score': depth_score,
                'volume_score': volume_score,
                'slippage_score': slippage_score,
                'spread_percentage': self._get_spread_percentage(order_book, current_price),
                'order_book_depth': len(order_book.get('bids', [])) + len(order_book.get('asks', []))
            }

            return self.create_result(liquidity_score, confidence, metadata)

        except Exception as e:
            return self.handle_error(e, f"calculation for {asset_id}")

    def _calculate_stock_liquidity(
        self,
        current_price: Optional[float],
        volume_24h: Optional[float],
        avg_volume_30d: Optional[float] = None,
        market_cap: Optional[float] = None,
    ) -> Dict[str, Any]:
        """
        Compute a liquidity score for a stock from price, volume, and optional
        market cap. Order-book–free path (stock cron doesn't pre-fetch L2).

        Signals combined:
          * Absolute dollar volume — primary. Anchors around $100M/day = ~0
            (typical liquid mid-cap); log-scale so $1B = saturated +1, $1M = -1.
          * Volume burst — if 24h volume is well above 30d average, mild +.
            (Above-average activity = tighter spreads in practice.)
          * Market-cap reasonableness — if dollar volume is implausibly small
            relative to market cap (<0.01% turnover), nudge negative.

        Returns null result (handle_no_data) when price+volume are absent —
        fusion will redistribute the weight.
        """
        try:
            import math
        except ImportError:  # pragma: no cover
            math = None

        if not current_price or not volume_24h or volume_24h <= 0 or current_price <= 0:
            return self.handle_no_data(
                "Stock liquidity requires positive price and volume",
                context=f"price={current_price}, volume={volume_24h}",
            )

        dollar_volume = float(volume_24h) * float(current_price)

        # Primary: log-scale dollar volume.
        #
        # Anchor calibrated to Alpaca's IEX-only data feed (free/basic plan),
        # which reports ~2-5% of real consolidated SIP volume. Empirically:
        #   AAPL real ~$15B/day → Alpaca returns ~$400M (≈2.7%)
        #   VLO  real ~$500M    → Alpaca returns ~$24M  (≈4.8%)
        # So $10M IEX volume corresponds to roughly $100M-$500M real → neutral.
        #
        # Calibration on Alpaca-IEX:
        #   $10M   → log10(1)    = 0      (neutral / typical mid-cap)
        #   $100M  → log10(10)   = 1      (+1 capped, mega-cap)
        #   $1M    → log10(0.1)  = -1     (illiquid small-cap)
        #
        # When the data source upgrades to Alpaca SIP or Finnhub `/quote`
        # (real consolidated volume), bump this back to 100_000_000 to undo
        # the ~10x scaling.
        anchor = 10_000_000.0
        if math is not None:
            dollar_score = math.log10(max(1.0, dollar_volume) / anchor)
        else:
            # Fallback (math always available, but defensive): piecewise.
            if dollar_volume >= 1_000_000_000: dollar_score = 1.0
            elif dollar_volume >= 100_000_000: dollar_score = 0.5
            elif dollar_volume >= 10_000_000: dollar_score = 0.0
            elif dollar_volume >= 1_000_000: dollar_score = -0.5
            else: dollar_score = -1.0
        dollar_score = self.clamp_score(dollar_score, -1.0, 1.0)

        # Secondary: volume burst (24h vs 30d avg). Only applies if we have it.
        burst_score = 0.0
        burst_ratio: Optional[float] = None
        if avg_volume_30d and avg_volume_30d > 0:
            burst_ratio = float(volume_24h) / float(avg_volume_30d)
            # 1.0x = neutral, 2.0x = +0.5, 0.5x = -0.5. Capped.
            burst_score = self.clamp_score((burst_ratio - 1.0), -0.5, 0.5)

        # Tertiary: turnover sanity check. Very low turnover relative to mcap
        # is suspicious for a mid/large-cap — flag it.
        turnover_penalty = 0.0
        turnover: Optional[float] = None
        if market_cap and market_cap > 0:
            turnover = dollar_volume / float(market_cap)
            if turnover < 0.0001:  # <0.01% daily turnover
                turnover_penalty = -0.2

        # Weighted combination (dollar volume dominates; the rest nudge).
        liquidity_score = self.clamp_score(
            0.75 * dollar_score + 0.20 * burst_score + 0.05 * turnover_penalty,
            -1.0,
            1.0,
        )

        # Confidence: full data → 0.8; missing avg_volume_30d → 0.65;
        # missing market_cap as well → 0.55.
        confidence = 0.55
        if avg_volume_30d and avg_volume_30d > 0:
            confidence += 0.10
        if market_cap and market_cap > 0:
            confidence += 0.15

        metadata = {
            'method': 'stock_dollar_volume',
            'dollar_volume_usd': dollar_volume,
            'dollar_volume_score': dollar_score,
            'burst_ratio': burst_ratio,
            'burst_score': burst_score,
            'turnover': turnover,
            'turnover_penalty': turnover_penalty,
        }
        return self.create_result(liquidity_score, confidence, metadata)
    
    def _calculate_spread_score(
        self,
        order_book: Dict,
        current_price: float
    ) -> float:
        """
        Calculate spread score.
        Lower spread = higher liquidity = higher score.
        
        Args:
            order_book: Order book data
            current_price: Current market price
        
        Returns:
            Spread score in range [-1, 1]
        """
        try:
            bids = order_book.get('bids', [])
            asks = order_book.get('asks', [])
            
            if not bids or not asks:
                return 0.0
            
            best_bid = float(bids[0][0]) if isinstance(bids[0], (list, tuple)) else float(bids[0].get('price', 0))
            best_ask = float(asks[0][0]) if isinstance(asks[0], (list, tuple)) else float(asks[0].get('price', 0))
            
            if best_bid <= 0 or best_ask <= 0:
                return 0.0
            
            spread_percentage = ((best_ask - best_bid) / current_price) * 100
            
            # Normalize: spread < 0.1% = +1, spread > 2% = -1
            if spread_percentage < 0.1:
                return 1.0
            elif spread_percentage > 2.0:
                return -1.0
            else:
                # Linear interpolation
                return 1.0 - ((spread_percentage - 0.1) / 1.9) * 2
                
        except Exception as e:
            self.logger.error(f"Error calculating spread score: {str(e)}")
            return 0.0
    
    def _calculate_depth_score(
        self,
        order_book: Dict,
        current_price: float
    ) -> float:
        """
        Calculate order book depth score.
        
        Args:
            order_book: Order book data
            current_price: Current market price
        
        Returns:
            Depth score in range [-1, 1]
        """
        try:
            bids = order_book.get('bids', [])
            asks = order_book.get('asks', [])
            
            if not bids or not asks:
                return 0.0
            
            # Calculate depth at 1% from current price
            depth_1pct_bid = 0.0
            depth_1pct_ask = 0.0
            
            for bid in bids[:20]:  # Top 20 levels
                price = float(bid[0]) if isinstance(bid, (list, tuple)) else float(bid.get('price', 0))
                qty = float(bid[1]) if isinstance(bid, (list, tuple)) else float(bid.get('quantity', 0))
                if price >= current_price * 0.99:
                    depth_1pct_bid += qty
            
            for ask in asks[:20]:
                price = float(ask[0]) if isinstance(ask, (list, tuple)) else float(ask.get('price', 0))
                qty = float(ask[1]) if isinstance(ask, (list, tuple)) else float(ask.get('quantity', 0))
                if price <= current_price * 1.01:
                    depth_1pct_ask += qty
            
            total_depth = depth_1pct_bid + depth_1pct_ask
            
            # Calculate order book imbalance
            total_bid_volume = sum(
                float(bid[1]) if isinstance(bid, (list, tuple)) else float(bid.get('quantity', 0))
                for bid in bids[:20]
            )
            total_ask_volume = sum(
                float(ask[1]) if isinstance(ask, (list, tuple)) else float(ask.get('quantity', 0))
                for ask in asks[:20]
            )
            
            if total_bid_volume + total_ask_volume == 0:
                return 0.0
            
            imbalance = abs(total_bid_volume - total_ask_volume) / (total_bid_volume + total_ask_volume)
            
            # Check for large orders (potential manipulation)
            large_order_threshold = (total_bid_volume + total_ask_volume) * 0.1
            has_large_orders = False
            
            for order in bids[:5] + asks[:5]:
                qty = float(order[1]) if isinstance(order, (list, tuple)) else float(order.get('quantity', 0))
                if qty > large_order_threshold:
                    has_large_orders = True
                    break
            
            # Depth score: balanced = better
            depth_score = 1.0 - imbalance
            
            # Penalize for large orders
            if has_large_orders:
                depth_score *= 0.8
            
            # Normalize based on total depth (more depth = better)
            # This is a simplified normalization - can be improved with historical data
            depth_score = self.normalize_score(
                total_depth,
                input_min=0,
                input_max=1000000,  # Adjust based on typical market depth
                min_val=-1.0,
                max_val=1.0
            ) * depth_score
            
            return self.clamp_score(depth_score)
            
        except Exception as e:
            self.logger.error(f"Error calculating depth score: {str(e)}")
            return 0.0
    
    def _calculate_volume_score(
        self,
        volume_24h: Optional[float],
        avg_volume_30d: Optional[float]
    ) -> float:
        """
        Calculate volume score.
        Higher volume ratio = better liquidity.
        
        Args:
            volume_24h: 24-hour volume
            avg_volume_30d: 30-day average volume
        
        Returns:
            Volume score in range [-1, 1]
        """
        if not volume_24h or not avg_volume_30d or avg_volume_30d == 0:
            return 0.0
        
        volume_ratio = volume_24h / avg_volume_30d
        
        # Normalize: ratio > 1.5 = +1, ratio < 0.5 = -1
        if volume_ratio > 1.5:
            return 1.0
        elif volume_ratio < 0.5:
            return -1.0
        else:
            # Linear interpolation
            return ((volume_ratio - 0.5) / 1.0) * 2 - 1
    
    def _calculate_slippage_score(
        self,
        order_book: Dict,
        current_price: float,
        volume_24h: Optional[float]
    ) -> float:
        """
        Calculate slippage score.
        Lower slippage = higher liquidity = higher score.
        
        Args:
            order_book: Order book data
            current_price: Current market price
            volume_24h: 24-hour volume for estimating test order size
        
        Returns:
            Slippage score in range [-1, 1]
        """
        try:
            if not volume_24h or volume_24h <= 0:
                return 0.0
            
            # Estimate slippage for 1% of 24h volume
            test_order_size = volume_24h * 0.01
            
            buy_slippage = self._estimate_slippage(order_book, test_order_size, 'buy', current_price)
            sell_slippage = self._estimate_slippage(order_book, test_order_size, 'sell', current_price)
            
            avg_slippage = (buy_slippage + sell_slippage) / 2
            
            # Normalize slippage: <0.1% = +1, >2% = -1
            if avg_slippage < 0.001:  # 0.1%
                return 1.0
            elif avg_slippage > 0.02:  # 2%
                return -1.0
            else:
                # Linear interpolation
                return 1.0 - ((avg_slippage - 0.001) / 0.019) * 2
                
        except Exception as e:
            self.logger.error(f"Error calculating slippage score: {str(e)}")
            return 0.0
    
    def _estimate_slippage(
        self,
        order_book: Dict,
        order_size: float,
        side: str,
        current_price: float
    ) -> float:
        """
        Estimate slippage for a given order size.
        
        Args:
            order_book: Order book data
            order_size: Size of order
            side: 'buy' or 'sell'
            current_price: Current market price
        
        Returns:
            Estimated slippage as percentage
        """
        try:
            if side == 'buy':
                orders = order_book.get('asks', [])
            else:
                orders = order_book.get('bids', [])
            
            if not orders:
                return 0.02  # Assume 2% slippage if no data
            
            remaining_qty = order_size
            total_cost = 0.0
            
            for order in orders:
                if remaining_qty <= 0:
                    break
                
                price = float(order[0]) if isinstance(order, (list, tuple)) else float(order.get('price', current_price))
                qty = float(order[1]) if isinstance(order, (list, tuple)) else float(order.get('quantity', 0))
                
                fill_qty = min(remaining_qty, qty)
                total_cost += price * fill_qty
                remaining_qty -= fill_qty
            
            if order_size == 0:
                return 0.0
            
            avg_price = total_cost / order_size
            slippage = abs(avg_price - current_price) / current_price
            
            return slippage
            
        except Exception as e:
            self.logger.error(f"Error estimating slippage: {str(e)}")
            return 0.02  # Default to 2% slippage
    
    def _get_spread_percentage(
        self,
        order_book: Dict,
        current_price: float
    ) -> float:
        """Get bid-ask spread as percentage."""
        try:
            bids = order_book.get('bids', [])
            asks = order_book.get('asks', [])
            
            if not bids or not asks:
                return 0.0
            
            best_bid = float(bids[0][0]) if isinstance(bids[0], (list, tuple)) else float(bids[0].get('price', 0))
            best_ask = float(asks[0][0]) if isinstance(asks[0], (list, tuple)) else float(asks[0].get('price', 0))
            
            if current_price > 0:
                return ((best_ask - best_bid) / current_price) * 100
            return 0.0
        except:
            return 0.0
    
    def _calculate_confidence(
        self,
        order_book: Dict,
        volume_24h: Optional[float],
        avg_volume_30d: Optional[float]
    ) -> float:
        """Calculate confidence based on data completeness."""
        confidence_factors = []
        
        # Order book completeness
        bids = order_book.get('bids', [])
        asks = order_book.get('asks', [])
        if len(bids) >= 10 and len(asks) >= 10:
            confidence_factors.append(1.0)
        elif len(bids) >= 5 and len(asks) >= 5:
            confidence_factors.append(0.7)
        else:
            confidence_factors.append(0.4)
        
        # Volume data availability
        if volume_24h and avg_volume_30d:
            confidence_factors.append(1.0)
        elif volume_24h:
            confidence_factors.append(0.6)
        else:
            confidence_factors.append(0.3)
        
        return sum(confidence_factors) / len(confidence_factors) if confidence_factors else 0.5
