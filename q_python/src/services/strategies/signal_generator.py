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
from ..engines.options_engine import OptionsEngine
from .custom_strategy_parser import CustomStrategyParser
from .strategy_executor import StrategyExecutor

logger = logging.getLogger(__name__)


def _pass_through_engine_result(raw: Any) -> Dict[str, Any]:
    """
    Normalize a per-engine result dict for the API response.

    Engines uniformly return ``{score, confidence, metadata, engine?, timestamp?}``
    via :meth:`BaseEngine.create_result` / ``handle_no_data`` / ``handle_error``.
    Older callers downstream only read ``.score``, so we keep that key at the
    same path — but we no longer strip the rest. Key invariants:

      * ``score`` is forwarded as-is (None stays None — fusion + Prisma both
        understand null as "engine had no opinion").
      * ``metadata`` is preserved so probes can inspect engine status / error
        reasons without scraping server logs.

    If the engine slot is missing entirely from the upstream dict (engine never
    ran), we emit a clear ``status='missing'`` marker instead of an empty 0.
    """
    if not isinstance(raw, dict):
        return {'score': None, 'confidence': 0.0, 'metadata': {'status': 'missing'}}
    out: Dict[str, Any] = {'score': raw.get('score'), 'confidence': raw.get('confidence', 0.0)}
    if 'metadata' in raw:
        out['metadata'] = raw['metadata']
    # Carry through anything else the engine attached (engine name, timestamp,
    # legacy 'error' fields), without forcing a schema.
    for k, v in raw.items():
        if k not in out:
            out[k] = v
    return out


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
        self.options_engine = OptionsEngine()
        
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
            
            # Check if we should skip external API calls (for testing with DB data)
            skip_external_apis = kwargs.get('skip_external_apis', False)
            
            # Run all engines
            engine_scores = {}
            
            # Technical Engine
            # Forward connection info so TechnicalEngine can fetch OHLCV from NestJS when available.
            connection_id = kwargs.get('connection_id')
            exchange = kwargs.get('exchange', 'binance')
            # Use asset_symbol if provided (for OHLCV fetching), otherwise use asset_id
            asset_symbol = kwargs.get('asset_symbol', asset_id)

            technical_result = self.technical_engine.calculate(
                asset_id=asset_id,
                asset_type=asset_type,
                timeframe=strategy_data.get('timeframe'),
                ohlcv_data=ohlcv_data,
                connection_id=connection_id,
                exchange=exchange,
                asset_symbol=asset_symbol  # Pass symbol for OHLCV fetching
            )
            # When the engine has no data (e.g. OHLCV unavailable because coin
            # isn't on Binance), return score=None so fusion EXCLUDES this
            # engine and redistributes its weight to the engines that did
            # have data. Coercing to 0.0 silently drags strategies (especially
            # Trend + Sentiment) below their BUY threshold even when the
            # engines that DID work all said BUY.
            engine_scores['trend'] = technical_result if technical_result is not None else {'score': None, 'confidence': 0.0}
            
            # Fundamental Engine
            # Pass asset_symbol for external API calls (CoinGecko, LunarCrush need symbols, not UUIDs)
            # Skip if skip_external_apis is True (for testing with DB data only)
            if skip_external_apis:
                engine_scores['fundamental'] = {
                    'score': 0.0, 
                    'confidence': 0.0, 
                    'metadata': {'skipped': True, 'reason': 'skip_external_apis=True'}
                }
            else:
                try:
                    fundamental_result = self.fundamental_engine.calculate(
                        asset_id=asset_id,
                        asset_type=asset_type,
                        asset_symbol=asset_symbol  # Pass symbol for external API calls
                    )
                    # See trend-engine comment above — null when no data, not 0.
                    engine_scores['fundamental'] = fundamental_result if fundamental_result is not None else {'score': None, 'confidence': 0.0}
                except Exception as e:
                    logger.warning(f"Fundamental engine error for {asset_symbol} (asset_id: {asset_id}): {str(e)}")
                    engine_scores['fundamental'] = {'score': None, 'confidence': 0.0, 'error': True, 'error_message': str(e)}
            
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
                # No order_book passed → engine has no data. Return score=None
                # so fusion redistributes its weight to engines that have data,
                # instead of dragging the final score toward 0.
                engine_scores['liquidity'] = {'score': None, 'confidence': 0.0}
            
            # Event Risk Engine
            # Pass asset_symbol for external API calls (LunarCrush needs symbols, not UUIDs)
            # Skip if skip_external_apis is True (for testing with DB data only)
            if skip_external_apis:
                engine_scores['event_risk'] = {
                    'score': 0.0, 
                    'confidence': 0.0, 
                    'metadata': {'skipped': True, 'reason': 'skip_external_apis=True'}
                }
            else:
                event_risk_result = self.event_risk_engine.calculate(
                    asset_id=asset_id,
                    asset_type=asset_type,
                    asset_symbol=asset_symbol  # Pass symbol for external API calls
                )
                engine_scores['event_risk'] = event_risk_result
            
            # Sentiment Engine
            # Extract text_data from kwargs if provided
            # Also pass connection_id, exchange, and asset_symbol for MarketSignalAnalyzer to fetch OHLCV
            text_data = kwargs.get('text_data', None)
            sentiment_result = self.sentiment_engine.calculate(
                asset_id=asset_id,
                asset_type=asset_type,
                timeframe=strategy_data.get('timeframe'),
                text_data=text_data,
                connection_id=connection_id,
                exchange=exchange,
                asset_symbol=asset_symbol  # Pass symbol for OHLCV fetching
            )
            engine_scores['sentiment'] = sentiment_result
            
            # Fusion Engine (combines all scores).
            # Pull the strategy's per-engine weights and any optional BUY/SELL
            # threshold overrides out of strategy_data so each strategy
            # actually uses its own profile (instead of the default one).
            # Without this, all strategies collapse onto the same fusion math.
            strategy_weights = strategy_data.get('engine_weights')
            strategy_buy_threshold = strategy_data.get('buy_threshold')
            strategy_sell_threshold = strategy_data.get('sell_threshold')

            fusion_result = self.fusion_engine.calculate(
                asset_id=asset_id,
                asset_type=asset_type,
                engine_scores=engine_scores,
                weights=strategy_weights,
                buy_threshold=strategy_buy_threshold,
                sell_threshold=strategy_sell_threshold,
            )
            
            # Extract indicator values for strategy execution
            indicators = {}
            if 'trend' in engine_scores and 'metadata' in engine_scores['trend']:
                trend_meta = engine_scores['trend']['metadata']
                trend_indicators = trend_meta.get('indicators', {})

                # If primary indicators are empty, try timeframe-specific ones as fallback
                if not any(v is not None for v in trend_indicators.values()):
                    timeframes = trend_meta.get('timeframes', {})
                    for tf in ['1d', '4h', '1h']:
                        tf_indicators = timeframes.get(tf, {})
                        if tf_indicators and any(v is not None for v in tf_indicators.values()):
                            self.logger.info(f"Using {tf} timeframe indicators as fallback (primary empty)")
                            trend_indicators = tf_indicators
                            break

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
                # Check if the executor could actually evaluate the rules.
                # `all_skipped` now reflects BOTH missing indicators (e.g.,
                # no OHLCV) AND missing field paths (e.g., a broken
                # `metadata.engine_details.*` dotted path). Without this
                # fallback, a broken field path would silently produce HOLD.
                entry_details = execution_result.get('entry_details', {})
                exit_details = execution_result.get('exit_details', {})

                entry_all_skipped = entry_details.get('all_skipped', False)
                exit_no_rules = exit_details.get('no_rules', False)
                exit_all_skipped = exit_details.get('all_skipped', False)

                if entry_all_skipped and (exit_no_rules or exit_all_skipped):
                    # All rules were unevaluable (indicator or field data missing)
                    # Fall back to fusion engine decision instead of guaranteed HOLD
                    final_action = fusion_result.get('action', 'HOLD')
                    self.logger.warning(
                        f"Strategy {strategy_id}: All rules unevaluable (indicator or field data missing). "
                        f"Falling back to fusion engine action: {final_action}"
                    )
                else:
                    # Strategy rules were evaluable - use executor's decision
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
                    # `or 0.0` guards against engine_scores['trend']['score'] being
                    # None when the trend engine had no data — abs(None) would crash.
                    trend_strength=abs(engine_scores['trend'].get('score') or 0.0),
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
                # NOTE: engine_scores preserves the full engine output (score,
                # confidence, metadata) for every engine. Two contracts the
                # downstream (NestJS noticeboard + LLM explainer) rely on:
                #   1. `score` is forwarded as-is — None stays None. The old
                #      `... or 0.0` clobbered "engine couldn't compute" into
                #      a real 0.0, breaking fusion's null-aware re-normalization
                #      AND making probes incapable of telling apart "engine
                #      returned 0" from "engine had no data".
                #   2. `metadata` is preserved so probes can see status / error /
                #      reason without parsing logs (e.g. `status='no_data',
                #      reason='News API 429'`).
                'engine_scores': {
                    eng: _pass_through_engine_result(engine_scores.get(eng))
                    for eng in ('sentiment', 'trend', 'fundamental', 'liquidity', 'event_risk')
                },
                'strategy_execution': execution_result,
                'position_sizing': confidence_result,
                'metadata': {
                    'fusion_result': fusion_result,
                    'engine_details': engine_scores
                }
            }
            
            # Optional: generate options recommendation if options_chain provided
            options_chain = kwargs.get('options_chain')
            if options_chain and final_action in ('BUY', 'SELL'):
                try:
                    options_result = self.options_engine.calculate(
                        asset_id=asset_id,
                        asset_type=asset_type,
                        timeframe=strategy_data.get('timeframe', '1d'),
                        signal={
                            'action': final_action,
                            'final_score': float(fusion_score) if fusion_score else 0.0,
                            'confidence': float(fusion_confidence) if fusion_confidence else 0.0,
                            'risk_level': strategy_data.get('risk_level', 'medium'),
                            'timeframe': strategy_data.get('timeframe', '1d'),
                        },
                        options_chain=options_chain,
                        portfolio_value=portfolio_value,
                    )
                    signal['options_recommendation'] = options_result.get('recommendation')
                except Exception as opt_err:
                    self.logger.warning(f"Options engine error (non-fatal): {opt_err}")
                    signal['options_recommendation'] = None
            
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
