"""
Signal API endpoints for generating trading signals.
"""
from fastapi import APIRouter, HTTPException, Body
from typing import Dict, Any, Optional
import logging

from src.services.strategies.signal_generator import SignalGenerator

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/signals", tags=["Signals"])


@router.post("/generate")
async def generate_signal(request_data: Dict[str, Any] = Body(...)):
    """
    Generate signal for strategy and asset.
    
    Request body:
    {
        "strategy_id": "...",
        "asset_id": "...",
        "asset_type": "crypto" | "stock",
        "strategy_data": {...},
        "market_data": {...},
        "ohlcv_data": [...],  # Optional
        "order_book": {...},  # Optional
        "portfolio_value": ...  # Optional
    }
    
    Returns:
    Complete signal with all engine scores, action, and position sizing
    """
    try:
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
