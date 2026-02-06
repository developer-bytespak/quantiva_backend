#!/usr/bin/env python3
"""
Test file to call external news APIs and print responses
- LunarCrush for crypto news
- StockNewsAPI for stock news
"""

import sys
import os
import json
from pprint import pprint

# Add parent directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from src.services.data.lunarcrush_service import LunarCrushService
from src.services.data.stock_news_service import StockNewsService


def test_lunarcrush_crypto_news():
    """Test LunarCrush API for crypto news"""
    print("\n" + "="*80)
    print("🚀 TESTING LUNARCRUSH API - CRYPTO NEWS")
    print("="*80 + "\n")
    
    try:
        lunarcrush = LunarCrushService()
        
        # Test single coin
        symbols = ['BTC', 'ETH', 'SOL']
        
        for symbol in symbols:
            print(f"\n📰 Fetching news for {symbol}...")
            print("-" * 60)
            
            news_items = lunarcrush.fetch_coin_news(symbol, limit=5)
            
            print(f"✅ Retrieved {len(news_items)} news items for {symbol}\n")
            
            for idx, news in enumerate(news_items, 1):
                print(f"News #{idx}:")
                print(f"  Title: {news.get('title', 'N/A')}")
                print(f"  Source: {news.get('source', 'N/A')}")
                print(f"  URL: {news.get('url', 'N/A')}")
                print(f"  Published: {news.get('published_at', 'N/A')}")
                print(f"  Description: {news.get('text', 'N/A')[:100]}..." if news.get('text') else "  Description: N/A")
                print()
        
        # Test social metrics
        print("\n" + "="*60)
        print("📊 Testing LunarCrush Social Metrics")
        print("="*60 + "\n")
        
        for symbol in symbols:
            print(f"Fetching metrics for {symbol}...")
            metrics = lunarcrush.fetch_social_metrics(symbol)
            
            print(f"✅ Metrics for {symbol}:")
            print(f"  Galaxy Score: {metrics.get('galaxy_score', 'N/A')}")
            print(f"  Alt Rank: {metrics.get('alt_rank', 'N/A')}")
            print(f"  Social Volume: {metrics.get('social_volume', 'N/A')}")
            print(f"  Price: ${metrics.get('price', 'N/A')}")
            print(f"  Volume 24h: {metrics.get('volume_24h', 'N/A')}")
            print(f"  Market Cap: {metrics.get('market_cap', 'N/A')}\n")
    
    except Exception as e:
        print(f"❌ Error testing LunarCrush: {str(e)}")
        import traceback
        traceback.print_exc()


def test_stocknewsapi_stock_news():
    """Test StockNewsAPI for stock news"""
    print("\n" + "="*80)
    print("🚀 TESTING STOCKNEWSAPI - STOCK NEWS")
    print("="*80 + "\n")
    
    try:
        stock_news = StockNewsService()
        
        # Test multiple stocks
        symbols = ['AAPL', 'TSLA', 'GOOGL']
        
        for symbol in symbols:
            print(f"\n📰 Fetching news for {symbol}...")
            print("-" * 60)
            
            news_items = stock_news.fetch_news(symbol, limit=5)
            
            print(f"✅ Retrieved {len(news_items)} news items for {symbol}\n")
            
            for idx, news in enumerate(news_items, 1):
                print(f"News #{idx}:")
                print(f"  Title: {news.get('title', 'N/A')}")
                print(f"  Source: {news.get('source', 'N/A')}")
                print(f"  URL: {news.get('url', 'N/A')}")
                print(f"  Published: {news.get('published_at', 'N/A')}")
                print(f"  Text: {news.get('text', 'N/A')[:100]}..." if news.get('text') else "  Text: N/A")
                print()
    
    except Exception as e:
        print(f"❌ Error testing StockNewsAPI: {str(e)}")
        import traceback
        traceback.print_exc()


def serialize_for_json(item):
    """Convert datetime objects to strings for JSON serialization"""
    result = {}
    for k, v in item.items():
        if hasattr(v, 'isoformat'):  # datetime object
            result[k] = v.isoformat()
        else:
            result[k] = v
    return result


def test_raw_api_responses():
    """Test and print raw API responses"""
    print("\n" + "="*80)
    print("🔍 TESTING RAW API RESPONSES")
    print("="*80 + "\n")
    
    try:
        # Test LunarCrush raw response
        print("📡 LunarCrush Raw API Response for BTC:")
        print("-" * 60)
        lunarcrush = LunarCrushService()
        response = lunarcrush.fetch_coin_news('BTC', limit=2)
        print(json.dumps([serialize_for_json(item) for item in response[:2]], indent=2))
        
        print("\n\n")
        
        # Test StockNewsAPI raw response
        print("📡 StockNewsAPI Raw API Response for AAPL:")
        print("-" * 60)
        stock_news = StockNewsService()
        response = stock_news.fetch_news('AAPL', limit=2)
        print(json.dumps([serialize_for_json(item) for item in response[:2]], indent=2))
    
    except Exception as e:
        print(f"❌ Error: {str(e)}")
        import traceback
        traceback.print_exc()


def test_title_description_separation():
    """Verify that title and text are separate and different"""
    print("\n" + "="*80)
    print("🔍 VERIFYING TITLE vs DESCRIPTION SEPARATION")
    print("="*80 + "\n")
    
    try:
        stock_news = StockNewsService()
        response = stock_news.fetch_news('AAPL', limit=3)
        
        print("Checking StockNewsAPI Response (AAPL):\n")
        
        for idx, item in enumerate(response, 1):
            title = item.get('title', '')
            text = item.get('text', '')
            
            same = title == text
            match_status = "❌ SAME (BAD!)" if same else "✅ DIFFERENT (GOOD!)"
            
            print(f"Item #{idx}: {match_status}")
            print(f"  Title: {title[:60]}...")
            print(f"  Text:  {text[:60]}...")
            print(f"  Title length: {len(title)} chars")
            print(f"  Text length: {len(text)} chars")
            print()
        
        print("✅ Verification Complete!")
        
    except Exception as e:
        print(f"❌ Error: {str(e)}")
        import traceback
        traceback.print_exc()


if __name__ == '__main__':
    print("\n")
    print("=" * 80)
    print(" " * 20 + "EXTERNAL NEWS API TEST")
    print("=" * 80)
    
    # Run tests
    test_lunarcrush_crypto_news()
    test_stocknewsapi_stock_news()
    test_raw_api_responses()
    test_title_description_separation()
    
    print("\n" + "="*80)
    print("✅ Test Complete!")
    print("="*80 + "\n")
