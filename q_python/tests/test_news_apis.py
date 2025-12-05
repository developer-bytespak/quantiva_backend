"""
Combined test script to verify both Lunar Crush API and Stock News API.

This script tests both APIs and provides a comprehensive report.
"""

import sys
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

# Import test functions
try:
    from tests.test_lunarcrush_api import test_lunarcrush_news, test_lunarcrush_social_metrics
    from tests.test_stock_news_api import test_stock_news
except ImportError:
    # Fallback if running from tests directory
    from test_lunarcrush_api import test_lunarcrush_news, test_lunarcrush_social_metrics
    from test_stock_news_api import test_stock_news

from src.config import LUNARCRUSH_API_KEY, STOCK_NEWS_API_KEY


def print_header(title):
    """Print a formatted header."""
    print("\n\n" + "=" * 80)
    print(title.center(80))
    print("=" * 80 + "\n")


def main():
    """Main test function for both APIs."""
    print_header("NEWS APIs COMPREHENSIVE TEST")
    
    results = {}
    
    # Test Lunar Crush API
    print_header("TESTING LUNAR CRUSH API")
    
    if not LUNARCRUSH_API_KEY:
        print("⚠ SKIPPING: LUNARCRUSH_API_KEY not set")
        results['lunarcrush_news'] = None
        results['lunarcrush_metrics'] = None
    else:
        print("Testing Lunar Crush news fetching...")
        results['lunarcrush_news'] = test_lunarcrush_news("BTC", limit=5)
        
        print("\n\nTesting Lunar Crush social metrics...")
        results['lunarcrush_metrics'] = test_lunarcrush_social_metrics("BTC")
    
    # Test Stock News API
    print_header("TESTING STOCK NEWS API")
    
    if not STOCK_NEWS_API_KEY:
        print("⚠ SKIPPING: STOCK_NEWS_API_KEY not set")
        results['stock_news'] = None
    else:
        print("Testing Stock News API...")
        results['stock_news'] = test_stock_news("AAPL", limit=10)
    
    # Final Summary
    print_header("FINAL TEST SUMMARY")
    
    print("Test Results:")
    print("-" * 80)
    
    for test_name, result in results.items():
        if result is None:
            status = "⚠ SKIPPED"
        elif result:
            status = "✅ PASS"
        else:
            status = "❌ FAIL"
        print(f"{status}: {test_name}")
    
    print("-" * 80)
    
    # Count results
    passed = sum(1 for r in results.values() if r is True)
    failed = sum(1 for r in results.values() if r is False)
    skipped = sum(1 for r in results.values() if r is None)
    total = len(results)
    
    print(f"\nSummary: {passed} passed, {failed} failed, {skipped} skipped out of {total} tests")
    
    print("\n" + "=" * 80)
    if failed == 0 and passed > 0:
        print("✅ ALL TESTS PASSED: Both APIs are working correctly!")
    elif failed > 0:
        print("❌ SOME TESTS FAILED: Please check the errors above")
    else:
        print("⚠ NO TESTS RUN: API keys not configured")
    print("=" * 80 + "\n")
    
    return 0 if failed == 0 and passed > 0 else 1


if __name__ == "__main__":
    exit(main())

