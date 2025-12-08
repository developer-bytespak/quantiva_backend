"""
Test Phase 2 Sentiment Implementation
Tests crypto keyword analysis, sentiment aggregation, and market signals.
"""
import sys
import os
from pathlib import Path

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from src.services.sentiment import CryptoKeywordAnalyzer, SentimentAggregator, MarketSignalAnalyzer
from src.services.engines.sentiment_engine import SentimentEngine


def test_crypto_keyword_analyzer():
    """Test crypto keyword analyzer with various crypto slang."""
    print("\n" + "="*60)
    print("TEST 1: Crypto Keyword Analyzer")
    print("="*60)
    
    analyzer = CryptoKeywordAnalyzer()
    
    test_cases = [
        ("BTC is going to the moon! Diamond hands! 🚀", "positive"),
        ("This coin got rekt, total rug pull", "negative"),
        ("Market is consolidating, sideways movement", "neutral"),
        ("Bullish on ETH, expecting a pump soon", "positive"),
        ("FUD everywhere, bearish sentiment", "negative"),
        ("Bitcoin reached ATH, massive surge!", "positive"),
        ("Hack detected, exploit found in protocol", "negative"),
    ]
    
    print("\nTesting keyword detection:")
    for text, expected_sentiment in test_cases:
        result = analyzer.analyze(text)
        matched = "[OK]" if result['sentiment'] == expected_sentiment else "[FAIL]"
        print(f"\n{matched} Text: {text[:50]}...")
        print(f"   Sentiment: {result['sentiment']} (expected: {expected_sentiment})")
        print(f"   Score: {result['score']:.2f}")
        print(f"   Confidence: {result['confidence']:.2f}")
        print(f"   Matched keywords: {result['matched_keywords']}")


def test_sentiment_aggregator():
    """Test sentiment aggregator with different routing scenarios."""
    print("\n" + "="*60)
    print("TEST 2: Sentiment Aggregator")
    print("="*60)
    
    aggregator = SentimentAggregator()
    
    # Test case 1: Crypto Social Media
    print("\n1. Crypto Social Media (ML 50%, Keywords 30%, Market 20%):")
    ml_result = {'score': 0.6, 'confidence': 0.8}
    keyword_result = {'score': 0.8, 'confidence': 0.7}
    market_result = {'score': 0.5, 'confidence': 0.6}
    
    result = aggregator.aggregate(
        ml_result=ml_result,
        keyword_result=keyword_result,
        market_result=market_result,
        asset_type='crypto',
        news_type='social'
    )
    print(f"   Final Score: {result['score']:.3f}")
    print(f"   Final Confidence: {result['confidence']:.3f}")
    print(f"   Sentiment: {result['sentiment']}")
    print(f"   Weights: ML={result['layers']['ml_weight']}, Keywords={result['layers']['keyword_weight']}, Market={result['layers']['market_weight']}")
    
    # Test case 2: Crypto Formal News
    print("\n2. Crypto Formal News (ML 60%, Keywords 20%, Market 20%):")
    result = aggregator.aggregate(
        ml_result=ml_result,
        keyword_result=keyword_result,
        market_result=market_result,
        asset_type='crypto',
        news_type='formal'
    )
    print(f"   Final Score: {result['score']:.3f}")
    print(f"   Final Confidence: {result['confidence']:.3f}")
    print(f"   Sentiment: {result['sentiment']}")
    print(f"   Weights: ML={result['layers']['ml_weight']}, Keywords={result['layers']['keyword_weight']}, Market={result['layers']['market_weight']}")
    
    # Test case 3: Stock News
    print("\n3. Stock News (ML 80%, Market 20%, no Keywords):")
    result = aggregator.aggregate(
        ml_result=ml_result,
        keyword_result=None,
        market_result=market_result,
        asset_type='stock',
        news_type='formal'
    )
    print(f"   Final Score: {result['score']:.3f}")
    print(f"   Final Confidence: {result['confidence']:.3f}")
    print(f"   Sentiment: {result['sentiment']}")
    print(f"   Weights: ML={result['layers']['ml_weight']}, Keywords={result['layers']['keyword_weight']}, Market={result['layers']['market_weight']}")


def test_market_signal_analyzer():
    """Test market signal analyzer (may fail if NestJS API not available)."""
    print("\n" + "="*60)
    print("TEST 3: Market Signal Analyzer")
    print("="*60)
    
    analyzer = MarketSignalAnalyzer()
    
    # Test with BTC (connection_id optional)
    print("\nTesting market signals for BTC (connection_id not provided):")
    print("Note: This will use LunarCrush data only if NestJS API unavailable")
    
    result = analyzer.analyze(
        symbol='BTC',
        asset_type='crypto',
        exchange='binance',
        connection_id=None  # Will gracefully degrade
    )
    
    print(f"   Market Score: {result['score']:.3f}")
    print(f"   Confidence: {result['confidence']:.3f}")
    print(f"   Signals: {result['signals']}")


def test_sentiment_engine_integration():
    """Test full sentiment engine with all layers integrated."""
    print("\n" + "="*60)
    print("TEST 4: Sentiment Engine Integration")
    print("="*60)
    
    engine = SentimentEngine()
    
    # Test case 1: Crypto with crypto slang
    print("\n1. Crypto News with Slang (should use keywords):")
    crypto_text = [
        {
            'text': 'Bitcoin is going to the moon! Diamond hands! Massive pump incoming!',
            'source': 'twitter',
            'news_type': 'social'
        }
    ]
    
    result = engine.calculate(
        asset_id='BTC',
        asset_type='crypto',
        text_data=crypto_text,
        exchange='binance'
    )
    
    print(f"   Final Score: {result['score']:.3f}")
    print(f"   Confidence: {result['confidence']:.3f}")
    print(f"   Metadata keys: {list(result.get('metadata', {}).keys())}")
    if 'layer_breakdown' in result.get('metadata', {}):
        print(f"   Layer Breakdown: {result['metadata']['layer_breakdown']}")
    if 'keyword_analysis' in result.get('metadata', {}):
        keyword = result['metadata']['keyword_analysis']
        if keyword:
            print(f"   Keyword Score: {keyword.get('score', 0):.3f}")
    
    # Test case 2: Stock news (should not use keywords)
    print("\n2. Stock News (should NOT use keywords):")
    stock_text = [
        {
            'text': 'Apple reports strong earnings, stock price rises',
            'source': 'Bloomberg News',
            'news_type': 'formal'
        }
    ]
    
    result = engine.calculate(
        asset_id='AAPL',
        asset_type='stock',
        text_data=stock_text
    )
    
    print(f"   Final Score: {result['score']:.3f}")
    print(f"   Confidence: {result['confidence']:.3f}")
    if 'keyword_analysis' in result.get('metadata', {}):
        keyword = result['metadata']['keyword_analysis']
        print(f"   Keyword Analysis: {keyword} (should be None for stocks)")


def test_news_type_detection():
    """Test news type auto-detection."""
    print("\n" + "="*60)
    print("TEST 5: News Type Auto-Detection")
    print("="*60)
    
    engine = SentimentEngine()
    
    test_sources = [
        ('Twitter', 'social'),
        ('Reddit', 'social'),
        ('Cryptonews.com', 'formal'),
        ('Cointelegraph', 'formal'),
        ('Forbes', 'formal'),
        ('unknown', 'formal'),  # Default
    ]
    
    print("\nTesting source detection:")
    for source, expected in test_sources:
        detected = engine._detect_news_type_from_source(source)
        status = "[OK]" if detected == expected else "[FAIL]"
        print(f"   {status} Source: '{source}' -> {detected} (expected: {expected})")


def main():
    """Run all tests."""
    print("\n" + "="*60)
    print("PHASE 2 SENTIMENT IMPLEMENTATION - TEST SUITE")
    print("="*60)
    
    try:
        # Test 1: Keyword Analyzer
        test_crypto_keyword_analyzer()
        
        # Test 2: Aggregator
        test_sentiment_aggregator()
        
        # Test 3: Market Signals (may have limited functionality without connection_id)
        test_market_signal_analyzer()
        
        # Test 4: Full Integration
        test_sentiment_engine_integration()
        
        # Test 5: News Type Detection
        test_news_type_detection()
        
        print("\n" + "="*60)
        print("ALL TESTS COMPLETED")
        print("="*60)
        print("\nNote: Some tests may show warnings if:")
        print("  - FinBERT model not initialized (first run)")
        print("  - NestJS API unavailable (market signals will use LunarCrush only)")
        print("  - Connection ID not provided (market signals degraded)")
        
    except Exception as e:
        print(f"\n❌ TEST FAILED: {str(e)}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    main()

