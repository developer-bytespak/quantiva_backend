"""
Test script to verify Stock News API is fetching real-life news.

This script tests the Stock News API integration and verifies that:
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
    "stock_news_service",
    Path(__file__).parent.parent / "src" / "services" / "data" / "stock_news_service.py"
)
stock_news_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stock_news_module)
StockNewsService = stock_news_module.StockNewsService

from src.config import STOCK_NEWS_API_KEY
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


def test_stock_news(symbol="AAPL", limit=10):
    """
    Test Stock News API news fetching.
    
    Args:
        symbol: Stock symbol to test (default: AAPL)
        limit: Number of news items to fetch (default: 10)
    """
    print_separator()
    print(f"Testing Stock News API - Fetching news for {symbol}")
    print_separator()
    
    # Check API key
    if not STOCK_NEWS_API_KEY:
        print("❌ ERROR: STOCK_NEWS_API_KEY not set in environment variables")
        print("   Please set STOCK_NEWS_API_KEY before running this test")
        return False
    
    print(f"✓ API Key found: {STOCK_NEWS_API_KEY[:10]}...{STOCK_NEWS_API_KEY[-4:]}")
    print()
    
    # Initialize service
    service = StockNewsService()
    
    # Fetch news
    print(f"Fetching news for {symbol} (limit: {limit})...")
    try:
        news_items = service.fetch_news(symbol, limit=limit)
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
        title = item.get('title', 'N/A')
        print(f"   Title: {title[:100]}{'...' if len(title) > 100 else ''}")
        print(f"   Source: {item.get('source', 'N/A')}")
        print(f"   Published: {format_date(item.get('published_at'))}")
        url = item.get('url', 'N/A')
        print(f"   URL: {url[:80]}{'...' if len(url) > 80 else ''}")
        text = item.get('text', '')
        if text:
            print(f"   Text preview: {text[:150]}...")
        
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
        print("✅ SUCCESS: Stock News API is fetching real-life news!")
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


def test_stock_news_multiple_symbols():
    """Test Stock News API with multiple stock symbols."""
    print_separator()
    print("Testing Stock News API with multiple symbols")
    print_separator()
    
    test_symbols = ["AAPL", "TSLA", "MSFT", "GOOGL", "NVDA"]
    results = {}
    
    for symbol in test_symbols:
        print(f"\n\n{'='*80}")
        print(f"TESTING SYMBOL: {symbol}")
        print('='*80)
        
        result = test_stock_news(symbol, limit=5)
        results[symbol] = result
    
    # Summary
    print("\n\n" + "=" * 80)
    print("MULTI-SYMBOL TEST SUMMARY")
    print("=" * 80)
    
    for symbol, result in results.items():
        status = "✅ PASS" if result else "❌ FAIL"
        print(f"{status}: {symbol}")
    
    passed = sum(1 for r in results.values() if r)
    total = len(results)
    
    print(f"\nPassed: {passed}/{total}")
    print("=" * 80 + "\n")
    
    return passed == total


def main():
    """Main test function."""
    print("\n" + "=" * 80)
    print("STOCK NEWS API TEST SCRIPT")
    print("=" * 80)
    
    # Test with single symbol first
    print("\n\n" + "=" * 80)
    print("SINGLE SYMBOL TEST")
    print("=" * 80)
    single_result = test_stock_news("AAPL", limit=10)
    
    # Test with multiple symbols
    print("\n\n" + "=" * 80)
    print("MULTIPLE SYMBOLS TEST")
    print("=" * 80)
    multi_result = test_stock_news_multiple_symbols()
    
    # Final summary
    print("\n\n" + "=" * 80)
    print("FINAL TEST SUMMARY")
    print("=" * 80)
    
    print(f"Single symbol test (AAPL): {'✅ PASS' if single_result else '❌ FAIL'}")
    print(f"Multiple symbols test: {'✅ PASS' if multi_result else '❌ FAIL'}")
    
    all_passed = single_result and multi_result
    
    print("\n" + "=" * 80)
    if all_passed:
        print("✅ ALL TESTS PASSED: Stock News API is working correctly!")
    else:
        print("❌ SOME TESTS FAILED: Please check the errors above")
    print("=" * 80 + "\n")
    
    return 0 if all_passed else 1


if __name__ == "__main__":
    exit(main())

