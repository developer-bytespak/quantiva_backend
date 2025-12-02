"""
Macro API endpoints for FRED economic indicators.
"""
from fastapi import APIRouter, HTTPException
from typing import Dict, Any
import logging

from src.services.macro.fred_service import FredService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/macro", tags=["Macro"])

fred_service = FredService()


@router.get("/health")
async def health_check():
    """Check if FRED service is available."""
    return {
        "available": fred_service.is_available(),
        "api_key_set": fred_service.api_key is not None
    }


@router.post("/fetch-all")
async def fetch_all_indicators() -> Dict[str, Any]:
    """
    Fetch all primary indicators from FRED API.
    
    Returns:
    Dictionary with all indicator data
    """
    if not fred_service.is_available():
        raise HTTPException(
            status_code=503,
            detail="FRED service not available. Check FRED_API_KEY environment variable."
        )
    
    try:
        indicators = fred_service.fetch_all_primary_indicators()
        return indicators
    except Exception as e:
        logger.error(f"Error fetching indicators: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/indicator/{series_id}")
async def get_indicator(series_id: str) -> Dict[str, Any]:
    """
    Get latest value for a specific indicator.
    
    Args:
        series_id: FRED series ID (e.g., 'FEDFUNDS', 'CPIAUCSL')
    
    Returns:
        Latest indicator value and metadata
    """
    if not fred_service.is_available():
        raise HTTPException(
            status_code=503,
            detail="FRED service not available"
        )
    
    try:
        value = fred_service.get_latest_value(series_id)
        if not value:
            raise HTTPException(status_code=404, detail=f"Indicator {series_id} not found")
        return value
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching indicator {series_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/yield-curve")
async def get_yield_curve() -> Dict[str, Any]:
    """
    Get yield curve (10Y-2Y spread).
    
    Returns:
        Yield curve data with spread and rates
    """
    if not fred_service.is_available():
        raise HTTPException(
            status_code=503,
            detail="FRED service not available"
        )
    
    try:
        yield_curve = fred_service.calculate_yield_curve()
        if not yield_curve:
            raise HTTPException(status_code=500, detail="Failed to calculate yield curve")
        return yield_curve
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error calculating yield curve: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

