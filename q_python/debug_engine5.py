"""
Debug script for Engine 5 - Check why events are 0
"""
import sys
import os
import logging

# Add src to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))

# Set up logging to see what's happening
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

from src.services.engines.event_risk_engine import EventRiskEngine
from src.services.data.stock_news_service import StockNewsService
from src.services.data.lunarcrush_service import LunarCrushService

def debug_stock_news():
    """Debug stock news fetching."""
    print("\n" + "=" * 80)
    print("DEBUG: Stock News Fetching")
    print("=" * 80)
    
    service = StockNewsService()
    news = service.fetch_news('AAPL', limit=10)
    
    print(f"\nFetched {len(news)} news articles")
    
    if news:
        print("\nFirst 3 articles:")
        for i, article in enumerate(news[:3], 1):
            print(f"\n{i}. Title: {article.get('title', 'N/A')[:80]}")
            print(f"   Published: {article.get('published_at')}")
            print(f"   Text preview: {article.get('text', '')[:100]}...")
            
            # Check for earnings keywords
            title = article.get('title', '').lower()
            text = article.get('text', '').lower()
            combined = f"{title} {text}"
            
            earnings_keywords = ['earnings', 'quarterly', 'q1', 'q2', 'q3', 'q4']
            has_earnings = any(kw in combined for kw in earnings_keywords)
            print(f"   Has earnings keywords: {has_earnings}")
    else:
        print("\n⚠️  No news fetched!")

def debug_crypto_news():
    """Debug crypto news fetching."""
    print("\n" + "=" * 80)
    print("DEBUG: Crypto News Fetching")
    print("=" * 80)
    
    service = LunarCrushService()
    news = service.fetch_coin_news('BTC', limit=10)
    
    print(f"\nFetched {len(news)} news articles")
    
    if news:
        print("\nFirst 3 articles:")
        for i, article in enumerate(news[:3], 1):
            print(f"\n{i}. Title: {article.get('title', 'N/A')[:80]}")
            print(f"   Published: {article.get('published_at')}")
            print(f"   Text preview: {article.get('text', '')[:100]}...")
            
            # Check for event keywords
            title = article.get('title', '').lower()
            text = article.get('text', '').lower()
            combined = f"{title} {text}"
            
            event_keywords = ['listing', 'fork', 'partnership', 'unlock', 'regulatory']
            matches = [kw for kw in event_keywords if kw in combined]
            print(f"   Event keywords found: {matches if matches else 'None'}")
    else:
        print("\n⚠️  No news fetched!")

def debug_event_detection():
    """Debug event detection."""
    print("\n" + "=" * 80)
    print("DEBUG: Event Detection")
    print("=" * 80)
    
    engine = EventRiskEngine()
    
    # Test stock
    print("\n1. Testing AAPL event detection...")
    events = engine._get_upcoming_events('AAPL', 'stock', days_ahead=30)
    print(f"   Detected {len(events)} events")
    if events:
        for event in events[:3]:
            print(f"   - {event.get('type')}: {event.get('date')}")
    
    # Test crypto
    print("\n2. Testing BTC event detection...")
    events = engine._get_upcoming_events('BTC', 'crypto', days_ahead=30)
    print(f"   Detected {len(events)} events")
    if events:
        for event in events[:3]:
            print(f"   - {event.get('type')}: {event.get('date')}")

if __name__ == '__main__':
    debug_stock_news()
    debug_crypto_news()
    debug_event_detection()

