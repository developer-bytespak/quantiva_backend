"""
Options API endpoints.
Provides /options/recommend for AI-driven options recommendations.
"""
from fastapi import APIRouter, HTTPException, Body
from typing import Dict, Any
import logging

from src.services.engines.options_engine import OptionsEngine

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/options", tags=["Options"])

# Singleton engine instance
_options_engine = OptionsEngine()


@router.post("/recommend")
async def recommend_option(request_data: Dict[str, Any] = Body(...)):
    """
    Generate an options recommendation from an AI signal + options chain.

    Request body:
    {
        "signal": {
            "signal_id": "uuid",
            "asset_symbol": "BTCUSDT",
            "action": "BUY" | "SELL",
            "final_score": 0.65,
            "confidence": 0.72,
            "sentiment_score": 0.5,
            "trend_score": 0.6,
            "risk_level": "medium",
            "timeframe": "1d"
        },
        "options_chain": {
            "underlying": "BTC",
            "underlying_price": 95000.0,
            "contracts": [
                {
                    "symbol": "BTC-260327-100000-C",
                    "strike": 100000,
                    "expiry": "2026-03-27T08:00:00Z",
                    "type": "CALL",
                    "bid_price": 1200.0,
                    "ask_price": 1250.0,
                    "mark_price": 1225.0,
                    "volume": 150,
                    "open_interest": 500,
                    "greeks": {"delta": 0.45, "gamma": 0.001, "theta": -50, "vega": 120},
                    "contract_size": 0.01
                }
            ]
        },
        "portfolio_value": 50000.0  // optional
    }

    Response:
    {
        "recommendation": {
            "option_type": "CALL",
            "strike": 100000,
            "expiry": "2026-03-27T08:00:00Z",
            "symbol": "BTC-260327-100000-C",
            "estimated_premium": 1225.0,
            "quantity": 1,
            "max_loss": 12.25,
            "iv_rank": 0.55,
            "iv_value": 0.65,
            "greeks": {...},
            "liquidity_ok": true,
            "reasoning": "...",
            "confidence_adjustment": -0.05
        },
        "signal_id": "uuid"
    }
    """
    try:
        signal = request_data.get('signal')
        options_chain = request_data.get('options_chain')
        portfolio_value = request_data.get('portfolio_value')

        if not signal:
            raise HTTPException(status_code=400, detail="Missing 'signal' in request body")

        if not options_chain:
            raise HTTPException(status_code=400, detail="Missing 'options_chain' in request body")

        # Run the options engine
        result = _options_engine.calculate(
            asset_id=signal.get('asset_symbol', ''),
            asset_type='crypto',
            timeframe=signal.get('timeframe', '1d'),
            signal=signal,
            options_chain=options_chain,
            portfolio_value=portfolio_value,
        )

        return {
            'recommendation': result.get('recommendation'),
            'signal_id': signal.get('signal_id'),
            'score': result.get('score', 0),
            'confidence': result.get('confidence', 0),
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Options recommendation error: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Options recommendation failed: {str(e)}"
        )


@router.get("/health")
async def options_health():
    """Health check for the options engine."""
    return {
        "status": "ok",
        "engine": "OptionsEngine",
        "version": "1.0.0",
    }
