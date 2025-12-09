"""
Test script for Engine 5: FRED API Integration
Tests economic risk detection from FRED numeric values.
"""
import sys
import os

# Add src to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))

from src.services.engines.event_risk_engine import EventRiskEngine
from src.services.macro.fred_service import FredService
from datetime import datetime, timedelta

def test_fred_service_methods():
    """Test FRED service new methods."""
    print("\n" + "=" * 80)
    print("Testing FRED Service Methods")
    print("=" * 80)
    
    fred_service = FredService()
    
    if not fred_service.is_available():
        print("\n⚠️  FRED service not available (check FRED_API_KEY)")
        return False
    
    # Test 1: Get current Fed rate
    print("\n1. Testing get_latest_value('FEDFUNDS')...")
    current_fed = fred_service.get_latest_value('FEDFUNDS')
    if current_fed:
        print(f"   Current Fed Rate: {current_fed['value']}%")
        print(f"   Date: {current_fed['date']}")
    else:
        print("   ⚠️  Could not fetch Fed rate")
        return False
    
    # Test 2: Detect rate change (simulate previous rate)
    print("\n2. Testing detect_fed_rate_change()...")
    # Simulate previous rate (0.25 lower = rate hike)
    previous_rate = current_fed['value'] - 0.25 if current_fed else 5.0
    previous_date = (datetime.now() - timedelta(days=30)).strftime('%Y-%m-%d')
    
    rate_change = fred_service.detect_fed_rate_change(
        previous_rate=previous_rate,
        previous_date=previous_date
    )
    
    if rate_change:
        print(f"   ✓ Rate change detected!")
        print(f"   Direction: {rate_change['direction']}")
        print(f"   Change: {rate_change['change']:.2f}%")
        print(f"   Magnitude: {rate_change['magnitude']}")
    else:
        print("   ℹ️  No rate change detected (expected if rates haven't changed)")
    
    # Test 3: Get current CPI
    print("\n3. Testing get_latest_value('CPIAUCSL')...")
    current_cpi = fred_service.get_latest_value('CPIAUCSL')
    if current_cpi:
        print(f"   Current CPI: {current_cpi['value']}")
        print(f"   Date: {current_cpi['date']}")
    else:
        print("   ⚠️  Could not fetch CPI")
    
    # Test 4: Detect inflation change (simulate previous CPI)
    print("\n4. Testing detect_inflation_change()...")
    if current_cpi:
        # Simulate previous CPI (0.5% higher = inflation decrease)
        previous_cpi = current_cpi['value'] * 1.005
        previous_date = (datetime.now() - timedelta(days=30)).strftime('%Y-%m-%d')
        
        inflation_change = fred_service.detect_inflation_change(
            previous_cpi=previous_cpi,
            previous_date=previous_date
        )
        
        if inflation_change:
            print(f"   ✓ Inflation change detected!")
            print(f"   Monthly change: {inflation_change['monthly_change']:.2f}%")
            print(f"   Risk level: {inflation_change['risk_level']}")
        else:
            print("   ℹ️  No significant inflation change detected")
    
    # Test 5: Calculate yield curve
    print("\n5. Testing calculate_yield_curve()...")
    yield_curve = fred_service.calculate_yield_curve()
    if yield_curve:
        print(f"   ✓ Yield curve calculated!")
        print(f"   10Y Rate: {yield_curve['10y_rate']:.2f}%")
        print(f"   2Y Rate: {yield_curve['2y_rate']:.2f}%")
        print(f"   Spread: {yield_curve['spread']:.2f}%")
        print(f"   Inverted: {yield_curve['is_inverted']}")
    else:
        print("   ⚠️  Could not calculate yield curve")
    
    # Test 6: Calculate economic risk score
    print("\n6. Testing calculate_economic_risk_score()...")
    # Simulate stored data
    stored_data = {
        'fedfunds': {
            'value': previous_rate if current_fed else 5.0,
            'date': previous_date
        },
        'cpi': {
            'value': previous_cpi if current_cpi else 305.0,
            'date': previous_date
        }
    }
    
    economic_risk = fred_service.calculate_economic_risk_score(stored_data)
    print(f"   Overall Risk Score: {economic_risk.get('overall_risk_score', 0.0):.3f}")
    print(f"   Components: {economic_risk.get('components', {})}")
    print(f"   Events Detected: {len(economic_risk.get('events', []))}")
    
    if economic_risk.get('events'):
        print("\n   Event Details:")
        for i, event in enumerate(economic_risk.get('events', []), 1):
            print(f"   {i}. {event.get('type')}: {event.get('description', '')}")
            print(f"      Impact: {event.get('impact', 0.0):.3f}")
    
    return True


def test_engine5_fred_integration():
    """Test Engine 5 with FRED integration."""
    print("\n" + "=" * 80)
    print("Testing Engine 5 FRED Integration")
    print("=" * 80)
    
    engine = EventRiskEngine()
    
    # Test with AAPL (stock)
    print("\n1. Testing AAPL (Apple) with FRED integration...")
    
    # Simulate stored FRED data
    stored_fred_data = {
        'fedfunds': {
            'value': 5.0,  # Previous rate
            'date': (datetime.now() - timedelta(days=30)).strftime('%Y-%m-%d')
        },
        'cpi': {
            'value': 305.0,  # Previous CPI
            'date': (datetime.now() - timedelta(days=30)).strftime('%Y-%m-%d')
        }
    }
    
    result = engine.calculate(
        asset_id='AAPL',
        asset_type='stock',
        stored_fred_data=stored_fred_data
    )
    
    print(f"\nResult:")
    print(f"  Score: {result.get('score', 0):.4f}")
    print(f"  Confidence: {result.get('confidence', 0):.4f}")
    
    metadata = result.get('metadata', {})
    print(f"\nMetadata:")
    print(f"  Events Count: {metadata.get('events_count', 0)}")
    print(f"  Scored Events: {metadata.get('scored_events', 0)}")
    
    # Check for FRED events
    if 'fred_events_count' in metadata:
        print(f"\n  FRED Economic Risk:")
        print(f"    Risk Score: {metadata.get('fred_economic_risk', 0.0):.3f}")
        print(f"    Events Count: {metadata.get('fred_events_count', 0)}")
        
        fred_events = metadata.get('fred_events', [])
        if fred_events:
            print(f"\n    FRED Events:")
            for i, event in enumerate(fred_events, 1):
                print(f"    {i}. {event.get('type')}: {event.get('description', '')}")
                print(f"       Date: {event.get('date', '')}")
    
    # Test with TSLA
    print("\n\n2. Testing TSLA (Tesla) with FRED integration...")
    result = engine.calculate(
        asset_id='TSLA',
        asset_type='stock',
        stored_fred_data=stored_fred_data
    )
    
    print(f"\nResult:")
    print(f"  Score: {result.get('score', 0):.4f}")
    print(f"  Events Count: {result.get('metadata', {}).get('events_count', 0)}")
    if 'fred_events_count' in result.get('metadata', {}):
        print(f"  FRED Events: {result.get('metadata', {}).get('fred_events_count', 0)}")
    
    return True


def main():
    """Run all tests."""
    print("\n" + "=" * 80)
    print("Engine 5: FRED API Integration Test Suite")
    print("=" * 80)
    
    results = {
        'fred_service': False,
        'engine5_integration': False
    }
    
    try:
        # Test FRED service methods
        results['fred_service'] = test_fred_service_methods()
        
        # Test Engine 5 integration
        results['engine5_integration'] = test_engine5_fred_integration()
        
        # Summary
        print("\n" + "=" * 80)
        print("Test Summary")
        print("=" * 80)
        print(f"FRED Service Methods: {'✓ PASS' if results['fred_service'] else '✗ FAIL'}")
        print(f"Engine 5 Integration: {'✓ PASS' if results['engine5_integration'] else '✗ FAIL'}")
        
        if results['fred_service'] and results['engine5_integration']:
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

