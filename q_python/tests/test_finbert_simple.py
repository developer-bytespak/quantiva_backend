"""
Simple FinBERT Model Test
Quick test to verify FinBERT model works on your laptop.

This script:
1. Loads the FinBERT model and tokenizer
2. Tests sentiment analysis on sample financial texts
3. Verifies the model is working correctly
"""

import sys
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

# Load .env if available
try:
    from dotenv import load_dotenv
    env_path = Path(__file__).parent.parent / '.env'
    if env_path.exists():
        load_dotenv(env_path)
except ImportError:
    pass

import logging
from src.models.finbert import get_finbert_inference

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)

logger = logging.getLogger(__name__)


def test_finbert_model():
    """Test FinBERT model loading and inference."""
    print("\n" + "=" * 70)
    print("FinBERT Model Test")
    print("=" * 70)
    
    try:
        # Get inference instance
        print("\n[1/3] Initializing FinBERT inference...")
        inference = get_finbert_inference()
        print("✓ Inference instance created")
        
        # Test model loading with a simple inference
        print("\n[2/3] Loading model (this may take 30-60 seconds on first run)...")
        test_text = "The stock market is performing well today."
        result = inference.analyze_sentiment(test_text)
        
        if result.get('error', False):
            print(f"✗ Error: {result.get('error_message', 'Unknown error')}")
            return False
        
        print("✓ Model loaded successfully")
        print(f"  - Device: {inference.model_manager.device}")
        print(f"  - Model path: {inference.model_manager.model_path}")
        
        # Test sentiment analysis
        print("\n[3/3] Testing sentiment analysis...")
        print("-" * 70)
        
        test_cases = [
            "Apple Inc. reported record-breaking quarterly earnings, exceeding all analyst expectations.",
            "The company faces bankruptcy due to massive debt and declining sales.",
            "The stock market closed at the same level as yesterday with minimal volatility.",
            "Tesla shares surged 15% after announcing breakthrough battery technology.",
            "Investors are concerned about the upcoming recession and market crash."
        ]
        
        results = []
        for i, text in enumerate(test_cases, 1):
            result = inference.analyze_sentiment(text)
            sentiment = result.get('sentiment', 'unknown')
            score = result.get('score', 0.0)
            confidence = result.get('confidence', 0.0)
            
            print(f"\nTest {i}:")
            print(f"  Text: {text[:60]}...")
            print(f"  Sentiment: {sentiment}")
            print(f"  Score: {score:.3f} (range: -1.0 to 1.0)")
            print(f"  Confidence: {confidence:.3f}")
            
            if not result.get('error', False):
                results.append(True)
            else:
                print(f"  ✗ Error: {result.get('error_message', 'Unknown')}")
                results.append(False)
        
        # Summary
        print("\n" + "-" * 70)
        passed = sum(results)
        total = len(results)
        print(f"\n✓ {passed}/{total} tests passed")
        
        if passed == total:
            print("\n✅ SUCCESS: FinBERT model is working correctly on your laptop!")
            return True
        else:
            print(f"\n⚠ WARNING: {total - passed} test(s) failed")
            return False
            
    except Exception as e:
        print(f"\n✗ Test failed with error: {str(e)}")
        import traceback
        traceback.print_exc()
        return False


def main():
    """Main function."""
    success = test_finbert_model()
    
    print("\n" + "=" * 70)
    if success:
        print("✅ All tests passed!")
    else:
        print("❌ Some tests failed. Check the errors above.")
    print("=" * 70 + "\n")
    
    return 0 if success else 1


if __name__ == "__main__":
    exit(main())

