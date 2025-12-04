"""
Test script for FinGPT model with 100 news items.
Processes all news items and saves results to JSON.
"""
import sys
import os
import json
import time
from datetime import datetime

# Add project root to path so we can import from src
project_root = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, project_root)

from src.models.fingpt import get_fingpt_inference
import logging

logging.basicConfig(level=logging.INFO)

def main():
    print("Testing FinGPT Sentiment Analysis with 100 News Items...")
    print("=" * 60)
    
    # Load news data
    news_file = os.path.join(project_root, 'test_news_data.json')
    print(f"\nLoading news data from: {news_file}")
    
    with open(news_file, 'r', encoding='utf-8') as f:
        news_data = json.load(f)
    
    print(f"✓ Loaded {len(news_data)} news items")
    
    # Get inference instance
    print("\nInitializing FinGPT model...")
    print("(This may take a minute on first run - model will load to GPU)")
    inference = get_fingpt_inference()
    print("✓ Model initialized")
    
    # Process all news items
    print(f"\nProcessing {len(news_data)} news items...")
    print("This may take several minutes depending on your GPU...")
    
    start_time = time.time()
    results = []
    
    for i, news_item in enumerate(news_data, 1):
        print(f"Processing item {i}/{len(news_data)}: {news_item['text'][:60]}...", end='\r')
        
        # Analyze sentiment
        sentiment_result = inference.analyze_sentiment(news_item['text'])
        
        # Combine original data with sentiment results
        result_item = {
            "id": news_item["id"],
            "original_text": news_item["text"],
            "source": news_item.get("source", "news"),
            "category": news_item.get("category", "unknown"),
            "sentiment": sentiment_result["sentiment"],
            "confidence": sentiment_result["confidence"],
            "raw_output": sentiment_result.get("raw_output", ""),
            "error": sentiment_result.get("error")
        }
        
        results.append(result_item)
    
    elapsed_time = time.time() - start_time
    
    print(f"\n✓ Processed {len(results)} news items in {elapsed_time:.2f} seconds")
    print(f"  Average time per item: {elapsed_time/len(results):.2f} seconds")
    
    # Calculate statistics
    sentiment_counts = {}
    total_confidence = 0
    valid_results = 0
    
    for result in results:
        sentiment = result.get("sentiment", "unknown")
        sentiment_counts[sentiment] = sentiment_counts.get(sentiment, 0) + 1
        
        if result.get("confidence"):
            total_confidence += result["confidence"]
            valid_results += 1
    
    avg_confidence = total_confidence / valid_results if valid_results > 0 else 0
    
    # Create summary
    summary = {
        "total_items": len(results),
        "processing_time_seconds": round(elapsed_time, 2),
        "average_time_per_item_seconds": round(elapsed_time / len(results), 2),
        "sentiment_distribution": sentiment_counts,
        "average_confidence": round(avg_confidence, 3),
        "timestamp": datetime.now().isoformat()
    }
    
    # Prepare output data
    output_data = {
        "summary": summary,
        "results": results
    }
    
    # Save results to JSON
    output_file = os.path.join(project_root, 'test_results.json')
    print(f"\nSaving results to: {output_file}")
    
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(output_data, f, indent=2, ensure_ascii=False)
    
    print("✓ Results saved successfully!")
    
    # Print summary
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"Total items processed: {summary['total_items']}")
    print(f"Processing time: {summary['processing_time_seconds']:.2f} seconds")
    print(f"Average time per item: {summary['average_time_per_item_seconds']:.2f} seconds")
    print(f"\nSentiment Distribution:")
    for sentiment, count in sentiment_counts.items():
        percentage = (count / len(results)) * 100
        print(f"  {sentiment.capitalize()}: {count} ({percentage:.1f}%)")
    print(f"\nAverage Confidence: {avg_confidence:.3f}")
    print(f"\nResults saved to: {output_file}")
    print("\n✓ Test completed successfully!")

if __name__ == "__main__":
    main()

