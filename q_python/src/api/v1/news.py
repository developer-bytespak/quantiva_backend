"""
News API endpoints for fetching cryptocurrency and stock news with sentiment analysis.
"""
from fastapi import APIRouter, HTTPException, Body
from typing import Dict, Any, Optional, List
from datetime import datetime, timezone
import logging

from src.services.data.lunarcrush_service import LunarCrushService
from src.services.data.stock_news_service import StockNewsService
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


@router.post("/stocks")
async def get_stock_news_with_sentiment(request_data: Dict[str, Any] = Body(...)):
    """
    Fetch stock market news with sentiment analysis from StockNewsAPI.
    Uses FinBERT for financial sentiment analysis.
    
    Request body:
    {
        "symbol": "AAPL",           # Stock symbol (e.g., AAPL, TSLA, GOOGL)
        "limit": 10                 # Number of news items to return (default: 10)
    }
    
    Returns:
    {
        "symbol": "AAPL",
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
        "market_metrics": {
            "total_news_count": 10,
            "sentiment_summary": {
                "positive": 5,
                "negative": 2,
                "neutral": 3
            },
            "avg_sentiment_score": 0.65
        },
        "timestamp": "2025-12-05T23:43:00Z"
    }
    """
    try:
        symbol = request_data.get('symbol', '').upper()
        limit = request_data.get('limit', 10)
        
        if not symbol:
            raise HTTPException(status_code=400, detail="Symbol is required")
        
        if limit < 1 or limit > 50:
            raise HTTPException(status_code=400, detail="Limit must be between 1 and 50")
        
        logger.info(f"Fetching stock news for {symbol} with sentiment analysis (limit={limit})")
        
        # Initialize services
        stock_news_service = StockNewsService()
        sentiment_engine = SentimentEngine()
        
        # Fetch news from StockNewsAPI
        news_items = stock_news_service.fetch_news(symbol, limit=limit)
        
        if not news_items:
            logger.warning(f"No news items found for stock {symbol}")
            news_items_with_sentiment = []
        else:
            # Analyze sentiment for each news item using FinBERT
            news_items_with_sentiment = []
            
            for item in news_items:
                title = item.get('title', '')
                text = item.get('text', title)
                combined_text = f"{title}. {text}" if title and text else (text or title)
                source = item.get('source', 'stock_news_api')
                
                # Prepare text data for sentiment analysis
                text_data = [{
                    'text': combined_text,
                    'source': source,
                    'title': title,
                    'url': item.get('url', '')
                }]
                
                # Use calculate() method for ML sentiment analysis (FinBERT)
                try:
                    sentiment_result = sentiment_engine.calculate(
                        asset_id=symbol,
                        asset_type='stock',
                        text_data=text_data
                    )
                    
                    # Extract sentiment from result
                    sentiment = {
                        "label": sentiment_result.get('metadata', {}).get('overall_sentiment', 'neutral'),
                        "score": float(sentiment_result.get('score', 0.0)),
                        "confidence": float(sentiment_result.get('confidence', 0.0))
                    }
                    
                    # Add layer breakdown for debugging
                    if 'layer_breakdown' in sentiment_result.get('metadata', {}):
                        sentiment['layer_breakdown'] = sentiment_result['metadata']['layer_breakdown']
                    
                except Exception as e:
                    logger.warning(f"Sentiment analysis failed for stock news item: {str(e)}")
                    # Fallback to analyze_text
                    try:
                        fallback_result = sentiment_engine.analyze_text(combined_text, source=source)
                        sentiment = {
                            "label": fallback_result.get('sentiment', 'neutral'),
                            "score": float(fallback_result.get('score', 0.0)),
                            "confidence": float(fallback_result.get('confidence', 0.0))
                        }
                    except Exception as fallback_error:
                        logger.error(f"Fallback sentiment analysis failed: {str(fallback_error)}")
                        sentiment = {
                            "label": "neutral",
                            "score": 0.0,
                            "confidence": 0.0
                        }
                
                # Format published_at
                published_at = item.get('published_at')
                published_at_str = published_at.isoformat() if published_at else None
                
                news_items_with_sentiment.append({
                    "title": title,
                    "description": text,
                    "url": item.get('url', ''),
                    "source": source,
                    "published_at": published_at_str,
                    "sentiment": sentiment
                })
        
        # Calculate market metrics / sentiment summary
        sentiment_counts = {"positive": 0, "negative": 0, "neutral": 0}
        total_score = 0.0
        
        for item in news_items_with_sentiment:
            label = item["sentiment"]["label"].lower()
            if label in sentiment_counts:
                sentiment_counts[label] += 1
            total_score += item["sentiment"]["score"]
        
        avg_score = total_score / len(news_items_with_sentiment) if news_items_with_sentiment else 0.0
        
        market_metrics = {
            "total_news_count": len(news_items_with_sentiment),
            "sentiment_summary": sentiment_counts,
            "avg_sentiment_score": round(avg_score, 4)
        }
        
        # Current timestamp
        timestamp = datetime.utcnow().isoformat() + 'Z'
        
        response = {
            "symbol": symbol,
            "news_items": news_items_with_sentiment,
            "market_metrics": market_metrics,
            "timestamp": timestamp
        }
        
        logger.info(f"Successfully fetched {len(news_items_with_sentiment)} stock news items for {symbol}")
        return response
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching stock news: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")


@router.post("/stocks/general/fast")
async def get_general_stock_news_fast(request_data: Dict[str, Any] = Body(...)):
    """
    Fetch general stock news WITHOUT sentiment analysis (fast).
    Use this for initial data population.
    
    Request body:
    {
        "limit": 20,                    # Number of news items to return (default: 20)
        "tickers": ["AAPL", "TSLA"]     # Optional: specific tickers (default: top 5)
    }
    """
    try:
        limit = request_data.get('limit', 20)
        tickers = request_data.get('tickers', ["AAPL", "TSLA", "GOOGL", "AMZN", "MSFT"])
        
        if limit < 1 or limit > 100:
            raise HTTPException(status_code=400, detail="Limit must be between 1 and 100")
        
        logger.info(f"Fetching stock news FAST for {tickers} - limit={limit}")
        
        stock_news_service = StockNewsService()
        news_items = stock_news_service.fetch_general_news(limit=limit, tickers=tickers)
        
        if not news_items:
            logger.warning("No general stock news items found")
            return {
                "total_count": 0,
                "news_items": [],
                "timestamp": datetime.utcnow().isoformat() + 'Z'
            }
        
        # Return news WITHOUT sentiment analysis (neutral placeholders)
        news_items_formatted = []
        for item in news_items:
            published_at = item.get('published_at')
            published_at_str = published_at.isoformat() if published_at else None
            
            news_items_formatted.append({
                "symbol": item.get('symbol', 'GENERAL'),
                "title": item.get('title', ''),
                "description": item.get('text', ''),
                "url": item.get('url', ''),
                "source": item.get('source', 'stock_news_api'),
                "published_at": published_at_str,
                "sentiment": {
                    "label": "neutral",
                    "score": 0.0,
                    "confidence": 0.0
                }
            })
        
        logger.info(f"Returning {len(news_items_formatted)} stock news items (fast mode)")
        
        return {
            "total_count": len(news_items_formatted),
            "news_items": news_items_formatted,
            "timestamp": datetime.utcnow().isoformat() + 'Z'
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in fast stock news fetch: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")


@router.post("/stocks/general")
async def get_general_stock_news_with_sentiment(request_data: Dict[str, Any] = Body(...)):
    """
    Fetch general/trending stock market news with sentiment analysis.
    Fetches news for multiple popular stocks to provide a broad market view.
    
    Request body:
    {
        "limit": 30    # Number of news items to return (default: 30)
    }
    
    Returns:
    {
        "total_count": 30,
        "news_items": [
            {
                "symbol": "AAPL",
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
        "timestamp": "2025-12-05T23:43:00Z"
    }
    """
    try:
        limit = request_data.get('limit', 30)
        
        if limit < 1 or limit > 100:
            raise HTTPException(status_code=400, detail="Limit must be between 1 and 100")
        
        logger.info(f"Fetching general stock news with sentiment analysis (limit={limit})")
        
        # Initialize services
        stock_news_service = StockNewsService()
        sentiment_engine = SentimentEngine()
        
        # Fetch general news (for multiple popular stocks)
        news_items = stock_news_service.fetch_general_news(limit=limit)
        
        if not news_items:
            logger.warning("No general stock news items found")
            return {
                "total_count": 0,
                "news_items": [],
                "timestamp": datetime.utcnow().isoformat() + 'Z'
            }
        
        # Analyze sentiment for each news item
        news_items_with_sentiment = []
        
        for item in news_items:
            symbol = item.get('symbol', 'GENERAL')
            title = item.get('title', '')
            text = item.get('text', title)
            combined_text = f"{title}. {text}" if title and text else (text or title)
            source = item.get('source', 'stock_news_api')
            
            # Prepare text data for sentiment analysis
            text_data = [{
                'text': combined_text,
                'source': source,
                'title': title,
                'url': item.get('url', '')
            }]
            
            try:
                sentiment_result = sentiment_engine.calculate(
                    asset_id=symbol,
                    asset_type='stock',
                    text_data=text_data
                )
                
                sentiment = {
                    "label": sentiment_result.get('metadata', {}).get('overall_sentiment', 'neutral'),
                    "score": float(sentiment_result.get('score', 0.0)),
                    "confidence": float(sentiment_result.get('confidence', 0.0))
                }
            except Exception as e:
                logger.warning(f"Sentiment analysis failed: {str(e)}")
                sentiment = {
                    "label": "neutral",
                    "score": 0.0,
                    "confidence": 0.0
                }
            
            # Format published_at
            published_at = item.get('published_at')
            published_at_str = published_at.isoformat() if published_at else None
            
            news_items_with_sentiment.append({
                "symbol": symbol,
                "title": title,
                "description": text,
                "url": item.get('url', ''),
                "source": source,
                "published_at": published_at_str,
                "sentiment": sentiment
            })
        
        timestamp = datetime.utcnow().isoformat() + 'Z'
        
        response = {
            "total_count": len(news_items_with_sentiment),
            "news_items": news_items_with_sentiment,
            "timestamp": timestamp
        }
        
        logger.info(f"Successfully fetched {len(news_items_with_sentiment)} general stock news items")
        return response
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching general stock news: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")

