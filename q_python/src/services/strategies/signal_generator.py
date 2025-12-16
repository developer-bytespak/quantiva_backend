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
from ..engines.sentiment_engine import SentimentEngine
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
        self.sentiment_engine = SentimentEngine()
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
            
            # Sentiment Engine
            # Extract text_data from kwargs if provided
            text_data = kwargs.get('text_data', None)
            sentiment_result = self.sentiment_engine.calculate(
                asset_id=asset_id,
                asset_type=asset_type,
                timeframe=strategy_data.get('timeframe'),
                text_data=text_data
            )
            engine_scores['sentiment'] = sentiment_result
            
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
            
            # Execute strategy rules (pass engine_scores and fusion_result for field-based rules)
            execution_result = self.executor.execute(
                strategy=parsed_strategy,
                market_data=market_data,
                indicators=indicators,
                engine_scores=engine_scores,
                fusion_result=fusion_result
            )
            
            # Determine final action: Use fusion engine action if no strategy rules,
            # otherwise use strategy executor action (which can override fusion)
            entry_rules = strategy_data.get('entry_rules', [])
            exit_rules = strategy_data.get('exit_rules', [])
            has_strategy_rules = (entry_rules and len(entry_rules) > 0) or (exit_rules and len(exit_rules) > 0)
            
            if has_strategy_rules:
                # Strategy has rules - use executor's decision (may override fusion)
                final_action = execution_result.get('signal', fusion_result.get('action', 'HOLD'))
            else:
                # No strategy rules - use fusion engine's action decision
                final_action = fusion_result.get('action', 'HOLD')
            
            # Calculate confidence and position sizing
            confidence_result = None
            if portfolio_value:
                # Get actual sentiment confidence
                sentiment_confidence = engine_scores.get('sentiment', {}).get('confidence', 0.5)
                
                confidence_result = self.confidence_engine.calculate(
                    asset_id=asset_id,
                    asset_type=asset_type,
                    sentiment_confidence=sentiment_confidence,
                    trend_strength=abs(engine_scores['trend'].get('score', 0.0)),
                    data_freshness=1.0,  # TODO: Calculate from data timestamps
                    diversification_weight=1.0,  # TODO: Calculate from portfolio
                    risk_level=strategy_data.get('risk_level', 'medium'),
                    portfolio_value=portfolio_value,
                    stop_loss_distance=strategy_data.get('stop_loss_value'),
                    max_allocation=0.10
                )
            
            # Adjust confidence based on available data
            # Reduce confidence if critical engines are missing data
            base_confidence = fusion_result.get('confidence', 0.0)
            has_technical_data = ohlcv_data is not None
            has_liquidity_data = order_book is not None and market_data.get('price') is not None
            
            # Penalize confidence if engines are missing data
            confidence_penalty = 0.0
            if not has_technical_data:
                confidence_penalty += 0.1  # 10% penalty for missing technical data
            if not has_liquidity_data:
                confidence_penalty += 0.05  # 5% penalty for missing liquidity data
            
            adjusted_confidence = max(0.0, min(1.0, base_confidence - confidence_penalty))
            
            # Ensure fusion_result has a score (handle error cases)
            fusion_score = 0.0
            if isinstance(fusion_result, dict) and 'score' in fusion_result:
                fusion_score = fusion_result.get('score', 0.0)
            elif isinstance(fusion_result, dict) and 'error' in fusion_result:
                # Fusion engine returned an error, use default score
                fusion_score = 0.0
                self.logger.warning(f"Fusion engine returned error, using default score: {fusion_result.get('error', 'Unknown error')}")
            
            # Ensure confidence is a number
            fusion_confidence = adjusted_confidence if adjusted_confidence is not None else 0.0
            
            # Build final signal
            signal = {
                'strategy_id': strategy_id,
                'asset_id': asset_id,
                'asset_type': asset_type,
                'timestamp': self._get_current_timestamp(),
                'final_score': float(fusion_score) if fusion_score is not None else 0.0,
                'action': final_action,
                'confidence': float(fusion_confidence) if fusion_confidence is not None else 0.0,
                'engine_scores': {
                    'sentiment': {'score': float(engine_scores.get('sentiment', {}).get('score', 0.0) or 0.0)},
                    'trend': {'score': float(engine_scores.get('trend', {}).get('score', 0.0) or 0.0)},
                    'fundamental': {'score': float(engine_scores.get('fundamental', {}).get('score', 0.0) or 0.0)},
                    'liquidity': {'score': float(engine_scores.get('liquidity', {}).get('score', 0.0) or 0.0)},
                    'event_risk': {'score': float(engine_scores.get('event_risk', {}).get('score', 0.0) or 0.0)}
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
            # Return a proper signal structure even on error
            return {
                'strategy_id': strategy_id,
                'asset_id': asset_id,
                'asset_type': asset_type,
                'timestamp': self._get_current_timestamp(),
                'final_score': 0.0,
                'action': 'HOLD',
                'confidence': 0.0,
                'engine_scores': {
                    'sentiment': {'score': 0.0},
                    'trend': {'score': 0.0},
                    'fundamental': {'score': 0.0},
                    'liquidity': {'score': 0.0},
                    'event_risk': {'score': 0.0}
                },
                'error': str(e),
                'metadata': {
                    'error': True,
                    'error_message': str(e)
                }
            }
    
    def _get_current_timestamp(self) -> str:
        """Get current timestamp in ISO format."""
        from datetime import datetime
        return datetime.now().isoformat()
