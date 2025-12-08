"""
News API endpoints for fetching cryptocurrency news with sentiment analysis.
"""
from fastapi import APIRouter, HTTPException, Body
from typing import Dict, Any, Optional, List
from datetime import datetime, timezone
import logging

from src.services.data.lunarcrush_service import LunarCrushService
from src.services.engines.sentiment_engine import SentimentEngine

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/news", tags=["News"])


@router.post("/crypto")
async def get_crypto_news_with_sentiment(request_data: Dict[str, Any] = Body(...)):
    """
    Fetch cryptocurrency news with LunarCrush social metrics and multi-layer sentiment analysis.
    Uses Phase 2 + Phase 3: ML (FinBERT) + Crypto Keywords + Market Signals.
    
    Request body:
    {
        "symbol": "BTC",           # Cryptocurrency symbol (e.g., BTC, ETH, SOL)
        "limit": 2,                # Number of news items to return (default: 2)
        "connection_id": "optional", # Optional: NestJS connection ID for OHLCV market data
        "exchange": "binance"       # Optional: Exchange name (default: "binance")
    }
    
    Returns:
    {
        "symbol": "BTC",
        "news_items": [
            {
                "title": "...",
                "description": "...",
                "url": "...",
                "source": "...",
                "published_at": "2025-12-05T23:43:00Z",
                "sentiment": {
                    "label": "positive",
                    "score": 0.75,
                    "confidence": 0.9
                }
            }
        ],
        "social_metrics": {
            "galaxy_score": 59.4,
            "alt_rank": 256,
            "social_volume": 0,
            "price": 89091.20,
            "volume_24h": 62583048890.06,
            "market_cap": 1778064946566.95
        },
        "timestamp": "2025-12-05T23:43:00Z"
    }
    """
    try:
        symbol = request_data.get('symbol', '').upper()
        limit = request_data.get('limit', 2)
        
        if not symbol:
            raise HTTPException(status_code=400, detail="Symbol is required")
        
        if limit < 1 or limit > 50:
            raise HTTPException(status_code=400, detail="Limit must be between 1 and 50")
        
        logger.info(f"Fetching crypto news for {symbol} with sentiment analysis (limit={limit})")
        
        # Initialize services
        lunarcrush_service = LunarCrushService()
        sentiment_engine = SentimentEngine()
        
        # Fetch news from LunarCrush
        news_items = lunarcrush_service.fetch_coin_news(symbol, limit=limit)
        
        if not news_items:
            logger.warning(f"No news items found for {symbol}")
            # Return empty structure with metrics still
            news_items_with_sentiment = []
        else:
            # Analyze sentiment for each news item using Phase 2 + Phase 3 (ML + Keywords + Market)
            news_items_with_sentiment = []
            
            # Get optional connection_id from request for market signals (if available)
            connection_id = request_data.get('connection_id')
            exchange = request_data.get('exchange', 'binance')
            
            for item in news_items:
                title = item.get('title', '')
                text = item.get('text', title)
                combined_text = f"{title}. {text}" if title and text else (text or title)
                source = item.get('source', 'unknown')
                
                # Prepare text data for calculate() method
                text_data = [{
                    'text': combined_text,
                    'source': source,
                    'title': title,
                    'url': item.get('url', '')
                }]
                
                # Use calculate() method for full Phase 2 + Phase 3 pipeline
                # This includes: ML (FinBERT) + Keywords + Market signals
                try:
                    sentiment_result = sentiment_engine.calculate(
                        asset_id=symbol,
                        asset_type='crypto',
                        text_data=text_data,
                        exchange=exchange,
                        connection_id=connection_id
                    )
                    
                    # Extract sentiment from result
                    sentiment = {
                        "label": sentiment_result.get('metadata', {}).get('overall_sentiment', 'neutral'),
                        "score": float(sentiment_result.get('score', 0.0)),
                        "confidence": float(sentiment_result.get('confidence', 0.0))
                    }
                    
                    # Add layer breakdown to metadata (optional, for debugging)
                    if 'layer_breakdown' in sentiment_result.get('metadata', {}):
                        sentiment['layer_breakdown'] = sentiment_result['metadata']['layer_breakdown']
                    
                except Exception as e:
                    logger.warning(f"Phase 2+3 sentiment analysis failed for item, falling back to Phase 1: {str(e)}")
                    # Fallback to Phase 1 (analyze_text) if Phase 2+3 fails
                    try:
                        fallback_result = sentiment_engine.analyze_text(combined_text, source=source)
                        sentiment = {
                            "label": fallback_result.get('sentiment', 'neutral'),
                            "score": float(fallback_result.get('score', 0.0)),
                            "confidence": float(fallback_result.get('confidence', 0.0))
                        }
                    except Exception as fallback_error:
                        logger.error(f"Fallback sentiment analysis also failed: {str(fallback_error)}")
                        sentiment = {
                            "label": "neutral",
                            "score": 0.0,
                            "confidence": 0.0
                        }
                
                # Pass through published_at as-is from LunarCrush
                published_at_str = item.get('published_at')
                
                news_items_with_sentiment.append({
                    "title": title,
                    "description": text,
                    "url": item.get('url', ''),
                    "source": source,
                    "published_at": published_at_str,
                    "sentiment": sentiment
                })
        
        # Fetch social metrics from LunarCrush
        social_metrics_raw = lunarcrush_service.fetch_social_metrics(symbol)
        
        # Format social metrics response
        social_metrics = {
            "galaxy_score": float(social_metrics_raw.get('galaxy_score', 0.0)),
            "alt_rank": int(social_metrics_raw.get('alt_rank', 999999)),
            "social_volume": int(social_metrics_raw.get('social_volume', 0)),
            "price": float(social_metrics_raw.get('price', 0.0)),
            "volume_24h": float(social_metrics_raw.get('volume_24h', 0.0)),
            "market_cap": float(social_metrics_raw.get('market_cap', 0.0))
        }
        
        # Current timestamp
        timestamp = datetime.utcnow().isoformat() + 'Z'
        
        response = {
            "symbol": symbol,
            "news_items": news_items_with_sentiment,
            "social_metrics": social_metrics,
            "timestamp": timestamp
        }
        
        logger.info(f"Successfully fetched {len(news_items_with_sentiment)} news items for {symbol}")
        return response
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching crypto news: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")

