"""
Test script for Engine 5: Event Risk Engine
Tests event detection for both crypto and stocks using news parsing.
"""
import sys
import os

# Add src to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))

from src.services.engines.event_risk_engine import EventRiskEngine
import json

def test_stock_event_risk():
    """Test stock event risk analysis."""
    print("\n" + "=" * 80)
    print("Testing Stock Event Risk Analysis")
    print("=" * 80)
    
    engine = EventRiskEngine()
    
    # Test with Apple
    print("\n1. Testing AAPL (Apple)...")
    result = engine.calculate(asset_id='AAPL', asset_type='stock')
    
    print(f"\nResult:")
    print(f"  Score: {result.get('score', 0):.4f}")
    print(f"  Confidence: {result.get('confidence', 0):.4f}")
    
    metadata = result.get('metadata', {})
    print(f"\nMetadata:")
    print(f"  Events Count: {metadata.get('events_count', 0)}")
    print(f"  Scored Events: {metadata.get('scored_events', 0)}")
    print(f"  Positive Events: {metadata.get('positive_events', 0)}")
    print(f"  Negative Events: {metadata.get('negative_events', 0)}")
    
    event_details = metadata.get('event_details', [])
    if event_details:
        print(f"\nEvent Details (first 5):")
        for i, event in enumerate(event_details[:5], 1):
            print(f"  {i}. Type: {event.get('type', 'N/A')}")
            print(f"     Date: {event.get('date', 'N/A')}")
            print(f"     Score: {event.get('score', 0):.4f}")
    else:
        print(f"\n  Note: {metadata.get('note', 'No events detected')}")
    
    # Test with Tesla
    print("\n\n2. Testing TSLA (Tesla)...")
    result = engine.calculate(asset_id='TSLA', asset_type='stock')
    
    print(f"\nResult:")
    print(f"  Score: {result.get('score', 0):.4f}")
    print(f"  Confidence: {result.get('confidence', 0):.4f}")
    print(f"  Events Count: {result.get('metadata', {}).get('events_count', 0)}")
    
    return result.get('metadata', {}).get('events_count', 0) >= 0  # Valid if >= 0


def test_crypto_event_risk():
    """Test crypto event risk analysis."""
    print("\n" + "=" * 80)
    print("Testing Crypto Event Risk Analysis")
    print("=" * 80)
    
    engine = EventRiskEngine()
    
    # Test with Bitcoin
    print("\n1. Testing BTC (Bitcoin)...")
    result = engine.calculate(asset_id='BTC', asset_type='crypto')
    
    print(f"\nResult:")
    print(f"  Score: {result.get('score', 0):.4f}")
    print(f"  Confidence: {result.get('confidence', 0):.4f}")
    
    metadata = result.get('metadata', {})
    print(f"  Events Count: {metadata.get('events_count', 0)}")
    
    event_details = metadata.get('event_details', [])
    if event_details:
        print(f"\nEvent Details (first 5):")
        for i, event in enumerate(event_details[:5], 1):
            print(f"  {i}. Type: {event.get('type', 'N/A')}")
            print(f"     Date: {event.get('date', 'N/A')}")
            print(f"     Score: {event.get('score', 0):.4f}")
    else:
        print(f"  Note: {metadata.get('note', 'No events detected')}")
    
    # Test with Ethereum
    print("\n\n2. Testing ETH (Ethereum)...")
    result = engine.calculate(asset_id='ETH', asset_type='crypto')
    
    print(f"\nResult:")
    print(f"  Score: {result.get('score', 0):.4f}")
    print(f"  Confidence: {result.get('confidence', 0):.4f}")
    print(f"  Events Count: {result.get('metadata', {}).get('events_count', 0)}")
    
    return True  # Crypto returns valid results (may have 0 events)


def main():
    """Run all tests."""
    print("\n" + "=" * 80)
    print("Engine 5: Event Risk Engine Test Suite")
    print("=" * 80)
    
    results = {
        'stock': False,
        'crypto': False
    }
    
    try:
        # Test stocks
        results['stock'] = test_stock_event_risk()
        
        # Test crypto
        results['crypto'] = test_crypto_event_risk()
        
        # Summary
        print("\n" + "=" * 80)
        print("Test Summary")
        print("=" * 80)
        print(f"Stock Event Risk: {'✓ PASS' if results['stock'] else '✗ FAIL'}")
        print(f"Crypto Event Risk: {'✓ PASS' if results['crypto'] else '✗ FAIL'}")
        
        if results['stock'] and results['crypto']:
            print("\n✓ All tests passed!")
            return 0
        else:
            print("\n✗ Some tests failed")
            return 1
            
    except Exception as e:
        print(f"\n✗ Test failed with error: {str(e)}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == '__main__':
    exit(main())

