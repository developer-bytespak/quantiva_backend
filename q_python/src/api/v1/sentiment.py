"""
Sentiment Analysis API endpoints.
Provides direct sentiment analysis with multi-layer support (ML + Keywords + Market).
"""
from fastapi import APIRouter, HTTPException, Body
from typing import Dict, Any, Optional, List
from datetime import datetime
import logging

from src.services.engines.sentiment_engine import SentimentEngine
from src.services.data.lunarcrush_service import LunarCrushService
from src.services.data.stock_news_service import StockNewsService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/sentiment", tags=["Sentiment"])


@router.post("/analyze")
async def analyze_sentiment(request_data: Dict[str, Any] = Body(...)):
    """
    Analyze sentiment of provided text or fetch news for an asset.
    Uses Phase 2 + Phase 3: ML (FinBERT) + Crypto Keywords + Market Signals.
    
    Request body:
    {
        "text": "Bitcoin is going to the moon!",  # Optional: Direct text to analyze
        "asset_id": "BTC",                        # Optional: Asset symbol (if not providing text)
        "asset_type": "crypto",                  # Required if asset_id provided: "crypto" or "stock"
        "news_source": "lunarcrush",             # Optional: "stock_news_api", "lunarcrush", "manual"
        "exchange": "binance",                    # Optional: Exchange name for market signals
        "connection_id": "optional-id"           # Optional: NestJS connection ID for OHLCV data
    }
    
    Returns:
    {
        "sentiment": "positive",
        "score": 0.75,
        "confidence": 0.85,
        "metadata": {
            "overall_sentiment": "positive",
            "asset_id": "BTC",
            "asset_type": "crypto",
            "news_type": "social",
            "layer_breakdown": {
                "ml": {"score": 0.6, "confidence": 0.8, "weight": 0.5},
                "keywords": {"score": 0.8, "confidence": 0.7, "weight": 0.3},
                "market": {"score": 0.5, "confidence": 0.6, "weight": 0.2}
            },
            "keyword_analysis": {...},
            "market_signals": {...}
        }
    }
    """
    try:
        text = request_data.get('text')
        asset_id = request_data.get('asset_id')
        asset_type = request_data.get('asset_type')
        news_source = request_data.get('news_source')
        exchange = request_data.get('exchange', 'binance')
        connection_id = request_data.get('connection_id')
        
        # Validate inputs
        if not text and not asset_id:
            raise HTTPException(
                status_code=400,
                detail="Either 'text' or 'asset_id' must be provided"
            )
        
        if asset_id and not asset_type:
            raise HTTPException(
                status_code=400,
                detail="'asset_type' is required when 'asset_id' is provided"
            )
        
        if asset_type and asset_type not in ['crypto', 'stock']:
            raise HTTPException(
                status_code=400,
                detail="'asset_type' must be 'crypto' or 'stock'"
            )
        
        logger.info(f"Analyzing sentiment: text={bool(text)}, asset_id={asset_id}, asset_type={asset_type}")
        
        # Initialize sentiment engine
        sentiment_engine = SentimentEngine()
        
        # Prepare text data
        text_data = None
        if text:
            # Direct text analysis
            text_data = [{
                'text': text,
                'source': 'manual',
                'news_type': 'formal'
            }]
            # Use asset_id if provided for market signals, otherwise use None
            analysis_asset_id = asset_id or 'UNKNOWN'
            analysis_asset_type = asset_type or 'crypto'  # Default to crypto for text analysis
        else:
            # Asset-based analysis (will fetch news)
            analysis_asset_id = asset_id
            analysis_asset_type = asset_type
            text_data = None  # Will be fetched by engine
        
        # Analyze sentiment using full Phase 2 + Phase 3 pipeline
        result = sentiment_engine.calculate(
            asset_id=analysis_asset_id,
            asset_type=analysis_asset_type,
            text_data=text_data,
            news_source=news_source,
            exchange=exchange,
            connection_id=connection_id
        )
        
        # Format response
        response = {
            "sentiment": result.get('metadata', {}).get('overall_sentiment', 'neutral'),
            "score": float(result.get('score', 0.0)),
            "confidence": float(result.get('confidence', 0.0)),
            "metadata": result.get('metadata', {})
        }
        
        logger.info(f"Sentiment analysis completed: {response['sentiment']} (score: {response['score']:.3f})")
        return response
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error analyzing sentiment: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")


@router.post("/analyze-batch")
async def analyze_sentiment_batch(request_data: Dict[str, Any] = Body(...)):
    """
    Analyze sentiment for multiple texts in batch.
    
    Request body:
    {
        "texts": [
            {"text": "Bitcoin is bullish", "source": "twitter"},
            {"text": "Market crash incoming", "source": "reddit"}
        ],
        "asset_type": "crypto",           # Required: "crypto" or "stock"
        "exchange": "binance",            # Optional: Exchange name
        "connection_id": "optional-id"    # Optional: NestJS connection ID
    }
    
    Returns:
    {
        "results": [
            {
                "text": "Bitcoin is bullish",
                "sentiment": "positive",
                "score": 0.65,
                "confidence": 0.75
            },
            ...
        ],
        "aggregated": {
            "sentiment": "positive",
            "score": 0.55,
            "confidence": 0.70
        }
    }
    """
    try:
        texts = request_data.get('texts', [])
        asset_type = request_data.get('asset_type', 'crypto')
        exchange = request_data.get('exchange', 'binance')
        connection_id = request_data.get('connection_id')
        
        if not texts:
            raise HTTPException(status_code=400, detail="'texts' array is required and cannot be empty")
        
        if asset_type not in ['crypto', 'stock']:
            raise HTTPException(status_code=400, detail="'asset_type' must be 'crypto' or 'stock'")
        
        logger.info(f"Analyzing batch sentiment: {len(texts)} texts, asset_type={asset_type}")
        
        sentiment_engine = SentimentEngine()
        
        # Prepare text data
        text_data = []
        for item in texts:
            if isinstance(item, str):
                text_data.append({
                    'text': item,
                    'source': 'manual',
                    'news_type': 'formal'
                })
            elif isinstance(item, dict):
                text_data.append({
                    'text': item.get('text', ''),
                    'source': item.get('source', 'manual'),
                    'news_type': item.get('news_type', 'formal')
                })
        
        # Analyze each text individually
        results = []
        for text_item in text_data:
            try:
                result = sentiment_engine.calculate(
                    asset_id='BATCH',
                    asset_type=asset_type,
                    text_data=[text_item],
                    exchange=exchange,
                    connection_id=connection_id
                )
                
                results.append({
                    "text": text_item['text'][:100] + "..." if len(text_item['text']) > 100 else text_item['text'],
                    "sentiment": result.get('metadata', {}).get('overall_sentiment', 'neutral'),
                    "score": float(result.get('score', 0.0)),
                    "confidence": float(result.get('confidence', 0.0))
                })
            except Exception as e:
                logger.warning(f"Failed to analyze text: {str(e)}")
                results.append({
                    "text": text_item['text'][:100] + "..." if len(text_item['text']) > 100 else text_item['text'],
                    "sentiment": "neutral",
                    "score": 0.0,
                    "confidence": 0.0,
                    "error": str(e)
                })
        
        # Calculate aggregated sentiment
        if results:
            scores = [r['score'] for r in results if 'error' not in r]
            confidences = [r['confidence'] for r in results if 'error' not in r]
            
            if scores:
                avg_score = sum(scores) / len(scores)
                avg_confidence = sum(confidences) / len(confidences) if confidences else 0.0
                
                if avg_score > 0.1:
                    aggregated_sentiment = 'positive'
                elif avg_score < -0.1:
                    aggregated_sentiment = 'negative'
                else:
                    aggregated_sentiment = 'neutral'
            else:
                avg_score = 0.0
                avg_confidence = 0.0
                aggregated_sentiment = 'neutral'
        else:
            avg_score = 0.0
            avg_confidence = 0.0
            aggregated_sentiment = 'neutral'
        
        response = {
            "results": results,
            "aggregated": {
                "sentiment": aggregated_sentiment,
                "score": float(avg_score),
                "confidence": float(avg_confidence),
                "total_texts": len(results)
            }
        }
        
        logger.info(f"Batch sentiment analysis completed: {len(results)} results")
        return response
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in batch sentiment analysis: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")

