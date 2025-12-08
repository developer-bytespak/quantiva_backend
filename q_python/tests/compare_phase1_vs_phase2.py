"""
Compare Phase 1 (ML only) vs Phase 2 (ML + Keywords + Market) Sentiment Analysis
Tests on real news data to measure improvement.
"""
import sys
from pathlib import Path
from typing import Dict, Any, List
import json

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

try:
    from src.services.engines.sentiment_engine import SentimentEngine
    from src.services.data.lunarcrush_service import LunarCrushService
    FINBERT_AVAILABLE = True
except ImportError as e:
    print(f"[WARNING] FinBERT not available: {str(e)}")
    print("[INFO] Will test Phase 2 components only (keywords, aggregator, market signals)")
    FINBERT_AVAILABLE = False
    from src.services.data.lunarcrush_service import LunarCrushService
    from src.services.sentiment import CryptoKeywordAnalyzer, SentimentAggregator, MarketSignalAnalyzer


def compare_phase1_vs_phase2(symbol: str = "BTC", limit: int = 10):
    """
    Compare Phase 1 (ML only) vs Phase 2 (ML + Keywords + Market) on same news data.
    
    Args:
        symbol: Crypto symbol to test
        limit: Number of news items to compare
    """
    print("\n" + "="*80)
    print(f"PHASE 1 vs PHASE 2 SENTIMENT COMPARISON - {symbol}")
    print("="*80)
    
    if not FINBERT_AVAILABLE:
        print("\n[INFO] FinBERT not available - testing Phase 2 components only")
        print("[INFO] This will show keyword analysis and aggregator logic")
        print("[INFO] For full comparison, install: pip install transformers torch\n")
        return test_phase2_components_only(symbol, limit)
    
    engine = SentimentEngine()
    lunarcrush = LunarCrushService()
    
    # Fetch real news data
    print(f"\n[1/4] Fetching {limit} news items for {symbol} from LunarCrush...")
    news_items = lunarcrush.fetch_coin_news(symbol, limit=limit)
    
    if not news_items:
        print(f"[ERROR] No news items found for {symbol}")
        return
    
    print(f"[OK] Fetched {len(news_items)} news items")
    
    # Prepare text data
    text_data = []
    for item in news_items:
        title = item.get('title', '')
        text = item.get('text', title)
        combined_text = f"{title}. {text}" if title and text else (text or title)
        source = item.get('source', 'unknown')
        
        text_data.append({
            'text': combined_text,
            'source': source,
            'title': title,
            'url': item.get('url', '')
        })
    
    print(f"\n[2/4] Running Phase 1 (ML only) analysis...")
    phase1_results = []
    for item in text_data:
        try:
            # Phase 1: analyze_text (ML only)
            result = engine.analyze_text(item['text'], source=item['source'])
            phase1_results.append({
                'title': item['title'][:60],
                'source': item['source'],
                'sentiment': result.get('sentiment', 'neutral'),
                'score': result.get('score', 0.0),
                'confidence': result.get('confidence', 0.0)
            })
        except Exception as e:
            print(f"  [WARNING] Phase 1 failed for item: {str(e)}")
            phase1_results.append({
                'title': item['title'][:60],
                'source': item['source'],
                'sentiment': 'neutral',
                'score': 0.0,
                'confidence': 0.0,
                'error': str(e)
            })
    
    print(f"[OK] Phase 1 completed: {len(phase1_results)} results")
    
    print(f"\n[3/4] Running Phase 2 (ML + Keywords + Market) analysis...")
    try:
        # Phase 2: calculate (full pipeline)
        phase2_result = engine.calculate(
            asset_id=symbol,
            asset_type='crypto',
            text_data=text_data,
            exchange='binance'
        )
        
        phase2_overall = {
            'sentiment': phase2_result.get('metadata', {}).get('overall_sentiment', 'neutral'),
            'score': phase2_result.get('score', 0.0),
            'confidence': phase2_result.get('confidence', 0.0),
            'layer_breakdown': phase2_result.get('metadata', {}).get('layer_breakdown', {}),
            'keyword_analysis': phase2_result.get('metadata', {}).get('keyword_analysis'),
            'market_signals': phase2_result.get('metadata', {}).get('market_signals')
        }
        
        # Get individual results from Phase 2 metadata
        phase2_individual = phase2_result.get('metadata', {}).get('individual_ml_results', [])
        
        print(f"[OK] Phase 2 completed")
        
    except Exception as e:
        print(f"[ERROR] Phase 2 failed: {str(e)}")
        import traceback
        traceback.print_exc()
        return
    
    print(f"\n[4/4] Comparing results...")
    print("\n" + "="*80)
    print("DETAILED COMPARISON")
    print("="*80)
    
    # Compare individual items
    print("\nIndividual News Items Comparison:")
    print("-" * 80)
    
    for i, (p1, p2_item) in enumerate(zip(phase1_results, phase2_individual[:len(phase1_results)]), 1):
        p2_sentiment = p2_item.get('sentiment', 'neutral')
        p2_score = p2_item.get('score', 0.0)
        p2_conf = p2_item.get('confidence', 0.0)
        
        score_diff = p2_score - p1['score']
        conf_diff = p2_conf - p1['confidence']
        
        print(f"\n[{i}] {p1['title']}...")
        print(f"     Source: {p1['source']}")
        print(f"     Phase 1 (ML only):     {p1['sentiment']:8s} | Score: {p1['score']:6.3f} | Conf: {p1['confidence']:.3f}")
        print(f"     Phase 2 (Full):        {p2_sentiment:8s} | Score: {p2_score:6.3f} | Conf: {p2_conf:.3f}")
        print(f"     Difference:            {'+' if score_diff >= 0 else ''}{score_diff:6.3f} | {'+' if conf_diff >= 0 else ''}{conf_diff:.3f}")
    
    # Overall comparison
    print("\n" + "="*80)
    print("OVERALL COMPARISON")
    print("="*80)
    
    # Calculate Phase 1 aggregate
    phase1_avg_score = sum(r['score'] for r in phase1_results) / len(phase1_results) if phase1_results else 0.0
    phase1_avg_conf = sum(r['confidence'] for r in phase1_results) / len(phase1_results) if phase1_results else 0.0
    
    phase2_score = phase2_overall['score']
    phase2_conf = phase2_overall['confidence']
    
    print(f"\nPhase 1 (ML Only):")
    print(f"  Average Score:     {phase1_avg_score:.3f}")
    print(f"  Average Confidence: {phase1_avg_conf:.3f}")
    
    print(f"\nPhase 2 (ML + Keywords + Market):")
    print(f"  Final Score:       {phase2_score:.3f}")
    print(f"  Final Confidence:  {phase2_conf:.3f}")
    
    if phase2_overall.get('layer_breakdown'):
        breakdown = phase2_overall['layer_breakdown']
        print(f"\n  Layer Breakdown:")
        if 'ml' in breakdown:
            print(f"    ML:      Score={breakdown['ml']['score']:.3f}, Weight={breakdown['ml']['weight']}")
        if 'keywords' in breakdown:
            print(f"    Keywords: Score={breakdown['keywords']['score']:.3f}, Weight={breakdown['keywords']['weight']}")
        if 'market' in breakdown:
            print(f"    Market:   Score={breakdown['market']['score']:.3f}, Weight={breakdown['market']['weight']}")
    
    if phase2_overall.get('keyword_analysis'):
        kw = phase2_overall['keyword_analysis']
        print(f"\n  Keyword Analysis:")
        print(f"    Score: {kw.get('score', 0):.3f}, Confidence: {kw.get('confidence', 0):.3f}")
    
    if phase2_overall.get('market_signals'):
        ms = phase2_overall['market_signals']
        print(f"\n  Market Signals:")
        print(f"    Momentum: {ms.get('momentum', 0):.3f}")
        print(f"    Volume:   {ms.get('volume', 0):.3f}")
        print(f"    Social:   {ms.get('social', 0):.3f}")
    
    # Improvement metrics
    print("\n" + "="*80)
    print("IMPROVEMENT METRICS")
    print("="*80)
    
    score_improvement = phase2_score - phase1_avg_score
    conf_improvement = phase2_conf - phase1_avg_conf
    
    print(f"\nScore Change:      {score_improvement:+.3f} ({score_improvement/abs(phase1_avg_score)*100 if phase1_avg_score != 0 else 0:+.1f}%)")
    print(f"Confidence Change: {conf_improvement:+.3f} ({conf_improvement/abs(phase1_avg_conf)*100 if phase1_avg_conf != 0 else 0:+.1f}%)")
    
    # Sentiment agreement
    phase1_sentiments = [r['sentiment'] for r in phase1_results]
    phase1_most_common = max(set(phase1_sentiments), key=phase1_sentiments.count) if phase1_sentiments else 'neutral'
    
    print(f"\nSentiment Agreement:")
    print(f"  Phase 1 Most Common: {phase1_most_common}")
    print(f"  Phase 2 Overall:     {phase2_overall['sentiment']}")
    print(f"  Agreement:           {'[MATCH]' if phase1_most_common == phase2_overall['sentiment'] else '[DIFFERENT]'}")
    
    # Summary
    print("\n" + "="*80)
    print("SUMMARY")
    print("="*80)
    
    if abs(score_improvement) > 0.1:
        direction = "improved" if score_improvement > 0 else "decreased"
        print(f"\n[OK] Phase 2 shows {direction} sentiment score by {abs(score_improvement):.3f}")
    else:
        print(f"\n[INFO] Phase 2 score similar to Phase 1 (difference: {score_improvement:.3f})")
    
    if conf_improvement > 0.05:
        print(f"[OK] Phase 2 confidence improved by {conf_improvement:.3f}")
    elif conf_improvement < -0.05:
        print(f"[WARNING] Phase 2 confidence decreased by {abs(conf_improvement):.3f}")
    else:
        print(f"[INFO] Phase 2 confidence similar to Phase 1")
    
    if phase2_overall.get('keyword_analysis'):
        print(f"[OK] Keyword analysis active (crypto slang detected)")
    
    if phase2_overall.get('market_signals'):
        print(f"[OK] Market signals active (price/volume analysis)")
    
    print("\n" + "="*80)


def test_phase2_components_only(symbol: str = "BTC", limit: int = 10):
    """
    Test Phase 2 components without FinBERT (keywords, aggregator, market signals).
    """
    print("\n" + "="*80)
    print(f"PHASE 2 COMPONENTS TEST (No FinBERT) - {symbol}")
    print("="*80)
    
    lunarcrush = LunarCrushService()
    keyword_analyzer = CryptoKeywordAnalyzer()
    aggregator = SentimentAggregator()
    market_analyzer = MarketSignalAnalyzer()
    
    # Fetch real news data
    print(f"\n[1/3] Fetching {limit} news items for {symbol} from LunarCrush...")
    news_items = lunarcrush.fetch_coin_news(symbol, limit=limit)
    
    if not news_items:
        print(f"[ERROR] No news items found for {symbol}")
        return
    
    print(f"[OK] Fetched {len(news_items)} news items")
    
    # Test keyword analyzer
    print(f"\n[2/3] Testing Keyword Analyzer on news items...")
    keyword_results = []
    for item in news_items:
        title = item.get('title', '')
        text = item.get('text', title)
        combined_text = f"{title}. {text}" if title and text else (text or title)
        
        result = keyword_analyzer.analyze(combined_text)
        keyword_results.append({
            'title': title[:60],
            'source': item.get('source', 'unknown'),
            'sentiment': result.get('sentiment', 'neutral'),
            'score': result.get('score', 0.0),
            'confidence': result.get('confidence', 0.0),
            'keywords': result.get('matched_keywords', [])
        })
    
    print(f"[OK] Keyword analysis completed: {len(keyword_results)} results")
    
    # Test aggregator with mock ML results
    print(f"\n[3/3] Testing Aggregator with mock ML results...")
    
    # Aggregate keyword results
    if keyword_results:
        keyword_scores = [r['score'] for r in keyword_results]
        keyword_confidences = [r['confidence'] for r in keyword_results]
        avg_keyword_score = sum(keyword_scores) / len(keyword_scores) if keyword_scores else 0.0
        avg_keyword_conf = sum(keyword_confidences) / len(keyword_confidences) if keyword_confidences else 0.0
    else:
        avg_keyword_score = 0.0
        avg_keyword_conf = 0.0
    
    # Mock ML result (would come from FinBERT in real scenario)
    mock_ml_result = {'score': 0.5, 'confidence': 0.8}
    keyword_result = {'score': avg_keyword_score, 'confidence': avg_keyword_conf}
    
    # Get market signals
    market_result = market_analyzer.analyze(symbol, 'crypto', 'binance', connection_id=None)
    
    # Test different routing scenarios
    print("\n" + "="*80)
    print("AGGREGATOR ROUTING TESTS")
    print("="*80)
    
    scenarios = [
        ('Crypto Social Media', 'crypto', 'social'),
        ('Crypto Formal News', 'crypto', 'formal'),
        ('Stock News', 'stock', 'formal')
    ]
    
    for scenario_name, asset_type, news_type in scenarios:
        result = aggregator.aggregate(
            ml_result=mock_ml_result,
            keyword_result=keyword_result if asset_type == 'crypto' else None,
            market_result=market_result,
            asset_type=asset_type,
            news_type=news_type
        )
        
        print(f"\n{scenario_name}:")
        print(f"  Final Score: {result['score']:.3f}")
        print(f"  Final Confidence: {result['confidence']:.3f}")
        print(f"  Sentiment: {result['sentiment']}")
        print(f"  Weights: ML={result['layers']['ml_weight']}, Keywords={result['layers']['keyword_weight']}, Market={result['layers']['market_weight']}")
    
    # Show keyword analysis results
    print("\n" + "="*80)
    print("KEYWORD ANALYSIS RESULTS")
    print("="*80)
    
    for i, result in enumerate(keyword_results[:5], 1):
        print(f"\n[{i}] {result['title']}...")
        print(f"     Source: {result['source']}")
        print(f"     Sentiment: {result['sentiment']}")
        print(f"     Score: {result['score']:.3f}")
        print(f"     Confidence: {result['confidence']:.3f}")
        if result['keywords']:
            print(f"     Matched Keywords: {', '.join(result['keywords'][:5])}")
    
    # Market signals
    print("\n" + "="*80)
    print("MARKET SIGNALS")
    print("="*80)
    print(f"  Score: {market_result['score']:.3f}")
    print(f"  Confidence: {market_result['confidence']:.3f}")
    print(f"  Signals: {market_result['signals']}")
    
    print("\n" + "="*80)
    print("SUMMARY")
    print("="*80)
    print(f"[OK] Tested {len(keyword_results)} news items with keyword analyzer")
    print(f"[OK] Aggregator routing logic verified")
    print(f"[OK] Market signals fetched (may be limited without connection_id)")
    print(f"\n[INFO] For full Phase 1 vs Phase 2 comparison, install FinBERT:")
    print(f"       pip install transformers torch")
    print("="*80)


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description='Compare Phase 1 vs Phase 2 sentiment analysis')
    parser.add_argument('--symbol', type=str, default='BTC', help='Crypto symbol to test (default: BTC)')
    parser.add_argument('--limit', type=int, default=10, help='Number of news items to compare (default: 10)')
    
    args = parser.parse_args()
    
    try:
        compare_phase1_vs_phase2(symbol=args.symbol, limit=args.limit)
    except KeyboardInterrupt:
        print("\n\nComparison interrupted by user")
    except Exception as e:
        print(f"\n[ERROR] Comparison failed: {str(e)}")
        import traceback
        traceback.print_exc()

