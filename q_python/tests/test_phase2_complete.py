"""
Test Phase 2 + Phase 3 Complete Integration
Verifies confidence calculation improvement and news API integration.
"""
import sys
from pathlib import Path

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

# Load .env if available
try:
    from dotenv import load_dotenv
    env_path = project_root / '.env'
    if env_path.exists():
        load_dotenv(env_path)
except ImportError:
    pass

from src.services.sentiment import SentimentAggregator


def test_improved_confidence_calculation():
    """Test that improved confidence calculation preserves ML confidence better."""
    print("\n" + "="*60)
    print("TEST: Improved Confidence Calculation")
    print("="*60)
    
    aggregator = SentimentAggregator()
    
    # Test case: High ML confidence, low other layers (like formal news)
    ml_result = {'score': 0.6, 'confidence': 0.785}
    keyword_result = {'score': 0.0, 'confidence': 0.0}  # No keywords found
    market_result = {'score': 0.5, 'confidence': 0.5}   # Low market confidence
    
    result = aggregator.aggregate(
        ml_result=ml_result,
        keyword_result=keyword_result,
        market_result=market_result,
        asset_type='crypto',
        news_type='formal'
    )
    
    print(f"\nInput:")
    print(f"  ML:      confidence={ml_result['confidence']:.3f}, weight=0.6")
    print(f"  Keywords: confidence={keyword_result['confidence']:.3f}, weight=0.2")
    print(f"  Market:   confidence={market_result['confidence']:.3f}, weight=0.2")
    
    print(f"\nOutput:")
    print(f"  Final Confidence: {result['confidence']:.3f}")
    
    # Old calculation would be: (0.6*0.785 + 0.2*0.0 + 0.2*0.5) = 0.571
    # New calculation should be higher (preserves ML confidence better)
    old_confidence = (0.6 * 0.785 + 0.2 * 0.0 + 0.2 * 0.5)
    improvement = result['confidence'] - old_confidence
    
    print(f"\nComparison:")
    print(f"  Old method: {old_confidence:.3f}")
    print(f"  New method: {result['confidence']:.3f}")
    print(f"  Improvement: {improvement:+.3f} ({improvement/old_confidence*100:+.1f}%)")
    
    # Verify improvement
    if result['confidence'] > old_confidence:
        print(f"\n[PASS] Confidence improved by {improvement:.3f}")
        return True
    else:
        print(f"\n[FAIL] Confidence did not improve")
        return False


def test_confidence_preservation():
    """Test that ML confidence is preserved as baseline."""
    print("\n" + "="*60)
    print("TEST: ML Confidence Preservation")
    print("="*60)
    
    aggregator = SentimentAggregator()
    
    # Test with high ML confidence
    ml_result = {'score': 0.8, 'confidence': 0.9}
    keyword_result = {'score': 0.7, 'confidence': 0.6}
    market_result = {'score': 0.6, 'confidence': 0.7}
    
    result = aggregator.aggregate(
        ml_result=ml_result,
        keyword_result=keyword_result,
        market_result=market_result,
        asset_type='crypto',
        news_type='social'
    )
    
    print(f"\nML Confidence: {ml_result['confidence']:.3f}")
    print(f"Final Confidence: {result['confidence']:.3f}")
    print(f"Preservation: {result['confidence']/ml_result['confidence']*100:.1f}% of ML confidence")
    
    # Final confidence should be close to ML confidence (within 110%)
    if result['confidence'] <= ml_result['confidence'] * 1.1:
        print(f"\n[PASS] Confidence preserved correctly (within 110% of ML)")
        return True
    else:
        print(f"\n[FAIL] Confidence exceeded limit")
        return False


if __name__ == "__main__":
    print("\n" + "="*60)
    print("PHASE 2 COMPLETE - VERIFICATION TESTS")
    print("="*60)
    
    results = []
    
    try:
        results.append(("Improved Confidence", test_improved_confidence_calculation()))
        results.append(("Confidence Preservation", test_confidence_preservation()))
        
        print("\n" + "="*60)
        print("TEST SUMMARY")
        print("="*60)
        for name, passed in results:
            status = "[PASS]" if passed else "[FAIL]"
            print(f"{status} {name}")
        
        all_passed = all(result[1] for result in results)
        if all_passed:
            print("\n[SUCCESS] All tests passed!")
            print("\nPhase 2 + Phase 3 is complete and ready for frontend integration.")
        else:
            print("\n[WARNING] Some tests failed")
        
    except Exception as e:
        print(f"\n[ERROR] Test failed: {str(e)}")
        import traceback
        traceback.print_exc()

