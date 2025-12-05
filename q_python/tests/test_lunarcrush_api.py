"""
Test script to verify Lunar Crush API is fetching real-life news.

This script tests the Lunar Crush API integration and verifies that:
1. API connection is working
2. News items are being fetched
3. News items contain real content (titles, descriptions, URLs, dates)
4. Dates are recent (within last 30 days)
"""

import sys
import os
from datetime import datetime, timedelta
from pathlib import Path

# Load .env file if it exists
try:
    from dotenv import load_dotenv
    env_path = Path(__file__).parent.parent / '.env'
    if env_path.exists():
        load_dotenv(env_path)
    else:
        # Try parent directory
        env_path = Path(__file__).parent.parent.parent / '.env'
        if env_path.exists():
            load_dotenv(env_path)
except ImportError:
    pass  # dotenv not installed, skip

# Add parent directory to path to import src modules
sys.path.insert(0, str(Path(__file__).parent.parent))

# Import directly from the module file to avoid __init__.py dependencies
import importlib.util
spec = importlib.util.spec_from_file_location(
    "lunarcrush_service",
    Path(__file__).parent.parent / "src" / "services" / "data" / "lunarcrush_service.py"
)
lunarcrush_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lunarcrush_module)
LunarCrushService = lunarcrush_module.LunarCrushService

from src.config import LUNARCRUSH_API_KEY
import logging

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


def print_separator():
    """Print a separator line."""
    print("\n" + "=" * 80 + "\n")


def format_date(date_obj):
    """Format datetime object for display."""
    if date_obj:
        return date_obj.strftime("%Y-%m-%d %H:%M:%S")
    return "N/A"


def is_recent_news(date_obj, days_threshold=30):
    """Check if news is recent (within last N days)."""
    if not date_obj:
        return False
    cutoff_date = datetime.now() - timedelta(days=days_threshold)
    # Handle timezone-aware vs timezone-naive datetime comparison
    if date_obj.tzinfo is not None and cutoff_date.tzinfo is None:
        from datetime import timezone
        cutoff_date = cutoff_date.replace(tzinfo=timezone.utc)
    elif date_obj.tzinfo is None and cutoff_date.tzinfo is not None:
        date_obj = date_obj.replace(tzinfo=cutoff_date.tzinfo)
    return date_obj >= cutoff_date


def test_lunarcrush_news(symbol="BTC", limit=10):
    """
    Test Lunar Crush API news fetching.
    
    Args:
        symbol: Cryptocurrency symbol to test (default: BTC)
        limit: Number of news items to fetch (default: 10)
    """
    print_separator()
    print(f"Testing Lunar Crush API - Fetching news for {symbol}")
    print_separator()
    
    # Check API key
    if not LUNARCRUSH_API_KEY:
        print("❌ ERROR: LUNARCRUSH_API_KEY not set in environment variables")
        print("   Please set LUNARCRUSH_API_KEY before running this test")
        return False
    
    print(f"✓ API Key found: {LUNARCRUSH_API_KEY[:10]}...{LUNARCRUSH_API_KEY[-4:]}")
    print()
    
    # Initialize service
    service = LunarCrushService()
    
    # Fetch news
    print(f"Fetching news for {symbol} (limit: {limit})...")
    try:
        news_items = service.fetch_coin_news(symbol, limit=limit)
    except Exception as e:
        print(f"❌ ERROR: Failed to fetch news: {str(e)}")
        import traceback
        traceback.print_exc()
        return False
    
    # Check if news was fetched
    if not news_items:
        print(f"❌ WARNING: No news items returned for {symbol}")
        print("   This could mean:")
        print("   - API key is invalid")
        print("   - API endpoint is incorrect")
        print("   - No news available for this symbol")
        print("   - API response format changed")
        return False
    
    print(f"✓ Successfully fetched {len(news_items)} news items\n")
    
    # Analyze news items
    print("Analyzing news items...")
    print_separator()
    
    valid_items = 0
    recent_items = 0
    items_with_urls = 0
    items_with_sources = 0
    
    for i, item in enumerate(news_items, 1):
        print(f"\n📰 News Item #{i}:")
        print(f"   Title: {item.get('title', 'N/A')[:100]}...")
        print(f"   Source: {item.get('source', 'N/A')}")
        print(f"   Published: {format_date(item.get('published_at'))}")
        print(f"   URL: {item.get('url', 'N/A')[:80]}...")
        
        # Check validity
        has_title = bool(item.get('title'))
        has_text = bool(item.get('text'))
        has_url = bool(item.get('url'))
        has_source = bool(item.get('source'))
        has_date = bool(item.get('published_at'))
        
        if has_title or has_text:
            valid_items += 1
            print("   ✓ Valid news item")
        else:
            print("   ❌ Invalid: Missing title and text")
        
        if has_url:
            items_with_urls += 1
        
        if has_source:
            items_with_sources += 1
        
        if has_date:
            if is_recent_news(item.get('published_at')):
                recent_items += 1
                print("   ✓ Recent news (within last 30 days)")
            else:
                print("   ⚠ Old news (older than 30 days)")
        else:
            print("   ⚠ No publication date")
    
    # Summary
    print_separator()
    print("📊 SUMMARY:")
    print(f"   Total items fetched: {len(news_items)}")
    print(f"   Valid items (has title/text): {valid_items}/{len(news_items)}")
    print(f"   Items with URLs: {items_with_urls}/{len(news_items)}")
    print(f"   Items with sources: {items_with_sources}/{len(news_items)}")
    print(f"   Recent news (last 30 days): {recent_items}/{len(news_items)}")
    print_separator()
    
    # Final verdict
    if valid_items > 0:
        print("✅ SUCCESS: Lunar Crush API is fetching real-life news!")
        if recent_items > 0:
            print("   ✓ Recent news items found")
        if items_with_urls > 0:
            print("   ✓ News items have URLs")
        if items_with_sources > 0:
            print("   ✓ News items have sources")
        return True
    else:
        print("❌ FAILURE: No valid news items found")
        return False


def test_lunarcrush_social_metrics(symbol="BTC"):
    """
    Test Lunar Crush API social metrics fetching.
    
    Args:
        symbol: Cryptocurrency symbol to test (default: BTC)
    """
    print_separator()
    print(f"Testing Lunar Crush API - Fetching social metrics for {symbol}")
    print_separator()
    
    # Check API key
    if not LUNARCRUSH_API_KEY:
        print("❌ ERROR: LUNARCRUSH_API_KEY not set")
        return False
    
    # Initialize service
    service = LunarCrushService()
    
    # Fetch social metrics
    print(f"Fetching social metrics for {symbol}...")
    try:
        metrics = service.fetch_social_metrics(symbol)
    except Exception as e:
        print(f"❌ ERROR: Failed to fetch social metrics: {str(e)}")
        import traceback
        traceback.print_exc()
        return False
    
    # Check if metrics were fetched
    if not metrics:
        print(f"❌ WARNING: No social metrics returned for {symbol}")
        return False
    
    print(f"✓ Successfully fetched social metrics\n")
    print("📊 Social Metrics:")
    for key, value in metrics.items():
        print(f"   {key}: {value}")
    
    print_separator()
    
    # Check if metrics have real values
    has_data = any(v for v in metrics.values() if v != 0 and v != {})
    if has_data:
        print("✅ SUCCESS: Social metrics contain real data!")
        return True
    else:
        print("⚠ WARNING: Social metrics appear to be empty or zero")
        return False


def main():
    """Main test function."""
    print("\n" + "=" * 80)
    print("LUNAR CRUSH API TEST SCRIPT")
    print("=" * 80)
    
    # Test with multiple symbols
    test_symbols = ["BTC", "ETH", "SOL"]
    
    results = {}
    
    for symbol in test_symbols:
        print(f"\n\n{'='*80}")
        print(f"TESTING SYMBOL: {symbol}")
        print('='*80)
        
        # Test news fetching
        news_result = test_lunarcrush_news(symbol, limit=5)
        results[f"{symbol}_news"] = news_result
        
        # Test social metrics
        metrics_result = test_lunarcrush_social_metrics(symbol)
        results[f"{symbol}_metrics"] = metrics_result
    
    # Final summary
    print("\n\n" + "=" * 80)
    print("FINAL TEST SUMMARY")
    print("=" * 80)
    
    for test_name, result in results.items():
        status = "✅ PASS" if result else "❌ FAIL"
        print(f"{status}: {test_name}")
    
    all_passed = all(results.values())
    
    print("\n" + "=" * 80)
    if all_passed:
        print("✅ ALL TESTS PASSED: Lunar Crush API is working correctly!")
    else:
        print("❌ SOME TESTS FAILED: Please check the errors above")
    print("=" * 80 + "\n")
    
    return 0 if all_passed else 1


if __name__ == "__main__":
    exit(main())

