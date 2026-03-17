"""
Options Signals API
Endpoint for NestJS to call and generate AI options signals.
"""
from fastapi import APIRouter, HTTPException, Body
from typing import Dict, Any
import logging

from src.services.engines.options_signal_engine import OptionsSignalEngine

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/options-signals", tags=["Options Signals"])

_engine = OptionsSignalEngine()


@router.post("/generate")
async def generate_signals(request_data: Dict[str, Any] = Body(...)):
    """
    Generate AI options signals for an underlying.

    Request body:
    {
        "underlying": "BTC",
        "iv_rank": 0.45,       // optional
        "iv_value": 0.65,      // optional
        "spot_price": 95000.0, // optional
        "price_data": [...]    // optional, recent close prices
    }

    Response:
    {
        "signals": [ ... ],
        "underlying": "BTC",
        "score": 0.35,
        "confidence": 0.72
    }
    """
    try:
        underlying = request_data.get("underlying")
        if not underlying:
            raise HTTPException(status_code=400, detail="Missing 'underlying'")

        result = _engine.calculate(
            asset_id=underlying,
            asset_type="crypto",
            iv_rank=request_data.get("iv_rank"),
            iv_value=request_data.get("iv_value"),
            spot_price=request_data.get("spot_price"),
            price_data=request_data.get("price_data"),
        )

        return {
            "signals": result.get("metadata", {}).get("signals", []),
            "underlying": underlying,
            "score": result.get("score", 0),
            "confidence": result.get("confidence", 0),
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Options signal generation error: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Signal generation failed: {str(e)}",
        )


@router.get("/health")
async def options_signals_health():
    return {"status": "ok", "engine": "OptionsSignalEngine", "version": "1.0.0"}
