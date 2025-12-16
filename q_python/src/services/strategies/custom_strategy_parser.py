"""
Custom Strategy Parser
Parses entry/exit rules from JSON and converts them to executable format.
"""
from typing import Dict, Any, List, Optional
import logging

logger = logging.getLogger(__name__)


class CustomStrategyParser:
    """
    Parser for custom trading strategies.
    Converts JSON strategy rules into executable format.
    """
    
    def __init__(self):
        self.valid_indicators = [
            'MA20', 'MA50', 'MA200', 'RSI', 'MACD', 'ATR',
            'BB', 'STOCH', 'ADX', 'CCI', 'OBV', 'VOLUME'
        ]
        self.valid_operators = [
            '>', '<', '>=', '<=', '==', '!=',
            'cross_above', 'cross_below'
        ]
    
    def parse(self, strategy_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Parse strategy rules from JSON format.
        
        Args:
            strategy_data: Strategy data with entry_rules, exit_rules, indicators
        
        Returns:
            Parsed strategy in executable format
        """
        try:
            parsed = {
                'entry_rules': self._parse_rules(strategy_data.get('entry_rules', [])),
                'exit_rules': self._parse_rules(strategy_data.get('exit_rules', [])),
                'indicators': self._parse_indicators(strategy_data.get('indicators', [])),
                'timeframe': strategy_data.get('timeframe'),
                'stop_loss': {
                    'type': strategy_data.get('stop_loss_type'),
                    'value': strategy_data.get('stop_loss_value')
                },
                'take_profit': {
                    'type': strategy_data.get('take_profit_type'),
                    'value': strategy_data.get('take_profit_value')
                }
            }
            
            return parsed
            
        except Exception as e:
            logger.error(f"Error parsing strategy: {str(e)}")
            raise ValueError(f"Strategy parsing failed: {str(e)}")
    
    def _parse_rules(self, rules: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Parse entry or exit rules.
        
        Args:
            rules: List of rule dictionaries
        
        Returns:
            Parsed rules in executable format
        """
        parsed_rules = []
        
        for rule in rules:
            if not self._validate_rule(rule):
                raise ValueError(f"Invalid rule: {rule}")
            
            # Support both indicator-based and field-based rules
            parsed_rule = {
                'operator': rule['operator'],
                'value': float(rule['value']),
                'timeframe': rule.get('timeframe'),
                'logic': rule.get('logic', 'AND')  # Default to AND
            }
            
            # Add indicator or field based on what's present
            if 'indicator' in rule:
                parsed_rule['indicator'] = rule['indicator']
            elif 'field' in rule:
                parsed_rule['field'] = rule['field']
            
            parsed_rules.append(parsed_rule)
        
        return parsed_rules
    
    def _parse_indicators(self, indicators: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Parse indicator configurations.
        
        Args:
            indicators: List of indicator dictionaries
        
        Returns:
            Parsed indicators in executable format
        """
        parsed_indicators = []
        
        for indicator in indicators:
            if not self._validate_indicator(indicator):
                raise ValueError(f"Invalid indicator: {indicator}")
            
            parsed_indicator = {
                'name': indicator['name'],
                'parameters': indicator.get('parameters', {}),
                'timeframe': indicator.get('timeframe')
            }
            
            parsed_indicators.append(parsed_indicator)
        
        return parsed_indicators
    
    def _validate_rule(self, rule: Dict[str, Any]) -> bool:
        """Validate a single rule."""
        if not isinstance(rule, dict):
            return False
        
        # Must have operator and value
        if 'operator' not in rule or 'value' not in rule:
            return False
        
        # Must have either 'indicator' (for indicator-based rules) or 'field' (for field-based rules)
        has_indicator = 'indicator' in rule
        has_field = 'field' in rule
        
        if not (has_indicator or has_field):
            return False
        
        # If it's an indicator-based rule, validate the indicator
        if has_indicator:
            if rule['indicator'] not in self.valid_indicators:
                return False
        
        # If it's a field-based rule, validate the field path
        if has_field:
            # Allow fields like 'final_score', 'metadata.engine_details.event_risk.score', etc.
            field = rule['field']
            if not isinstance(field, str) or len(field) == 0:
                return False
        
        # Validate operator
        if rule['operator'] not in self.valid_operators:
            return False
        
        # Validate value (must be numeric)
        try:
            float(rule['value'])
        except (ValueError, TypeError):
            return False
        
        return True
    
    def _validate_indicator(self, indicator: Dict[str, Any]) -> bool:
        """Validate an indicator configuration."""
        if not isinstance(indicator, dict):
            return False
        
        if 'name' not in indicator:
            return False
        
        if indicator['name'] not in self.valid_indicators:
            return False
        
        return True
    
    def extract_indicator_requirements(self, strategy_data: Dict[str, Any]) -> List[str]:
        """
        Extract list of required indicators from strategy.
        
        Args:
            strategy_data: Strategy data
        
        Returns:
            List of required indicator names
        """
        indicators = set()
        
        # From entry rules
        for rule in strategy_data.get('entry_rules', []):
            if 'indicator' in rule:
                indicators.add(rule['indicator'])
        
        # From exit rules
        for rule in strategy_data.get('exit_rules', []):
            if 'indicator' in rule:
                indicators.add(rule['indicator'])
        
        # From indicator configs
        for indicator in strategy_data.get('indicators', []):
            if 'name' in indicator:
                indicators.add(indicator['name'])
        
        return list(indicators)
    
    def validate_syntax(self, strategy_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Validate strategy rule syntax.
        
        Args:
            strategy_data: Strategy data to validate
        
        Returns:
            Dictionary with validation result
        """
        errors = []
        
        # Validate entry rules
        for i, rule in enumerate(strategy_data.get('entry_rules', [])):
            if not self._validate_rule(rule):
                errors.append(f"Entry rule {i + 1} is invalid")
        
        # Validate exit rules
        for i, rule in enumerate(strategy_data.get('exit_rules', [])):
            if not self._validate_rule(rule):
                errors.append(f"Exit rule {i + 1} is invalid")
        
        # Validate indicators
        for i, indicator in enumerate(strategy_data.get('indicators', [])):
            if not self._validate_indicator(indicator):
                errors.append(f"Indicator {i + 1} is invalid")
        
        return {
            'valid': len(errors) == 0,
            'errors': errors
        }
