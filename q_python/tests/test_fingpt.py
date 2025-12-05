"""
Test script for FinGPT model integration.
Run this to test the FinGPT sentiment analysis model.
"""
import sys
import os

# Add project root to path so we can import from src
project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, project_root)

from src.models.fingpt import get_fingpt_inference
from src.services.engines.sentiment_engine import SentimentEngine
import logging

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

logger = logging.getLogger(__name__)


def test_tokenizer():
    """Test the tokenizer functionality."""
    print("\n" + "="*60)
    print("Testing FinGPT Tokenizer")
    print("="*60)
    
    try:
        from src.models.fingpt import FinGPTTokenizer
        
        tokenizer = FinGPTTokenizer()
        
        # Test single text
        test_text = "Bitcoin price surges to new all-time high amid institutional adoption"
        tokens = tokenizer.tokenize(test_text)
        print(f"\n✓ Tokenizer loaded successfully")
        print(f"✓ Tokenized text: {len(tokens['input_ids'][0])} tokens")
        
        # Test batch
        texts = [
            "Stock market rallies on positive earnings reports",
            "Crypto market crashes following regulatory news"
        ]
        batch_tokens = tokenizer.tokenize_batch(texts)
        print(f"✓ Batch tokenization: {len(batch_tokens['input_ids'])} texts")
        
        return True
    except Exception as e:
        print(f"✗ Tokenizer test failed: {str(e)}")
        return False


def test_model_loading():
    """Test model loading."""
    print("\n" + "="*60)
    print("Testing FinGPT Model Loading")
    print("="*60)
    
    try:
        from src.models.fingpt import FinGPTModel
        
        model_manager = FinGPTModel()
        print(f"\n✓ Model manager created")
        print(f"✓ Device: {model_manager.device}")
        print(f"✓ Dtype: {model_manager.torch_dtype}")
        
        print("\nLoading model (this may take 1-2 minutes on first run)...")
        model = model_manager.load()
        print(f"✓ Model loaded successfully")
        print(f"✓ Model type: {type(model).__name__}")
        
        return True
    except Exception as e:
        print(f"✗ Model loading failed: {str(e)}")
        print("\nNote: Make sure you have:")
        print("  1. Installed all dependencies: pip install -r requirements/base.txt")
        print("  2. Hugging Face authentication (if model is gated)")
        print("  3. Sufficient GPU memory (~7GB for 16-bit) or CPU memory")
        return False


def test_sentiment_analysis():
    """Test sentiment analysis inference."""
    print("\n" + "="*60)
    print("Testing FinGPT Sentiment Analysis")
    print("="*60)
    
    try:
        inference = get_fingpt_inference()
        print("\n✓ Inference instance created")
        
        # Test cases
        test_cases = [
            {
                "text": "Bitcoin reaches new all-time high as institutional investors pour billions into cryptocurrency market",
                "expected": "positive"
            },
            {
                "text": "Stock market remains stable with minimal fluctuations throughout the trading day",
                "expected": "neutral"
            },
            {
                "text": "Major tech company stock plummets 20% after disappointing quarterly earnings report",
                "expected": "negative"
            }
        ]
        
        print("\nAnalyzing test cases...")
        for i, test_case in enumerate(test_cases, 1):
            print(f"\nTest {i}:")
            print(f"Text: {test_case['text'][:80]}...")
            
            result = inference.analyze_sentiment(test_case['text'])
            
            print(f"  Sentiment: {result['sentiment']}")
            print(f"  Confidence: {result['confidence']:.2f}")
            print(f"  Raw output: {result.get('raw_output', '')[:100]}...")
            
            if result['sentiment'] == test_case['expected']:
                print(f"  ✓ Expected sentiment matched!")
            else:
                print(f"  ⚠ Expected '{test_case['expected']}', got '{result['sentiment']}'")
        
        return True
    except Exception as e:
        print(f"✗ Sentiment analysis test failed: {str(e)}")
        import traceback
        traceback.print_exc()
        return False


def test_sentiment_engine():
    """Test the SentimentEngine integration."""
    print("\n" + "="*60)
    print("Testing SentimentEngine Integration")
    print("="*60)
    
    try:
        engine = SentimentEngine()
        print("\n✓ SentimentEngine created")
        
        # Prepare test data
        text_data = [
            {
                "text": "Apple stock surges after announcing record-breaking iPhone sales",
                "source": "news"
            },
            {
                "text": "Tech sector shows strong growth potential for Q4",
                "source": "twitter"
            },
            {
                "text": "Market analysts predict continued bullish trend",
                "source": "reddit"
            }
        ]
        
        print("\nCalculating sentiment score...")
        result = engine.calculate(
            asset_id="AAPL",
            asset_type="stock",
            text_data=text_data
        )
        
        print(f"\n✓ Sentiment score: {result['score']:.3f}")
        print(f"✓ Confidence: {result['confidence']:.3f}")
        print(f"✓ Overall sentiment: {result['metadata'].get('overall_sentiment', 'N/A')}")
        print(f"✓ Breakdown: {result['metadata'].get('sentiment_breakdown', {})}")
        print(f"✓ Total texts analyzed: {result['metadata'].get('total_texts', 0)}")
        
        # Verify score is in valid range
        assert -1.0 <= result['score'] <= 1.0, "Score must be in [-1, 1] range"
        assert 0.0 <= result['confidence'] <= 1.0, "Confidence must be in [0, 1] range"
        
        print("\n✓ All validations passed!")
        return True
    except Exception as e:
        print(f"✗ SentimentEngine test failed: {str(e)}")
        import traceback
        traceback.print_exc()
        return False


def test_batch_processing():
    """Test batch sentiment analysis."""
    print("\n" + "="*60)
    print("Testing Batch Processing")
    print("="*60)
    
    try:
        inference = get_fingpt_inference()
        
        texts = [
            "Positive news about cryptocurrency adoption",
            "Neutral market conditions persist",
            "Negative earnings report causes stock decline"
        ]
        
        print(f"\nAnalyzing {len(texts)} texts in batch...")
        results = inference.analyze_batch(texts)
        
        print(f"\n✓ Batch analysis completed")
        for i, result in enumerate(results, 1):
            print(f"  Text {i}: {result['sentiment']} (confidence: {result['confidence']:.2f})")
        
        # Test aggregation
        aggregated = inference.aggregate_sentiments(results)
        print(f"\n✓ Aggregated sentiment: {aggregated['overall_sentiment']}")
        print(f"✓ Aggregated score: {aggregated['score']:.3f}")
        print(f"✓ Breakdown: {aggregated['breakdown']}")
        
        return True
    except Exception as e:
        print(f"✗ Batch processing test failed: {str(e)}")
        return False


def main():
    """Run all tests."""
    print("\n" + "="*60)
    print("FinGPT Model Testing Suite")
    print("="*60)
    
    results = []
    
    # Run tests
    results.append(("Tokenizer", test_tokenizer()))
    results.append(("Model Loading", test_model_loading()))
    results.append(("Sentiment Analysis", test_sentiment_analysis()))
    results.append(("SentimentEngine", test_sentiment_engine()))
    results.append(("Batch Processing", test_batch_processing()))
    
    # Summary
    print("\n" + "="*60)
    print("Test Summary")
    print("="*60)
    
    for test_name, passed in results:
        status = "✓ PASSED" if passed else "✗ FAILED"
        print(f"{test_name}: {status}")
    
    total_passed = sum(1 for _, passed in results if passed)
    print(f"\nTotal: {total_passed}/{len(results)} tests passed")
    
    if total_passed == len(results):
        print("\n🎉 All tests passed!")
    else:
        print("\n⚠ Some tests failed. Check the output above for details.")


if __name__ == "__main__":
    main()

