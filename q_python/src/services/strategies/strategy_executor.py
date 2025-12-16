"""
Strategy Executor
Executes strategy rules against market data and evaluates entry/exit conditions.
"""
from typing import Dict, Any, List, Optional
import logging

logger = logging.getLogger(__name__)


class StrategyExecutor:
    """
    Executes trading strategy rules against market data.
    Evaluates entry and exit conditions to determine signals.
    """
    
    def __init__(self):
        self.logger = logging.getLogger(__name__)
    
    def execute(
        self,
        strategy: Dict[str, Any],
        market_data: Dict[str, Any],
        indicators: Dict[str, float],
        engine_scores: Optional[Dict[str, Any]] = None,
        fusion_result: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """
        Execute strategy rules against market data.
        
        Args:
            strategy: Parsed strategy with entry_rules, exit_rules
            market_data: Current market data (price, volume, etc.)
            indicators: Calculated indicator values
            engine_scores: Engine scores (for field-based rules)
            fusion_result: Fusion result (for field-based rules)
        
        Returns:
            Dictionary with signal (BUY/SELL/HOLD) and details
        """
        try:
            # Evaluate entry conditions
            entry_result = self._evaluate_rules(
                strategy.get('entry_rules', []),
                indicators,
                market_data,
                engine_scores,
                fusion_result
            )
            
            # Evaluate exit conditions
            exit_result = self._evaluate_rules(
                strategy.get('exit_rules', []),
                indicators,
                market_data,
                engine_scores,
                fusion_result
            )
            
            # Determine signal
            signal = self._determine_signal(entry_result, exit_result)
            
            return {
                'signal': signal,
                'entry_conditions_met': entry_result['all_met'],
                'exit_conditions_met': exit_result['all_met'],
                'entry_details': entry_result,
                'exit_details': exit_result,
                'current_price': market_data.get('price'),
                'indicators': indicators
            }
            
        except Exception as e:
            self.logger.error(f"Error executing strategy: {str(e)}")
            return {
                'signal': 'HOLD',
                'error': str(e)
            }
    
    def _evaluate_rules(
        self,
        rules: List[Dict[str, Any]],
        indicators: Dict[str, float],
        market_data: Dict[str, Any],
        engine_scores: Optional[Dict[str, Any]] = None,
        fusion_result: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """
        Evaluate a list of rules.
        
        Args:
            rules: List of rule dictionaries
            indicators: Calculated indicator values
            market_data: Market data
            engine_scores: Engine scores (for field-based rules)
            fusion_result: Fusion result (for field-based rules)
        
        Returns:
            Evaluation result with conditions met status
        """
        if not rules:
            return {'all_met': True, 'conditions': []}
        
        conditions_met = []
        logic_operator = 'AND'  # Default
        
        for rule in rules:
            condition_met = self._evaluate_single_rule(
                rule, indicators, market_data, engine_scores, fusion_result
            )
            conditions_met.append({
                'rule': rule,
                'met': condition_met
            })
            
            # Get logic operator (AND/OR)
            if 'logic' in rule:
                logic_operator = rule['logic']
        
        # Determine if all conditions are met based on logic
        if logic_operator == 'OR':
            all_met = any(c['met'] for c in conditions_met)
        else:  # AND (default)
            all_met = all(c['met'] for c in conditions_met)
        
        return {
            'all_met': all_met,
            'conditions': conditions_met,
            'logic': logic_operator
        }
    
    def _evaluate_single_rule(
        self,
        rule: Dict[str, Any],
        indicators: Dict[str, float],
        market_data: Dict[str, Any],
        engine_scores: Optional[Dict[str, Any]] = None,
        fusion_result: Optional[Dict[str, Any]] = None
    ) -> bool:
        """
        Evaluate a single rule condition.
        
        Args:
            rule: Rule dictionary
            indicators: Indicator values
            market_data: Market data
            engine_scores: Engine scores (for field-based rules)
            fusion_result: Fusion result (for field-based rules)
        
        Returns:
            True if condition is met, False otherwise
        """
        try:
            operator = rule['operator']
            target_value = rule['value']
            
            # Support both indicator-based and field-based rules
            if 'indicator' in rule:
                # Indicator-based rule
                indicator_name = rule['indicator']
                indicator_value = indicators.get(indicator_name)
                
                if indicator_value is None:
                    self.logger.warning(f"Indicator {indicator_name} not found in data")
                    return False
                
                value_to_compare = indicator_value
                
            elif 'field' in rule:
                # Field-based rule (e.g., 'final_score', 'metadata.engine_details.event_risk.score')
                field_path = rule['field']
                value_to_compare = self._get_field_value(field_path, engine_scores, fusion_result, market_data)
                
                if value_to_compare is None:
                    self.logger.warning(f"Field {field_path} not found in data")
                    return False
            else:
                self.logger.warning(f"Rule missing both 'indicator' and 'field': {rule}")
                return False
            
            # Evaluate condition based on operator
            if operator == '>':
                return value_to_compare > target_value
            elif operator == '<':
                return value_to_compare < target_value
            elif operator == '>=':
                return value_to_compare >= target_value
            elif operator == '<=':
                return value_to_compare <= target_value
            elif operator == '==':
                return abs(value_to_compare - target_value) < 0.001  # Float comparison
            elif operator == '!=':
                return abs(value_to_compare - target_value) >= 0.001
            elif operator == 'cross_above':
                # Check if indicator crossed above target value
                # This requires historical data - simplified for now
                return value_to_compare > target_value
            elif operator == 'cross_below':
                # Check if indicator crossed below target value
                return value_to_compare < target_value
            else:
                self.logger.warning(f"Unknown operator: {operator}")
                return False
                
        except Exception as e:
            self.logger.error(f"Error evaluating rule: {str(e)}")
            return False
    
    def _get_field_value(
        self,
        field_path: str,
        engine_scores: Optional[Dict[str, Any]],
        fusion_result: Optional[Dict[str, Any]],
        market_data: Optional[Dict[str, Any]]
    ) -> Optional[float]:
        """
        Get value from nested field path.
        Supports paths like:
        - 'final_score' -> fusion_result['score'] (fusion_result uses 'score', not 'final_score')
        - 'metadata.engine_details.event_risk.score' -> engine_scores['event_risk']['score']
        
        Args:
            field_path: Dot-separated field path
            engine_scores: Engine scores dictionary
            fusion_result: Fusion result dictionary
            market_data: Market data dictionary
        
        Returns:
            Field value as float, or None if not found
        """
        try:
            parts = field_path.split('.')
            
            # Special handling for 'final_score' (fusion_result uses 'score')
            if parts[0] == 'final_score' and fusion_result:
                value = fusion_result.get('score')
                if value is not None:
                    try:
                        return float(value)
                    except (ValueError, TypeError):
                        return None
                return None
            
            # Handle 'metadata.engine_details.*' paths
            if len(parts) >= 2 and parts[0] == 'metadata' and parts[1] == 'engine_details':
                # Path like: metadata.engine_details.event_risk.score
                if len(parts) >= 4 and engine_scores:
                    engine_name = parts[2]  # e.g., 'event_risk'
                    field_name = parts[3]    # e.g., 'score'
                    
                    if engine_name in engine_scores:
                        engine_data = engine_scores[engine_name]
                        if isinstance(engine_data, dict):
                            value = engine_data.get(field_name)
                            if value is not None:
                                try:
                                    return float(value)
                                except (ValueError, TypeError):
                                    return None
                return None
            
            # Generic nested path lookup
            # Try fusion_result first
            if fusion_result and parts[0] in fusion_result:
                current = fusion_result
            # Try engine_scores
            elif engine_scores and parts[0] in engine_scores:
                current = engine_scores
            # Try market_data
            elif market_data and parts[0] in market_data:
                current = market_data
            else:
                return None
            
            # Navigate through nested structure
            for part in parts:
                if isinstance(current, dict):
                    current = current.get(part)
                else:
                    return None
                
                if current is None:
                    return None
            
            # Convert to float if possible
            if isinstance(current, (int, float)):
                return float(current)
            elif isinstance(current, str):
                try:
                    return float(current)
                except ValueError:
                    return None
            else:
                return None
                
        except Exception as e:
            self.logger.warning(f"Error getting field value for {field_path}: {str(e)}")
            return None
    
    def _determine_signal(
        self,
        entry_result: Dict[str, Any],
        exit_result: Dict[str, Any]
    ) -> str:
        """
        Determine trading signal based on entry/exit conditions.
        
        Args:
            entry_result: Entry conditions evaluation result
            exit_result: Exit conditions evaluation result
        
        Returns:
            Signal: 'BUY', 'SELL', or 'HOLD'
        """
        # If exit conditions are met, signal SELL
        if exit_result['all_met']:
            return 'SELL'
        
        # If entry conditions are met, signal BUY
        if entry_result['all_met']:
            return 'BUY'
        
        # Otherwise, HOLD
        return 'HOLD'
