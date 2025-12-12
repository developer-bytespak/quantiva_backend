"""
LLM API endpoints for generating signal explanations.
"""
from fastapi import APIRouter, HTTPException, Body
from typing import Dict, Any
import logging

from src.services.llm.signal_explainer import SignalExplainer

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/llm", tags=["LLM"])


@router.post("/explain-signal")
async def explain_signal(request_data: Dict[str, Any] = Body(...)):
    """
    Generate explanation for a trading signal using LLM.
    
    Request body:
    {
        "signal_data": {
            "action": "BUY" | "SELL" | "HOLD",
            "final_score": 0.75,
            "confidence": 0.85
        },
        "engine_scores": {
            "sentiment": {"score": 0.6, "metadata": {...}},
            "trend": {"score": 0.7, "metadata": {...}},
            "fundamental": {"score": 0.5, "metadata": {...}},
            "liquidity": {"score": 0.8, "metadata": {...}},
            "event_risk": {"score": -0.2, "metadata": {...}}
        },
        "asset_id": "BTC",
        "asset_type": "crypto" | "stock"
    }
    
    Returns:
    {
        "explanation": "The signal suggests buying due to strong positive sentiment...",
        "model": "gemini-1.5-flash",
        "confidence": 0.8
    }
    """
    try:
        signal_data = request_data.get("signal_data")
        engine_scores = request_data.get("engine_scores")
        asset_id = request_data.get("asset_id")
        asset_type = request_data.get("asset_type")
        
        if not signal_data or not engine_scores or not asset_id or not asset_type:
            raise HTTPException(
                status_code=400,
                detail="Missing required fields: signal_data, engine_scores, asset_id, asset_type"
            )
        
        # Initialize explainer
        explainer = SignalExplainer()
        
        # Generate explanation
        result = explainer.explain_signal(
            signal_data=signal_data,
            engine_scores=engine_scores,
            asset_id=asset_id,
            asset_type=asset_type
        )
        
        logger.info(f"Generated explanation for {asset_id} using {result.get('model')}")
        
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error generating explanation: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")

