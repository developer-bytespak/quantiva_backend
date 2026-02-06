"""
Test news description generation using Gemini API for LunarCrush crypto news.
"""
import sys
import os
from pathlib import Path

# Add q_python to path
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from src.services.data.lunarcrush_service import LunarCrushService


def test_description_generation():
    """Test Gemini-based description generation for crypto news."""
    print("\n" + "="*80)
    print("Testing News Description Generation with Gemini API")
    print("="*80 + "\n")
    
    try:
        # Initialize LunarCrush service
        service = LunarCrushService()
        
        # Test cases with various news titles
        test_cases = [
            ("BTC", "Bitcoin Reaches New All-Time High Above $100,000"),
            ("ETH", "Ethereum Undergoes Major Network Upgrade"),
            ("SOL", "Solana Network Achieves Record Transaction Speed"),
            ("XRP", "XRP Listed on New Major Exchange"),
            ("ADA", "Cardano Community Votes on Chain Governance Proposal"),
        ]
        
        print("Generating descriptions for crypto news headlines...\n")
        
        for symbol, title in test_cases:
            print(f"Symbol: {symbol}")
            print(f"Title: {title}")
            
            description = service._generate_description_with_gemini(title, symbol)
            
            print(f"Generated Description: {description if description else '(Failed to generate)'}")
            print(f"Length: {len(description)} characters")
            print("-" * 80 + "\n")
        
        print("✅ Test completed successfully!")
        
    except Exception as e:
        print(f"❌ Error during testing: {str(e)}")
        import traceback
        traceback.print_exc()


def test_lunarcrush_fetch():
    """Test fetching actual LunarCrush news with generated descriptions."""
    print("\n" + "="*80)
    print("Testing LunarCrush News Fetch with Generated Descriptions")
    print("="*80 + "\n")
    
    try:
        service = LunarCrushService()
        
        # Fetch news for BTC
        symbol = "BTC"
        print(f"Fetching {limit} news items for {symbol}...\n")
        
        limit = 3
        news_items = service.fetch_coin_news(symbol, limit=limit)
        
        if news_items:
            for i, item in enumerate(news_items, 1):
                print(f"News Item #{i}:")
                print(f"  Title: {item.get('title', 'N/A')}")
                print(f"  Description: {item.get('text', '(Not available)')}")
                print(f"  Source: {item.get('source', 'N/A')}")
                print(f"  URL: {item.get('url', 'N/A')[:60]}...")
                print(f"  Published: {item.get('published_at', 'N/A')}")
                print("-" * 80 + "\n")
            
            print(f"✅ Successfully fetched {len(news_items)} news items with descriptions!")
        else:
            print("❌ No news items returned")
            
    except Exception as e:
        print(f"❌ Error during LunarCrush fetch: {str(e)}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    print("\n🚀 News Description Generation Tests\n")
    
    # Test 1: Direct description generation
    test_description_generation()
    
    # Test 2: Full LunarCrush fetch with descriptions
    test_lunarcrush_fetch()
    
    print("\n" + "="*80)
    print("All tests completed!")
    print("="*80 + "\n")
