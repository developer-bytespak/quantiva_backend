"""
FinBERT Sentiment Analysis Test with Crypto and Stock News
Tests the FinBERT model with real-world crypto and stock news examples.
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


def test_crypto_news():
    """Test sentiment analysis on crypto news."""
    print("\n" + "=" * 80)
    print("CRYPTO NEWS SENTIMENT ANALYSIS")
    print("=" * 80)
    
    crypto_news = [
        {
            "title": "Bitcoin Surges Past $50,000 as Institutional Investors Pour In",
            "text": "Bitcoin reached a new milestone today, breaking through the $50,000 barrier as major institutional investors including Tesla and MicroStrategy continue to accumulate the digital asset. Analysts predict further gains as adoption increases."
        },
        {
            "title": "Ethereum Network Upgrade Successfully Reduces Gas Fees",
            "text": "The latest Ethereum network upgrade has successfully reduced transaction fees by 40%, making DeFi applications more accessible to users. Developers are celebrating the improved scalability."
        },
        {
            "title": "Crypto Market Crash: Bitcoin Drops 20% in Single Day",
            "text": "The cryptocurrency market experienced a severe crash today with Bitcoin plummeting 20% in just 24 hours. Investors are panicking as fears of regulatory crackdowns spread across the market."
        },
        {
            "title": "Dogecoin Price Stabilizes After Elon Musk Tweet",
            "text": "Dogecoin prices stabilized following a tweet from Elon Musk. The meme cryptocurrency has been volatile recently, with prices fluctuating based on social media sentiment."
        },
        {
            "title": "Binance Faces Regulatory Scrutiny in Multiple Countries",
            "text": "Binance, the world's largest cryptocurrency exchange, is facing increased regulatory pressure from authorities in the UK, US, and Japan. Trading volumes have declined as users seek alternative platforms."
        },
        {
            "title": "Solana Network Experiences Major Outage, Transactions Halted",
            "text": "The Solana blockchain network went offline for over 12 hours today, halting all transactions and causing panic among DeFi users. This is the third major outage this year."
        },
        {
            "title": "Cardano Announces Smart Contract Launch, ADA Rises 15%",
            "text": "Cardano successfully launched its smart contract functionality, enabling developers to build decentralized applications. The native token ADA surged 15% on the news."
        },
        {
            "title": "NFT Market Sees Record-Breaking Sales Volume",
            "text": "The NFT market reached new heights this month with over $2 billion in sales. Major brands and celebrities are entering the space, driving mainstream adoption."
        }
    ]
    
    inference = get_finbert_inference()
    
    print(f"\nAnalyzing {len(crypto_news)} crypto news articles...\n")
    print("-" * 80)
    
    results = []
    for i, news in enumerate(crypto_news, 1):
        result = inference.analyze_sentiment(news["text"])
        sentiment = result.get('sentiment', 'unknown')
        score = result.get('score', 0.0)
        confidence = result.get('confidence', 0.0)
        
        # Determine emoji based on sentiment
        emoji = "📈" if sentiment == "positive" else "📉" if sentiment == "negative" else "➡️"
        
        print(f"\n{i}. {emoji} {news['title']}")
        print(f"   Sentiment: {sentiment.upper():8s} | Score: {score:6.3f} | Confidence: {confidence:.3f}")
        print(f"   Preview: {news['text'][:80]}...")
        
        results.append({
            'title': news['title'],
            'sentiment': sentiment,
            'score': score,
            'confidence': confidence
        })
    
    # Summary
    positive_count = sum(1 for r in results if r['sentiment'] == 'positive')
    negative_count = sum(1 for r in results if r['sentiment'] == 'negative')
    neutral_count = sum(1 for r in results if r['sentiment'] == 'neutral')
    avg_score = sum(r['score'] for r in results) / len(results)
    
    print("\n" + "-" * 80)
    print("CRYPTO NEWS SUMMARY:")
    print(f"  Positive: {positive_count} | Negative: {negative_count} | Neutral: {neutral_count}")
    print(f"  Average Sentiment Score: {avg_score:.3f}")
    print("=" * 80)
    
    return results


def test_stock_news():
    """Test sentiment analysis on stock market news."""
    print("\n" + "=" * 80)
    print("STOCK MARKET NEWS SENTIMENT ANALYSIS")
    print("=" * 80)
    
    stock_news = [
        {
            "title": "Apple Reports Record Q4 Earnings, Stock Jumps 8%",
            "text": "Apple Inc. announced record-breaking fourth quarter earnings, exceeding analyst expectations by 15%. The company's iPhone sales surged 30% year-over-year, driving the stock price up 8% in after-hours trading."
        },
        {
            "title": "Tesla Stock Plummets After Production Delays Announced",
            "text": "Tesla shares dropped 12% today after the company announced significant delays in its Cybertruck production timeline. Investors are concerned about the company's ability to meet delivery targets."
        },
        {
            "title": "Amazon Expands Cloud Services, AWS Revenue Grows 40%",
            "text": "Amazon Web Services reported exceptional growth with revenue increasing 40% year-over-year. The company is expanding its cloud infrastructure to meet growing demand from enterprise clients."
        },
        {
            "title": "GameStop Short Squeeze Continues, Stock Volatility Soars",
            "text": "GameStop shares experienced extreme volatility as retail traders continue to battle hedge funds. The stock price swung wildly, creating uncertainty for both bulls and bears."
        },
        {
            "title": "Microsoft Announces Major AI Partnership, Shares Rise",
            "text": "Microsoft announced a groundbreaking partnership with OpenAI, integrating advanced AI capabilities into its products. The stock rose 5% on the news as investors see strong growth potential."
        },
        {
            "title": "Meta Platforms Faces Antitrust Lawsuit, Stock Declines",
            "text": "Meta Platforms is facing a new antitrust lawsuit from multiple states, alleging anti-competitive practices. The stock declined 6% as investors worry about potential regulatory consequences."
        },
        {
            "title": "NVIDIA Stock Surges on AI Chip Demand",
            "text": "NVIDIA shares jumped 10% after reporting strong demand for its AI chips. Data center revenue grew 80% as companies rush to build AI infrastructure."
        },
        {
            "title": "Banking Sector Under Pressure as Interest Rates Rise",
            "text": "Major banks are facing headwinds as the Federal Reserve continues to raise interest rates. Loan defaults are increasing while mortgage applications have declined significantly."
        },
        {
            "title": "SPAC Market Crashes, Hundreds of Deals Canceled",
            "text": "The SPAC market has collapsed with hundreds of deals being canceled. Many blank-check companies are struggling to find merger targets, causing widespread losses for investors."
        },
        {
            "title": "Energy Stocks Rally on Oil Price Surge",
            "text": "Energy sector stocks rallied today as oil prices surged to new highs. Exxon Mobil and Chevron both gained over 5% as supply concerns drive commodity prices upward."
        }
    ]
    
    inference = get_finbert_inference()
    
    print(f"\nAnalyzing {len(stock_news)} stock market news articles...\n")
    print("-" * 80)
    
    results = []
    for i, news in enumerate(stock_news, 1):
        result = inference.analyze_sentiment(news["text"])
        sentiment = result.get('sentiment', 'unknown')
        score = result.get('score', 0.0)
        confidence = result.get('confidence', 0.0)
        
        # Determine emoji based on sentiment
        emoji = "📈" if sentiment == "positive" else "📉" if sentiment == "negative" else "➡️"
        
        print(f"\n{i}. {emoji} {news['title']}")
        print(f"   Sentiment: {sentiment.upper():8s} | Score: {score:6.3f} | Confidence: {confidence:.3f}")
        print(f"   Preview: {news['text'][:80]}...")
        
        results.append({
            'title': news['title'],
            'sentiment': sentiment,
            'score': score,
            'confidence': confidence
        })
    
    # Summary
    positive_count = sum(1 for r in results if r['sentiment'] == 'positive')
    negative_count = sum(1 for r in results if r['sentiment'] == 'negative')
    neutral_count = sum(1 for r in results if r['sentiment'] == 'neutral')
    avg_score = sum(r['score'] for r in results) / len(results)
    
    print("\n" + "-" * 80)
    print("STOCK NEWS SUMMARY:")
    print(f"  Positive: {positive_count} | Negative: {negative_count} | Neutral: {neutral_count}")
    print(f"  Average Sentiment Score: {avg_score:.3f}")
    print("=" * 80)
    
    return results


def test_batch_analysis():
    """Test batch sentiment analysis on mixed news."""
    print("\n" + "=" * 80)
    print("BATCH SENTIMENT ANALYSIS (Mixed Crypto & Stock News)")
    print("=" * 80)
    
    mixed_news = [
        "Bitcoin reaches all-time high as institutional adoption accelerates.",
        "Tesla stock crashes 15% after missing delivery targets.",
        "Ethereum network upgrade successfully reduces transaction costs.",
        "Major bank announces layoffs due to economic downturn.",
        "Cryptocurrency exchange hacked, millions in assets stolen.",
        "Tech giant reports record profits, stock surges 12%.",
        "Regulatory crackdown on crypto causes market panic.",
        "AI company announces breakthrough, shares double overnight."
    ]
    
    inference = get_finbert_inference()
    
    print(f"\nAnalyzing batch of {len(mixed_news)} news headlines...\n")
    
    results = inference.analyze_batch(mixed_news)
    
    print("-" * 80)
    for i, (text, result) in enumerate(zip(mixed_news, results), 1):
        sentiment = result.get('sentiment', 'unknown')
        score = result.get('score', 0.0)
        confidence = result.get('confidence', 0.0)
        emoji = "📈" if sentiment == "positive" else "📉" if sentiment == "negative" else "➡️"
        
        print(f"{i}. {emoji} [{sentiment.upper():8s}] Score: {score:6.3f} | {text}")
    
    # Aggregate results
    aggregated = inference.aggregate_sentiments(results)
    
    print("\n" + "-" * 80)
    print("AGGREGATED BATCH RESULTS:")
    print(f"  Overall Sentiment: {aggregated.get('overall_sentiment', 'unknown').upper()}")
    print(f"  Overall Score: {aggregated.get('score', 0.0):.3f}")
    print(f"  Average Confidence: {aggregated.get('confidence', 0.0):.3f}")
    print(f"  Breakdown: {aggregated.get('breakdown', {})}")
    print("=" * 80)
    
    return results


def main():
    """Main test function."""
    print("\n" + "=" * 80)
    print("FINBERT SENTIMENT ANALYSIS - CRYPTO & STOCK NEWS TEST")
    print("=" * 80)
    
    try:
        # Test crypto news
        crypto_results = test_crypto_news()
        
        # Test stock news
        stock_results = test_stock_news()
        
        # Test batch analysis
        batch_results = test_batch_analysis()
        
        # Final summary
        print("\n" + "=" * 80)
        print("FINAL SUMMARY")
        print("=" * 80)
        print(f"✓ Crypto News Analyzed: {len(crypto_results)}")
        print(f"✓ Stock News Analyzed: {len(stock_results)}")
        print(f"✓ Batch Items Analyzed: {len(batch_results)}")
        print("\n✅ All sentiment analyses completed successfully!")
        print("=" * 80 + "\n")
        
        return 0
        
    except Exception as e:
        print(f"\n✗ Test failed with error: {str(e)}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    exit(main())

