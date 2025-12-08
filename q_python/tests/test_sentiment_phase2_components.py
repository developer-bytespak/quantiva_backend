"""
Test Phase 2 Components (No FinBERT Required)
Tests keyword analyzer and aggregator without requiring ML model initialization.
"""
import sys
from pathlib import Path

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))


def test_keyword_analyzer():
    """Test crypto keyword analyzer."""
    print("\n" + "="*60)
    print("TEST: Crypto Keyword Analyzer")
    print("="*60)
    
    from src.services.sentiment import CryptoKeywordAnalyzer
    
    analyzer = CryptoKeywordAnalyzer()
    
    test_cases = [
        ("BTC is going to the moon! Diamond hands! 🚀", "positive"),
        ("This coin got rekt, total rug pull", "negative"),
        ("Market is consolidating, sideways movement", "neutral"),
        ("Bullish on ETH, expecting a pump soon", "positive"),
        ("FUD everywhere, bearish sentiment", "negative"),
    ]
    
    passed = 0
    for text, expected in test_cases:
        result = analyzer.analyze(text)
        if result['sentiment'] == expected:
            passed += 1
            status = "[PASS]"
        else:
            status = "[FAIL]"
        print(f"{status} '{text[:40]}...' -> {result['sentiment']} (expected: {expected})")
        print(f"        Score: {result['score']:.2f}, Confidence: {result['confidence']:.2f}")
        print(f"        Keywords: {result['matched_keywords']}")
    
    print(f"\nResult: {passed}/{len(test_cases)} tests passed")
    return passed == len(test_cases)


def test_aggregator():
    """Test sentiment aggregator routing logic."""
    print("\n" + "="*60)
    print("TEST: Sentiment Aggregator")
    print("="*60)
    
    from src.services.sentiment import SentimentAggregator
    
    aggregator = SentimentAggregator()
    
    ml_result = {'score': 0.6, 'confidence': 0.8}
    keyword_result = {'score': 0.8, 'confidence': 0.7}
    market_result = {'score': 0.5, 'confidence': 0.6}
    
    # Test 1: Crypto Social
    result1 = aggregator.aggregate(
        ml_result, keyword_result, market_result,
        asset_type='crypto', news_type='social'
    )
    print(f"\n1. Crypto Social Media:")
    print(f"   Weights: ML={result1['layers']['ml_weight']}, Keywords={result1['layers']['keyword_weight']}, Market={result1['layers']['market_weight']}")
    print(f"   Final Score: {result1['score']:.3f}")
    expected_score1 = 0.6 * 0.5 + 0.8 * 0.3 + 0.5 * 0.2  # 0.30 + 0.24 + 0.10 = 0.64
    print(f"   Expected: {expected_score1:.3f}")
    assert abs(result1['score'] - expected_score1) < 0.01, "Score calculation incorrect"
    print("   [PASS]")
    
    # Test 2: Crypto Formal
    result2 = aggregator.aggregate(
        ml_result, keyword_result, market_result,
        asset_type='crypto', news_type='formal'
    )
    print(f"\n2. Crypto Formal News:")
    print(f"   Weights: ML={result2['layers']['ml_weight']}, Keywords={result2['layers']['keyword_weight']}, Market={result2['layers']['market_weight']}")
    print(f"   Final Score: {result2['score']:.3f}")
    expected_score2 = 0.6 * 0.6 + 0.8 * 0.2 + 0.5 * 0.2  # 0.36 + 0.16 + 0.10 = 0.62
    print(f"   Expected: {expected_score2:.3f}")
    assert abs(result2['score'] - expected_score2) < 0.01, "Score calculation incorrect"
    print("   [PASS]")
    
    # Test 3: Stock (no keywords)
    result3 = aggregator.aggregate(
        ml_result, None, market_result,
        asset_type='stock', news_type='formal'
    )
    print(f"\n3. Stock News:")
    print(f"   Weights: ML={result3['layers']['ml_weight']}, Keywords={result3['layers']['keyword_weight']}, Market={result3['layers']['market_weight']}")
    print(f"   Final Score: {result3['score']:.3f}")
    expected_score3 = 0.6 * 0.8 + 0.0 * 0.0 + 0.5 * 0.2  # 0.48 + 0.0 + 0.10 = 0.58
    print(f"   Expected: {expected_score3:.3f}")
    assert abs(result3['score'] - expected_score3) < 0.01, "Score calculation incorrect"
    print("   [PASS]")
    
    print("\n[SUCCESS] All aggregator tests passed!")
    return True


def test_market_signals():
    """Test market signal analyzer (may show warnings)."""
    print("\n" + "="*60)
    print("TEST: Market Signal Analyzer")
    print("="*60)
    
    from src.services.sentiment import MarketSignalAnalyzer
    
    analyzer = MarketSignalAnalyzer()
    
    # Test without connection_id (will use LunarCrush only)
    print("\nTesting BTC market signals (no connection_id):")
    result = analyzer.analyze('BTC', 'crypto', 'binance', connection_id=None)
    
    print(f"   Score: {result['score']:.3f}")
    print(f"   Confidence: {result['confidence']:.3f}")
    print(f"   Signals: {result['signals']}")
    
    # Test stock (should return neutral)
    print("\nTesting AAPL market signals (stock):")
    result2 = analyzer.analyze('AAPL', 'stock', 'binance')
    print(f"   Score: {result2['score']:.3f}")
    print(f"   Note: {result2['signals'].get('note', 'N/A')}")
    
    print("\n[OK] Market signal analyzer works (may have limited functionality)")
    return True


def main():
    """Run all component tests."""
    print("\n" + "="*60)
    print("PHASE 2 SENTIMENT - COMPONENT TESTS")
    print("(No FinBERT/ML model required)")
    print("="*60)
    
    results = []
    
    try:
        results.append(("Keyword Analyzer", test_keyword_analyzer()))
        results.append(("Aggregator", test_aggregator()))
        results.append(("Market Signals", test_market_signals()))
        
        print("\n" + "="*60)
        print("TEST SUMMARY")
        print("="*60)
        for name, passed in results:
            status = "[PASS]" if passed else "[FAIL]"
            print(f"{status} {name}")
        
        all_passed = all(result[1] for result in results)
        if all_passed:
            print("\n[SUCCESS] All component tests passed!")
        else:
            print("\n[WARNING] Some tests failed")
        
    except Exception as e:
        print(f"\n[ERROR] Test failed: {str(e)}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    main()

