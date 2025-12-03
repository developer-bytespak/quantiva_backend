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
        indicators: Dict[str, float]
    ) -> Dict[str, Any]:
        """
        Execute strategy rules against market data.
        
        Args:
            strategy: Parsed strategy with entry_rules, exit_rules
            market_data: Current market data (price, volume, etc.)
            indicators: Calculated indicator values
        
        Returns:
            Dictionary with signal (BUY/SELL/HOLD) and details
        """
        try:
            # Evaluate entry conditions
            entry_result = self._evaluate_rules(
                strategy.get('entry_rules', []),
                indicators,
                market_data
            )
            
            # Evaluate exit conditions
            exit_result = self._evaluate_rules(
                strategy.get('exit_rules', []),
                indicators,
                market_data
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
        market_data: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Evaluate a list of rules.
        
        Args:
            rules: List of rule dictionaries
            indicators: Calculated indicator values
            market_data: Market data
        
        Returns:
            Evaluation result with conditions met status
        """
        if not rules:
            return {'all_met': True, 'conditions': []}
        
        conditions_met = []
        logic_operator = 'AND'  # Default
        
        for rule in rules:
            condition_met = self._evaluate_single_rule(rule, indicators, market_data)
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
        market_data: Dict[str, Any]
    ) -> bool:
        """
        Evaluate a single rule condition.
        
        Args:
            rule: Rule dictionary
            indicators: Indicator values
            market_data: Market data
        
        Returns:
            True if condition is met, False otherwise
        """
        try:
            indicator_name = rule['indicator']
            operator = rule['operator']
            target_value = rule['value']
            
            # Get indicator value
            indicator_value = indicators.get(indicator_name)
            
            if indicator_value is None:
                self.logger.warning(f"Indicator {indicator_name} not found in data")
                return False
            
            # Evaluate condition based on operator
            if operator == '>':
                return indicator_value > target_value
            elif operator == '<':
                return indicator_value < target_value
            elif operator == '>=':
                return indicator_value >= target_value
            elif operator == '<=':
                return indicator_value <= target_value
            elif operator == '==':
                return abs(indicator_value - target_value) < 0.001  # Float comparison
            elif operator == '!=':
                return abs(indicator_value - target_value) >= 0.001
            elif operator == 'cross_above':
                # Check if indicator crossed above target value
                # This requires historical data - simplified for now
                return indicator_value > target_value
            elif operator == 'cross_below':
                # Check if indicator crossed below target value
                return indicator_value < target_value
            else:
                self.logger.warning(f"Unknown operator: {operator}")
                return False
                
        except Exception as e:
            self.logger.error(f"Error evaluating rule: {str(e)}")
            return False
    
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
