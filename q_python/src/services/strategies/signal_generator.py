"""
Signal Generator
Orchestrates engine execution, applies strategy rules, and generates final signals.
"""
from typing import Dict, Any, Optional, List
import logging

from ..engines.technical_engine import TechnicalEngine
from ..engines.fundamental_engine import FundamentalEngine
from ..engines.liquidity_engine import LiquidityEngine
from ..engines.event_risk_engine import EventRiskEngine
from ..engines.fusion_engine import FusionEngine
from ..engines.confidence_engine import ConfidenceEngine
from .custom_strategy_parser import CustomStrategyParser
from .strategy_executor import StrategyExecutor

logger = logging.getLogger(__name__)


class SignalGenerator:
    """
    Orchestrates the signal generation process.
    Runs all engines, applies strategy rules, and generates final trading signals.
    """
    
    def __init__(self):
        self.logger = logging.getLogger(__name__)
        
        # Initialize engines
        self.technical_engine = TechnicalEngine()
        self.fundamental_engine = FundamentalEngine()
        self.liquidity_engine = LiquidityEngine()
        self.event_risk_engine = EventRiskEngine()
        self.fusion_engine = FusionEngine()
        self.confidence_engine = ConfidenceEngine()
        
        # Initialize strategy components
        self.parser = CustomStrategyParser()
        self.executor = StrategyExecutor()
    
    def generate_signal(
        self,
        strategy_id: str,
        asset_id: str,
        asset_type: str,
        strategy_data: Dict[str, Any],
        market_data: Dict[str, Any],
        ohlcv_data: Optional[Any] = None,
        order_book: Optional[Dict] = None,
        portfolio_value: Optional[float] = None,
        **kwargs
    ) -> Dict[str, Any]:
        """
        Generate trading signal for a strategy and asset.
        
        Args:
            strategy_id: Strategy identifier
            asset_id: Asset identifier
            asset_type: 'crypto' or 'stock'
            strategy_data: Strategy configuration (entry_rules, exit_rules, etc.)
            market_data: Market data (price, volume, etc.)
            ohlcv_data: OHLCV data for technical analysis
            order_book: Order book data for liquidity analysis
            portfolio_value: Portfolio value for position sizing
            **kwargs: Additional parameters
        
        Returns:
            Complete signal with all engine scores, final action, and position sizing
        """
        try:
            # Parse strategy
            parsed_strategy = self.parser.parse(strategy_data)
            
            # Run all engines
            engine_scores = {}
            
            # Technical Engine
            if ohlcv_data is not None:
                technical_result = self.technical_engine.calculate(
                    asset_id=asset_id,
                    asset_type=asset_type,
                    timeframe=strategy_data.get('timeframe'),
                    ohlcv_data=ohlcv_data
                )
                engine_scores['trend'] = technical_result
            else:
                engine_scores['trend'] = {'score': 0.0, 'confidence': 0.0}
            
            # Fundamental Engine
            fundamental_result = self.fundamental_engine.calculate(
                asset_id=asset_id,
                asset_type=asset_type
            )
            engine_scores['fundamental'] = fundamental_result
            
            # Liquidity Engine
            if order_book and market_data.get('price'):
                liquidity_result = self.liquidity_engine.calculate(
                    asset_id=asset_id,
                    asset_type=asset_type,
                    order_book=order_book,
                    current_price=market_data.get('price'),
                    volume_24h=market_data.get('volume_24h'),
                    avg_volume_30d=market_data.get('avg_volume_30d')
                )
                engine_scores['liquidity'] = liquidity_result
            else:
                engine_scores['liquidity'] = {'score': 0.0, 'confidence': 0.0}
            
            # Event Risk Engine
            event_risk_result = self.event_risk_engine.calculate(
                asset_id=asset_id,
                asset_type=asset_type
            )
            engine_scores['event_risk'] = event_risk_result
            
            # Fusion Engine (combines all scores)
            fusion_result = self.fusion_engine.calculate(
                asset_id=asset_id,
                asset_type=asset_type,
                engine_scores=engine_scores
            )
            
            # Extract indicator values for strategy execution
            indicators = {}
            if 'trend' in engine_scores and 'metadata' in engine_scores['trend']:
                trend_indicators = engine_scores['trend']['metadata'].get('indicators', {})
                indicators.update({
                    'MA20': trend_indicators.get('ma20'),
                    'MA50': trend_indicators.get('ma50'),
                    'MA200': trend_indicators.get('ma200'),
                    'RSI': trend_indicators.get('rsi_14'),
                    'MACD': trend_indicators.get('macd'),
                    'ATR': trend_indicators.get('atr'),
                })
            
            # Execute strategy rules
            execution_result = self.executor.execute(
                strategy=parsed_strategy,
                market_data=market_data,
                indicators=indicators
            )
            
            # Calculate confidence and position sizing
            confidence_result = None
            if portfolio_value:
                confidence_result = self.confidence_engine.calculate(
                    asset_id=asset_id,
                    asset_type=asset_type,
                    sentiment_confidence=0.5,  # Placeholder until Engine 1 is implemented
                    trend_strength=abs(engine_scores['trend'].get('score', 0.0)),
                    data_freshness=1.0,  # TODO: Calculate from data timestamps
                    diversification_weight=1.0,  # TODO: Calculate from portfolio
                    risk_level=strategy_data.get('risk_level', 'medium'),
                    portfolio_value=portfolio_value,
                    stop_loss_distance=strategy_data.get('stop_loss_value'),
                    max_allocation=0.10
                )
            
            # Build final signal
            signal = {
                'strategy_id': strategy_id,
                'asset_id': asset_id,
                'asset_type': asset_type,
                'timestamp': self._get_current_timestamp(),
                'final_score': fusion_result.get('score', 0.0),
                'action': execution_result.get('signal', 'HOLD'),
                'confidence': fusion_result.get('confidence', 0.0),
                'engine_scores': {
                    'sentiment': 0.0,  # Engine 1 not implemented
                    'trend': engine_scores['trend'].get('score', 0.0),
                    'fundamental': engine_scores['fundamental'].get('score', 0.0),
                    'liquidity': engine_scores['liquidity'].get('score', 0.0),
                    'event_risk': engine_scores['event_risk'].get('score', 0.0)
                },
                'strategy_execution': execution_result,
                'position_sizing': confidence_result,
                'metadata': {
                    'fusion_result': fusion_result,
                    'engine_details': engine_scores
                }
            }
            
            return signal
            
        except Exception as e:
            self.logger.error(f"Error generating signal: {str(e)}")
            return {
                'strategy_id': strategy_id,
                'asset_id': asset_id,
                'error': str(e),
                'action': 'HOLD'
            }
    
    def _get_current_timestamp(self) -> str:
        """Get current timestamp in ISO format."""
        from datetime import datetime
        return datetime.now().isoformat()
