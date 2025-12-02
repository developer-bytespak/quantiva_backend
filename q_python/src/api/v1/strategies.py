"""
Strategy API endpoints for validation, parsing, and signal generation.
"""
from fastapi import APIRouter, HTTPException, Body
from typing import Dict, Any, Optional
import logging

from src.services.strategies.custom_strategy_parser import CustomStrategyParser
from src.services.strategies.strategy_executor import StrategyExecutor

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/strategies", tags=["Strategies"])

parser = CustomStrategyParser()
executor = StrategyExecutor()


@router.post("/validate")
async def validate_strategy(strategy_data: Dict[str, Any] = Body(...)):
    """
    Validate strategy rules syntax.
    
    Request body:
    {
        "entry_rules": [...],
        "exit_rules": [...],
        "indicators": [...]
    }
    
    Returns:
    {
        "valid": bool,
        "errors": [...]
    }
    """
    try:
        validation_result = parser.validate_syntax(strategy_data)
        return validation_result
    except Exception as e:
        logger.error(f"Error validating strategy: {str(e)}")
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/parse")
async def parse_strategy(strategy_data: Dict[str, Any] = Body(...)):
    """
    Parse strategy rules from JSON to executable format.
    
    Request body:
    {
        "entry_rules": [...],
        "exit_rules": [...],
        "indicators": [...],
        "timeframe": "...",
        "stop_loss_type": "...",
        "stop_loss_value": ...,
        "take_profit_type": "...",
        "take_profit_value": ...
    }
    
    Returns:
    Parsed strategy in executable format
    """
    try:
        parsed_strategy = parser.parse(strategy_data)
        return {
            "success": True,
            "parsed_strategy": parsed_strategy,
            "required_indicators": parser.extract_indicator_requirements(strategy_data)
        }
    except ValueError as e:
        logger.error(f"Error parsing strategy: {str(e)}")
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Unexpected error parsing strategy: {str(e)}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.post("/generate-signal")
async def generate_signal(request_data: Dict[str, Any] = Body(...)):
    """
    Generate signal for a strategy and asset.
    
    Request body:
    {
        "strategy_id": "...",
        "asset_id": "...",
        "asset_type": "crypto" | "stock",
        "strategy_data": {
            "entry_rules": [...],
            "exit_rules": [...],
            "indicators": [...],
            ...
        },
        "market_data": {
            "price": ...,
            "volume_24h": ...,
            ...
        },
        "ohlcv_data": [...],  # Optional
        "order_book": {...},  # Optional
        "portfolio_value": ...  # Optional
    }
    
    Returns:
    Complete signal with engine scores and action
    """
    try:
        from src.services.strategies.signal_generator import SignalGenerator
        
        generator = SignalGenerator()
        
        signal = generator.generate_signal(
            strategy_id=request_data.get('strategy_id'),
            asset_id=request_data.get('asset_id'),
            asset_type=request_data.get('asset_type'),
            strategy_data=request_data.get('strategy_data', {}),
            market_data=request_data.get('market_data', {}),
            ohlcv_data=request_data.get('ohlcv_data'),
            order_book=request_data.get('order_book'),
            portfolio_value=request_data.get('portfolio_value')
        )
        
        return signal
        
    except Exception as e:
        logger.error(f"Error generating signal: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))
