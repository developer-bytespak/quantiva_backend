"""
Test script to verify all engines work with LIVE data from LunarCrush and StockNews API.
"""
import requests
import json
from datetime import datetime
import time
import sys
import io

# Fix Windows console encoding for Unicode characters
if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

# API Configuration
API_URL = "http://localhost:8000/api/v1/signals/generate"
SENTIMENT_URL = "http://localhost:8000/api/v1/sentiment/analyze"

def test_crypto_with_live_data():
    """Test all engines with LIVE LunarCrush data for crypto."""
    print("=" * 70)
    print("TEST 1: CRYPTO (Bitcoin) - Using LIVE LunarCrush Data")
    print("=" * 70)
    
    # First, test sentiment engine separately to see fetched news
    print("\n[Step 1] Testing Sentiment Engine with LIVE LunarCrush data...")
    sentiment_request = {
        "asset_id": "BTC",
        "asset_type": "crypto",
        "news_source": "lunarcrush"  # Explicitly use LunarCrush
    }
    
    try:
        print("  -> Fetching live news from LunarCrush API...")
        sentiment_response = requests.post(SENTIMENT_URL, json=sentiment_request, timeout=120)
        
        if sentiment_response.status_code == 200:
            sentiment_data = sentiment_response.json()
            metadata = sentiment_data.get('metadata', {})
            
            print(f"  [OK] Sentiment Score: {sentiment_data.get('score', 'N/A')}")
            print(f"  [OK] Confidence: {sentiment_data.get('confidence', 'N/A')}")
            print(f"  [OK] News Source: {metadata.get('news_source', 'N/A')}")
            print(f"  [OK] Total Texts Analyzed: {metadata.get('total_texts', 0)}")
            
            # Show news items if available
            individual_results = metadata.get('individual_ml_results', [])
            if individual_results:
                print(f"\n  [NEWS] Fetched {len(individual_results)} news items from LunarCrush:")
                for i, item in enumerate(individual_results[:5], 1):  # Show first 5
                    source = item.get('source', 'unknown')
                    sentiment = item.get('sentiment', 'N/A')
                    print(f"     {i}. Source: {source}, Sentiment: {sentiment}")
        else:
            print(f"  [WARN] Sentiment API returned: {sentiment_response.status_code}")
            print(f"     {sentiment_response.text}")
    except Exception as e:
        print(f"  [ERROR] Error testing sentiment: {str(e)}")
    
    # Now test all engines combined
    print("\n[Step 2] Testing ALL ENGINES combined with LIVE data...")
    signal_request = {
        "strategy_id": "test_live_crypto",
        "asset_id": "BTC",
        "asset_type": "crypto",
        "strategy_data": {
            "entry_rules": [],
            "exit_rules": [],
            "indicators": [],
            "timeframe": "1d",
            "risk_level": "medium"
        },
        "market_data": {
            "asset_type": "crypto",
            "price": 50000.0,  # Placeholder - engines will fetch real data
            "volume_24h": 1000000000,
            "avg_volume_30d": 950000000
        }
    }
    
    try:
        print("  -> Running all engines (this may take 30-60 seconds)...")
        start_time = time.time()
        response = requests.post(API_URL, json=signal_request, timeout=180)
        elapsed = time.time() - start_time
        
        print(f"  [TIME] Execution time: {elapsed:.2f} seconds\n")
        
        if response.status_code == 200:
            data = response.json()
            display_results(data, "BTC (Crypto)")
        else:
            print(f"  [ERROR] Error: {response.status_code}")
            print(f"     {response.text}")
    except Exception as e:
        print(f"  [ERROR] Error: {str(e)}")
        import traceback
        traceback.print_exc()


def test_stock_with_live_data():
    """Test all engines with LIVE StockNews API data for stocks."""
    print("\n\n" + "=" * 70)
    print("TEST 2: STOCK (Apple) - Using LIVE StockNews API Data")
    print("=" * 70)
    
    # First, test sentiment engine separately
    print("\n[Step 1] Testing Sentiment Engine with LIVE StockNews API data...")
    sentiment_request = {
        "asset_id": "AAPL",
        "asset_type": "stock",
        "news_source": "stock_news_api"  # Explicitly use StockNews API
    }
    
    try:
        print("  -> Fetching live news from StockNews API...")
        sentiment_response = requests.post(SENTIMENT_URL, json=sentiment_request, timeout=120)
        
        if sentiment_response.status_code == 200:
            sentiment_data = sentiment_response.json()
            metadata = sentiment_data.get('metadata', {})
            
            print(f"  [OK] Sentiment Score: {sentiment_data.get('score', 'N/A')}")
            print(f"  [OK] Confidence: {sentiment_data.get('confidence', 'N/A')}")
            print(f"  [OK] News Source: {metadata.get('news_source', 'N/A')}")
            print(f"  [OK] Total Texts Analyzed: {metadata.get('total_texts', 0)}")
            
            # Show news items if available
            individual_results = metadata.get('individual_ml_results', [])
            if individual_results:
                print(f"\n  [NEWS] Fetched {len(individual_results)} news items from StockNews API:")
                for i, item in enumerate(individual_results[:5], 1):  # Show first 5
                    source = item.get('source', 'unknown')
                    sentiment = item.get('sentiment', 'N/A')
                    print(f"     {i}. Source: {source}, Sentiment: {sentiment}")
        else:
            print(f"  [WARN] Sentiment API returned: {sentiment_response.status_code}")
            print(f"     {sentiment_response.text}")
    except Exception as e:
        print(f"  [ERROR] Error testing sentiment: {str(e)}")
    
    # Now test all engines combined
    print("\n[Step 2] Testing ALL ENGINES combined with LIVE data...")
    signal_request = {
        "strategy_id": "test_live_stock",
        "asset_id": "AAPL",
        "asset_type": "stock",
        "strategy_data": {
            "entry_rules": [],
            "exit_rules": [],
            "indicators": [],
            "timeframe": "1d",
            "risk_level": "medium"
        },
        "market_data": {
            "asset_type": "stock",
            "price": 150.0,  # Placeholder - engines will fetch real data
            "volume_24h": 50000000,
            "avg_volume_30d": 45000000
        }
    }
    
    try:
        print("  -> Running all engines (this may take 30-60 seconds)...")
        start_time = time.time()
        response = requests.post(API_URL, json=signal_request, timeout=180)
        elapsed = time.time() - start_time
        
        print(f"  [TIME] Execution time: {elapsed:.2f} seconds\n")
        
        if response.status_code == 200:
            data = response.json()
            display_results(data, "AAPL (Stock)")
        else:
            print(f"  [ERROR] Error: {response.status_code}")
            print(f"     {response.text}")
    except Exception as e:
        print(f"  [ERROR] Error: {str(e)}")
        import traceback
        traceback.print_exc()


def display_results(data, asset_name):
    """Display comprehensive results from all engines."""
    print("=" * 70)
    print(f"RESULTS FOR {asset_name}")
    print("=" * 70)
    
    # Summary
    print(f"\n[SUMMARY]")
    print(f"   Final Score: {data.get('final_score', 'N/A')}")
    print(f"   Action: {data.get('action', 'N/A')}")
    print(f"   Confidence: {data.get('confidence', 'N/A')}")
    print(f"   Timestamp: {data.get('timestamp', 'N/A')}")
    
    # Engine Scores
    print(f"\n[ENGINE SCORES]")
    engine_scores = data.get('engine_scores', {})
    for engine, score_data in engine_scores.items():
        # Handle both dict format (with 'score' key) and direct numeric format
        if isinstance(score_data, dict):
            score = score_data.get('score', 0)
        else:
            score = score_data
        status = "[OK]" if abs(score) > 0.1 else "[--]"
        print(f"   {status} {engine.upper():15s}: {score:7.4f}")
    
    # Engine Details
    print(f"\n[ENGINE DETAILS]")
    metadata = data.get('metadata', {})
    engine_details = metadata.get('engine_details', {})
    
    # Sentiment Engine Details
    if 'sentiment' in engine_details:
        sent_data = engine_details['sentiment']
        sent_meta = sent_data.get('metadata', {})
        print(f"\n   [SENTIMENT ENGINE]")
        print(f"      Score: {sent_data.get('score', 'N/A')}")
        print(f"      Confidence: {sent_data.get('confidence', 'N/A')}")
        print(f"      News Source: {sent_meta.get('news_source', 'N/A')}")
        print(f"      Total Texts: {sent_meta.get('total_texts', 0)}")
        
        # Show layer breakdown
        layer_breakdown = sent_meta.get('layer_breakdown', {})
        if layer_breakdown:
            print(f"      Layer Breakdown:")
            for layer, data in layer_breakdown.items():
                score = data.get('score', 0)
                conf = data.get('confidence', 0)
                print(f"        - {layer}: score={score:.4f}, confidence={conf:.4f}")
    
    # Technical Engine Details
    if 'trend' in engine_details:
        trend_data = engine_details['trend']
        trend_meta = trend_data.get('metadata', {})
        print(f"\n   [TECHNICAL ENGINE]")
        print(f"      Score: {trend_data.get('score', 'N/A')}")
        print(f"      Confidence: {trend_data.get('confidence', 'N/A')}")
        indicators = trend_meta.get('indicators', {})
        if indicators:
            print(f"      Indicators:")
            for ind, val in indicators.items():
                if val is not None:
                    print(f"        - {ind}: {val}")
    
    # Fundamental Engine Details
    if 'fundamental' in engine_details:
        fund_data = engine_details['fundamental']
        fund_meta = fund_data.get('metadata', {})
        print(f"\n   [FUNDAMENTAL ENGINE]")
        print(f"      Score: {fund_data.get('score', 'N/A')}")
        print(f"      Confidence: {fund_data.get('confidence', 'N/A')}")
        score_breakdown = fund_meta.get('score_breakdown', {})
        if score_breakdown:
            print(f"      Score Breakdown:")
            for key, val in score_breakdown.items():
                if val is not None:
                    print(f"        - {key}: {val}")
    
    # Liquidity Engine
    if 'liquidity' in engine_details:
        liq_data = engine_details['liquidity']
        print(f"\n   [LIQUIDITY ENGINE]")
        print(f"      Score: {liq_data.get('score', 'N/A')}")
        print(f"      Confidence: {liq_data.get('confidence', 'N/A')}")
    
    # Event Risk Engine
    if 'event_risk' in engine_details:
        event_data = engine_details['event_risk']
        event_meta = event_data.get('metadata', {})
        print(f"\n   [EVENT RISK ENGINE]")
        print(f"      Score: {event_data.get('score', 'N/A')}")
        print(f"      Confidence: {event_data.get('confidence', 'N/A')}")
        events = event_meta.get('upcoming_events', [])
        if events:
            print(f"      Upcoming Events: {len(events)}")
            for event in events[:3]:  # Show first 3
                print(f"        - {event.get('type', 'unknown')}: {event.get('date', 'N/A')}")
    
    # Fusion Result
    fusion_result = metadata.get('fusion_result', {})
    if fusion_result:
        print(f"\n   [FUSION ENGINE]")
        print(f"      Final Score: {fusion_result.get('score', 'N/A')}")
        print(f"      Confidence: {fusion_result.get('confidence', 'N/A')}")
        weights = fusion_result.get('weights', {})
        if weights:
            print(f"      Weights Used:")
            for engine, weight in weights.items():
                print(f"        - {engine}: {weight}")
    
    # Save full response
    output_file = f"test_live_{asset_name.replace(' ', '_')}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2)
    print(f"\n[SAVED] Full response saved to: {output_file}")


def main():
    """Run all tests."""
    print("\n" + "=" * 70)
    print("TESTING ALL ENGINES WITH LIVE DATA")
    print("=" * 70)
    print("\nThis script will:")
    print("  1. Test CRYPTO (BTC) with LIVE LunarCrush data")
    print("  2. Test STOCK (AAPL) with LIVE StockNews API data")
    print("\nMake sure:")
    print("  - Python FastAPI server is running on http://localhost:8000")
    print("  - LUNARCRUSH_API_KEY is set in environment")
    print("  - STOCKNEWS_API_KEY is set in environment")
    print("\nStarting tests in 3 seconds...")
    time.sleep(3)
    
    # Test crypto
    test_crypto_with_live_data()
    
    # Wait a bit between tests
    print("\n\nWaiting 5 seconds before next test...")
    time.sleep(5)
    
    # Test stock
    test_stock_with_live_data()
    
    print("\n\n" + "=" * 70)
    print("[SUCCESS] ALL TESTS COMPLETED")
    print("=" * 70)


if __name__ == "__main__":
    main()

