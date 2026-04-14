"""
Market data endpoints — bulk social metrics snapshots for NestJS crons.
"""
import logging
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from fastapi import APIRouter, Body, HTTPException

from src.services.data.lunarcrush_service import get_lunarcrush_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/market", tags=["Market"])


@router.post("/social-bulk")
async def refresh_social_metrics_bulk(
    request_data: Optional[Dict[str, Any]] = Body(default=None),
):
    """
    Trigger a bulk refresh of LunarCrush social metrics for the whole coin
    universe. One LunarCrush call warms the per-symbol cache inside
    LunarCrushService so subsequent `fetch_social_metrics(symbol)` calls
    from the engines are free cache hits for the next ~6 hours.

    Called by the NestJS `snapshotSocialMetricsBulk` cron (every 6 h).

    Response:
    {
        "count": <number of symbols parsed>,
        "fetched_at": <iso timestamp>,
        "metrics": {"BTC": {...}, "ETH": {...}, ...}   # only if include_metrics=true
    }
    """
    payload = request_data or {}
    include_metrics = bool(payload.get("include_metrics", False))

    try:
        svc = get_lunarcrush_service()
        result = svc.fetch_coins_list_bulk()

        response: Dict[str, Any] = {
            "count": len(result),
            "fetched_at": datetime.now(timezone.utc).isoformat(),
        }
        if include_metrics:
            response["metrics"] = result
        logger.info(f"/market/social-bulk refreshed {len(result)} symbols")
        return response
    except Exception as e:
        logger.error(f"/market/social-bulk failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")
