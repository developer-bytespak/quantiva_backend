"""
Stock Trending API Routes
Handles Finnhub trending stocks data fetching.
"""
from fastapi import APIRouter, HTTPException
from typing import Dict, Any, List
import logging

from src.services.data.finnhub_service import FinnhubService

logger = logging.getLogger(__name__)
router = APIRouter()

# Initialize services
finnhub_service = FinnhubService()


@router.get("/trending", response_model=Dict[str, Any])
async def get_trending_stocks(limit: int = 50) -> Dict[str, Any]:
    """
    Get trending stocks from Finnhub API.
    
    Query Parameters:
        limit: Maximum number of stocks to return (default: 50)
    
    Returns:
        Dictionary with trending stocks list:
        {
            "stocks": [
                {
                    "symbol": "AAPL",
                    "price": 178.45,
                    "change_percent": 2.3,
                    "volume": 52340000,
                    ...
                },
                ...
            ],
            "count": 50,
            "source": "finnhub"
        }
    """
    try:
        logger.info(f"Fetching {limit} trending stocks from Finnhub")
        
        trending_stocks = finnhub_service.fetch_trending_stocks(limit=limit)
        
        return {
            "stocks": trending_stocks,
            "count": len(trending_stocks),
            "source": "finnhub"
        }
    
    except Exception as e:
        logger.error(f"Error fetching trending stocks: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to fetch trending stocks: {str(e)}"
        )


@router.post("/batch/fundamentals", response_model=Dict[str, Any])
async def batch_fetch_fundamentals(symbols: List[str]) -> Dict[str, Any]:
    """
    Batch fetch company fundamentals for multiple stocks.
    
    Request Body:
        symbols: List of stock symbols (e.g., ["AAPL", "TSLA", "GOOGL"])
    
    Returns:
        Dictionary mapping symbol to fundamentals data
    """
    try:
        logger.info(f"Batch fetching fundamentals for {len(symbols)} stocks")
        
        fundamentals = finnhub_service.fetch_company_fundamentals_batch(symbols)
        
        return {
            "fundamentals": fundamentals,
            "count": len(fundamentals),
            "source": "finnhub"
        }
    
    except Exception as e:
        logger.error(f"Error batch fetching fundamentals: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to batch fetch fundamentals: {str(e)}"
        )


@router.post("/batch/earnings", response_model=Dict[str, Any])
async def batch_fetch_earnings(symbols: List[str], days_ahead: int = 30) -> Dict[str, Any]:
    """
    Batch fetch earnings calendar for multiple stocks.
    
    Request Body:
        symbols: List of stock symbols
    
    Query Parameters:
        days_ahead: Number of days to look ahead (default: 30)
    
    Returns:
        Dictionary mapping symbol to earnings data
    """
    try:
        logger.info(f"Batch fetching earnings for {len(symbols)} stocks")
        
        earnings = finnhub_service.fetch_earnings_calendar_batch(symbols, days_ahead=days_ahead)
        
        return {
            "earnings": earnings,
            "count": len(earnings),
            "source": "finnhub"
        }
    
    except Exception as e:
        logger.error(f"Error batch fetching earnings: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to batch fetch earnings: {str(e)}"
        )


@router.post("/batch/sentiment", response_model=Dict[str, Any])
async def batch_fetch_social_sentiment(symbols: List[str]) -> Dict[str, Any]:
    """
    Batch fetch social sentiment for multiple stocks.
    
    Request Body:
        symbols: List of stock symbols
    
    Returns:
        Dictionary mapping symbol to social sentiment data
    """
    try:
        logger.info(f"Batch fetching social sentiment for {len(symbols)} stocks")
        
        sentiment = finnhub_service.fetch_social_sentiment_batch(symbols)
        
        return {
            "sentiment": sentiment,
            "count": len(sentiment),
            "source": "finnhub"
        }
    
    except Exception as e:
        logger.error(f"Error batch fetching social sentiment: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to batch fetch social sentiment: {str(e)}"
        )
