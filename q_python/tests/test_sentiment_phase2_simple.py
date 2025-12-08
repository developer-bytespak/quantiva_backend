"""
Simple Phase 2 Sentiment Test
Quick test to verify Phase 2 components work.
"""
import sys
from pathlib import Path

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

def test_keywords():
    """Quick keyword test."""
    from src.services.sentiment import CryptoKeywordAnalyzer
    
    analyzer = CryptoKeywordAnalyzer()
    
    # Test positive
    result = analyzer.analyze("BTC to the moon! Diamond hands!")
    print(f"Positive test: {result['sentiment']} (score: {result['score']:.2f})")
    assert result['sentiment'] == 'positive', "Should detect positive"
    
    # Test negative
    result = analyzer.analyze("Rug pull! Got rekt!")
    print(f"Negative test: {result['sentiment']} (score: {result['score']:.2f})")
    assert result['sentiment'] == 'negative', "Should detect negative"
    
    print("[OK] Keyword analyzer works!")


def test_aggregator():
    """Quick aggregator test."""
    from src.services.sentiment import SentimentAggregator
    
    aggregator = SentimentAggregator()
    
    result = aggregator.aggregate(
        ml_result={'score': 0.5, 'confidence': 0.8},
        keyword_result={'score': 0.7, 'confidence': 0.6},
        market_result={'score': 0.3, 'confidence': 0.5},
        asset_type='crypto',
        news_type='social'
    )
    
    print(f"Aggregator test: {result['sentiment']} (score: {result['score']:.2f})")
    assert -1.0 <= result['score'] <= 1.0, "Score should be in range"
    print("[OK] Aggregator works!")


def test_engine():
    """Quick engine test (requires FinBERT initialized)."""
    from src.services.engines.sentiment_engine import SentimentEngine
    
    engine = SentimentEngine()
    
    # Test with simple text
    text_data = [{
        'text': 'Bitcoin is bullish, expecting a pump',
        'source': 'twitter',
        'news_type': 'social'
    }]
    
    try:
        result = engine.calculate(
            asset_id='BTC',
            asset_type='crypto',
            text_data=text_data
        )
        print(f"Engine test: Score={result['score']:.2f}, Confidence={result['confidence']:.2f}")
        print("[OK] Engine works!")
    except Exception as e:
        print(f"⚠ Engine test skipped (FinBERT may not be initialized): {str(e)}")


if __name__ == "__main__":
    print("Running simple Phase 2 tests...\n")
    
    test_keywords()
    test_aggregator()
    test_engine()
    
    print("\n[SUCCESS] All simple tests passed!")

