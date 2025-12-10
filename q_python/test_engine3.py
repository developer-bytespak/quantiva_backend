"""
Test script for Engine 3: Fundamental Engine
Tests both crypto and stock fundamental analysis.
"""
import sys
import os

# Add src to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))

from src.services.engines.fundamental_engine import FundamentalEngine
import json

def test_crypto_fundamental():
    """Test crypto fundamental analysis."""
    print("\n" + "=" * 80)
    print("Testing Crypto Fundamental Analysis")
    print("=" * 80)
    
    engine = FundamentalEngine()
    
    # Test with Bitcoin
    print("\n1. Testing BTC (Bitcoin)...")
    result = engine.calculate(asset_id='BTC', asset_type='crypto')
    
    print(f"\nResult:")
    print(f"  Score: {result.get('score', 0):.4f}")
    print(f"  Confidence: {result.get('confidence', 0):.4f}")
    
    metadata = result.get('metadata', {})
    print(f"\nMetadata:")
    print(f"  Galaxy Score: {metadata.get('galaxy_score', 'N/A')}")
    print(f"  Developer Activity: {metadata.get('developer_activity', 'N/A')}")
    print(f"  Alt Rank: {metadata.get('alt_rank', 'N/A')}")
    print(f"  Code Changes (4w): {metadata.get('code_changes_4w', 'N/A')}")
    print(f"  GitHub Forks: {metadata.get('github_forks', 'N/A')}")
    print(f"  GitHub Stars: {metadata.get('github_stars', 'N/A')}")
    print(f"  Sources: {metadata.get('sources', [])}")
    
    score_breakdown = metadata.get('score_breakdown', {})
    if score_breakdown:
        print(f"\nScore Breakdown:")
        print(f"  Galaxy Score (norm): {score_breakdown.get('galaxy_score_norm', 0):.4f}")
        print(f"  Dev Activity (norm): {score_breakdown.get('dev_activity_norm', 0):.4f}")
        print(f"  Alt Rank (norm): {score_breakdown.get('alt_rank_norm', 0):.4f}")
    
    # Test with Ethereum
    print("\n\n2. Testing ETH (Ethereum)...")
    result = engine.calculate(asset_id='ETH', asset_type='crypto')
    
    print(f"\nResult:")
    print(f"  Score: {result.get('score', 0):.4f}")
    print(f"  Confidence: {result.get('confidence', 0):.4f}")
    
    metadata = result.get('metadata', {})
    print(f"  Galaxy Score: {metadata.get('galaxy_score', 'N/A')}")
    print(f"  Developer Activity: {metadata.get('developer_activity', 'N/A')}")
    print(f"  Alt Rank: {metadata.get('alt_rank', 'N/A')}")
    
    return result.get('score', 0) != 0.0


def test_stock_fundamental():
    """Test stock fundamental analysis."""
    print("\n" + "=" * 80)
    print("Testing Stock Fundamental Analysis")
    print("=" * 80)
    
    engine = FundamentalEngine()
    
    # Test with Apple
    print("\n1. Testing AAPL (Apple)...")
    result = engine.calculate(asset_id='AAPL', asset_type='stock')
    
    print(f"\nResult:")
    print(f"  Score: {result.get('score', 0):.4f}")
    print(f"  Confidence: {result.get('confidence', 0):.4f}")
    
    metadata = result.get('metadata', {})
    print(f"\nMetadata:")
    print(f"  Earnings Sentiment: {metadata.get('earnings_sentiment', 'N/A')}")
    print(f"  Revenue Sentiment: {metadata.get('revenue_sentiment', 'N/A')}")
    print(f"  Performance Sentiment: {metadata.get('performance_sentiment', 'N/A')}")
    print(f"  Total News Analyzed: {metadata.get('news_analyzed', 0)}")
    print(f"  Earnings News Count: {metadata.get('earnings_news_count', 0)}")
    print(f"  Revenue News Count: {metadata.get('revenue_news_count', 0)}")
    print(f"  Performance News Count: {metadata.get('performance_news_count', 0)}")
    
    score_breakdown = metadata.get('score_breakdown', {})
    if score_breakdown:
        print(f"\nScore Breakdown:")
        print(f"  Earnings Weighted: {score_breakdown.get('earnings_weighted', 0):.4f}")
        print(f"  Revenue Weighted: {score_breakdown.get('revenue_weighted', 0):.4f}")
        print(f"  Performance Weighted: {score_breakdown.get('performance_weighted', 0):.4f}")
    
    # Test with Tesla
    print("\n\n2. Testing TSLA (Tesla)...")
    result = engine.calculate(asset_id='TSLA', asset_type='stock')
    
    print(f"\nResult:")
    print(f"  Score: {result.get('score', 0):.4f}")
    print(f"  Confidence: {result.get('confidence', 0):.4f}")
    
    metadata = result.get('metadata', {})
    print(f"  Earnings Sentiment: {metadata.get('earnings_sentiment', 'N/A')}")
    print(f"  Revenue Sentiment: {metadata.get('revenue_sentiment', 'N/A')}")
    print(f"  Performance Sentiment: {metadata.get('performance_sentiment', 'N/A')}")
    print(f"  Total News Analyzed: {metadata.get('news_analyzed', 0)}")
    
    return result.get('score', 0) != 0.0 or metadata.get('news_analyzed', 0) > 0


def main():
    """Run all tests."""
    print("\n" + "=" * 80)
    print("Engine 3: Fundamental Engine Test Suite")
    print("=" * 80)
    
    results = {
        'crypto': False,
        'stock': False
    }
    
    try:
        # Test crypto
        results['crypto'] = test_crypto_fundamental()
        
        # Test stocks
        results['stock'] = test_stock_fundamental()
        
        # Summary
        print("\n" + "=" * 80)
        print("Test Summary")
        print("=" * 80)
        print(f"Crypto Fundamental: {'✓ PASS' if results['crypto'] else '✗ FAIL'}")
        print(f"Stock Fundamental: {'✓ PASS' if results['stock'] else '✗ FAIL'}")
        
        if results['crypto'] and results['stock']:
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

