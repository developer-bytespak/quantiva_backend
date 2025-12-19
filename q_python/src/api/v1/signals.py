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
        "portfolio_value": ...,  # Optional
        "connection_id": "...",  # Optional: NestJS connection ID for OHLCV data
        "exchange": "binance" | "bybit"  # Optional: Exchange name
    }
    
    Note: connection_id should be fetched by NestJS from user_exchange_connections table
    before calling this endpoint. If not provided, Technical Engine will return neutral score.
    
    Returns:
    Complete signal with all engine scores, action, and position sizing
    """
    try:
        generator = SignalGenerator()
        
        # Extract connection_id, exchange, and asset_symbol for OHLCV data fetching
        connection_id = request_data.get('connection_id')
        exchange = request_data.get('exchange', 'binance')
        # Use asset_symbol if provided (for OHLCV fetching), otherwise use asset_id
        asset_symbol = request_data.get('asset_symbol') or request_data.get('asset_id')
        
        # Log if connection_id is missing (for debugging)
        if not connection_id:
            user_id = request_data.get('user_id') or request_data.get('strategy_data', {}).get('user_id')
            if user_id:
                logger.debug(f"No connection_id provided for user_id: {user_id}. Technical Engine will use neutral score.")
        
        signal = generator.generate_signal(
            strategy_id=request_data.get('strategy_id'),
            asset_id=request_data.get('asset_id'),
            asset_type=request_data.get('asset_type'),
            strategy_data=request_data.get('strategy_data', {}),
            market_data=request_data.get('market_data', {}),
            ohlcv_data=request_data.get('ohlcv_data'),
            order_book=request_data.get('order_book'),
            portfolio_value=request_data.get('portfolio_value'),
            connection_id=connection_id,
            exchange=exchange,
            asset_symbol=asset_symbol  # Pass symbol for OHLCV fetching
        )
        
        return signal
        
    except Exception as e:
        logger.error(f"Error generating signal: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))
