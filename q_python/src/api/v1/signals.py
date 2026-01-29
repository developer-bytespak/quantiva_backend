"""
Signal API endpoints for generating trading signals.
"""
from fastapi import APIRouter, HTTPException, Body
from typing import Dict, Any, Optional
import logging
import asyncio
from concurrent.futures import ThreadPoolExecutor

from src.services.strategies.signal_generator import SignalGenerator

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/signals", tags=["Signals"])

# Thread pool for CPU-intensive signal generation
# This prevents blocking the async event loop
_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="signal_gen_")


def _generate_signal_sync(request_data: Dict[str, Any]) -> Dict[str, Any]:
    """Synchronous signal generation - runs in thread pool"""
    generator = SignalGenerator()
    
    connection_id = request_data.get('connection_id')
    exchange = request_data.get('exchange', 'binance')
    asset_symbol = request_data.get('asset_symbol') or request_data.get('asset_id')
    
    if not connection_id:
        user_id = request_data.get('user_id') or request_data.get('strategy_data', {}).get('user_id')
        if user_id:
            logger.debug(f"No connection_id provided for user_id: {user_id}. Technical Engine will use neutral score.")
    
    return generator.generate_signal(
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
        asset_symbol=asset_symbol
    )


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
        # Run CPU-intensive signal generation in thread pool
        # This prevents blocking the event loop so KYC requests can be processed
        loop = asyncio.get_event_loop()
        signal = await loop.run_in_executor(_executor, _generate_signal_sync, request_data)
        
        return signal
        
    except Exception as e:
        logger.error(f"Error generating signal: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))
