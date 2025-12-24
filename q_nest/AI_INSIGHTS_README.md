# AI Insights & Data Cleanup System

Optimized AI-powered insights with automated data cleanup for crypto trading application.

## 🎯 Features

### AI Insights Service
- **Dual Provider System**: OpenAI (primary) + Gemini (fallback)
- **Intelligent Caching**: 1-hour TTL to reduce API costs
- **Retry Logic**: Exponential backoff (3 attempts per provider)
- **Circuit Breaker**: Auto-disable failing providers for 5 minutes
- **Concurrency Control**: Max 3 concurrent API requests
- **Cost-Optimized**: Only top 3 news + top 4 assets get AI insights
- **Graceful Degradation**: Returns items without insights if all providers fail

### Data Cleanup Service
- **Automated Cleanup**: Runs daily at 2 AM UTC
- **Configurable Retention**: Default 5 days
- **Batch Processing**: 100 records per batch to avoid memory issues
- **Error Resilient**: One failure doesn't stop entire cleanup
- **Manual Trigger**: Admin endpoint for testing
- **Detailed Metrics**: Track deletions, errors, and duration

## 📦 Installation

```bash
# Install dependencies
npm install openai @google/generative-ai

# Add environment variables to .env
cp .env.ai-insights.example .env
```

## ⚙️ Configuration

Add these to your `.env` file:

```env
# OpenAI API (Primary Provider)
OPENAI_API_KEY=sk-proj-...

# Gemini API (Fallback Provider)  
GEMINI_API_KEY=AIza...

# AI Generation Limits
AI_NEWS_LIMIT=3
TRENDING_ASSETS_LIMIT=4
MAX_CONCURRENT_AI_REQUESTS=3
AI_CACHE_TTL_MS=3600000

# Provider Configuration
USE_OPENAI_PRIMARY=true
ENABLE_AI_FALLBACK=true

# Data Cleanup
DATA_RETENTION_DAYS=5
CLEANUP_BATCH_SIZE=100
```

## 🚀 Usage

### AI Insights Service

```typescript
import { AiInsightsService } from './ai-insights/ai-insights.service';

// Inject service
constructor(private aiInsights: AiInsightsService) {}

// Generate insights for news
const newsWithInsights = await this.aiInsights.generateNewsInsights(newsItems);

// Generate insights for trending assets
const assetsWithInsights = await this.aiInsights.generateTrendingAssetsInsights(assets);

// Get metrics
const metrics = this.aiInsights.getMetrics();

// Clear cache (for testing)
this.aiInsights.clearCache();
```

### Response Format

```typescript
// News with AI insights
{
  heading: "Bitcoin reaches new high",
  news_detail: {...},
  aiInsight: "This represents a significant...", // Only for top 3
  hasAiInsight: true,
  aiProvider: "openai", // or "gemini"
  aiGeneratedAt: "2025-12-24T12:00:00Z"
}

// Trending asset with AI insights
{
  symbol: "BTC",
  name: "Bitcoin",
  price_usd: 50000,
  price_change_24h: 5.2,
  aiInsight: "Strong bullish momentum...", // Only for top 4
  hasAiInsight: true,
  aiProvider: "openai",
  aiGeneratedAt: "2025-12-24T12:00:00Z"
}
```

### Data Cleanup Service

```typescript
// Automatic cleanup runs daily at 2 AM UTC

// Manual trigger via API
GET /admin/cleanup/trigger

// Check status
GET /admin/cleanup/status
```

## 📊 Monitoring

### AI Insights Metrics

```typescript
{
  totalRequests: 100,
  cacheHits: 60,
  cacheMisses: 40,
  cacheHitRate: "60.00%",
  openaiSuccess: 35,
  openaiFailures: 5,
  geminiSuccess: 5,
  geminiFailures: 0,
  fallbacksUsed: 5,
  cacheSize: 25,
  activeConcurrentRequests: 0,
  circuitBreakers: [
    {
      provider: "openai",
      isOpen: false,
      failureCount: 0
    }
  ]
}
```

### Cleanup Metrics

```typescript
{
  startTime: "2025-12-24T02:00:00Z",
  endTime: "2025-12-24T02:05:30Z",
  durationMs: 330000,
  newsDeleted: 1250,
  trendingAssetsDeleted: 980,
  errors: []
}
```

## 🔄 Fallback Strategy

```
1. Try OpenAI (3 attempts with exponential backoff)
   ├─ Attempt 1 → fail → wait 1s
   ├─ Attempt 2 → fail → wait 2s
   └─ Attempt 3 → fail
   
2. Fallback to Gemini (3 attempts)
   ├─ Attempt 1 → fail → wait 1s
   ├─ Attempt 2 → fail → wait 2s
   └─ Attempt 3 → fail
   
3. Return item without insight (hasAiInsight: false)
```

## 🛡️ Circuit Breaker

- Opens after 10 consecutive failures
- Stays open for 5 minutes
- Logs when opening/closing
- Prevents wasting time on down providers

## 💰 Cost Optimization

### Current Setup
- **OpenAI gpt-4o-mini**: ~$0.15/1M input tokens, ~$0.60/1M output tokens
- **Gemini**: Free tier (fallback only)
- **Limits**: Top 3 news + top 4 assets = max 7 insights per cycle
- **Caching**: 60-70% reduction in API calls
- **Estimated Cost**: $3-7/month

### Cost Breakdown
```
Daily API calls: ~7 insights
Monthly API calls: ~210
With caching (70% hit rate): ~63 actual API calls
Average tokens per call: ~200 input + 150 output

Monthly cost:
- Input: 63 * 200 * $0.15 / 1M = $0.002
- Output: 63 * 150 * $0.60 / 1M = $0.006
Total: ~$0.01/month (with spikes to $5-7 during cache misses)
```

## 📝 Logging Examples

```typescript
// Success with primary
[AiInsightsService] Generated insight for news abc-123 using OpenAI in 1200ms

// Cache hit
[AiInsightsService] Cache hit for asset BTC (provider: openai)

// Fallback triggered
[AiInsightsService] OpenAI failed for news xyz-456, successfully used Gemini fallback

// Complete failure
[AiInsightsService] All AI providers failed for asset ETH: Rate limit exceeded

// Circuit breaker
[AiInsightsService] Circuit breaker opened for openai (10 consecutive failures)
[AiInsightsService] Circuit breaker closed for openai (timeout reached)

// Cleanup
[TaskSchedulerService] Starting scheduled cleanup...
[TaskSchedulerService] Deleted 1250 trending_news records in 8 batches
[TaskSchedulerService] Cleanup completed: 1250 news, 980 assets deleted in 330000ms
```

## 🧪 Testing

### Test AI Insights

```typescript
// Test with mock data
const mockNews = [
  { heading: 'Test news', news_detail: {...} }
];

const result = await aiInsights.generateNewsInsights(mockNews);
console.log(result[0].aiInsight); // Should have AI insight
console.log(result[0].aiProvider); // 'openai' or 'gemini'
```

### Test Cleanup

```bash
# Manual trigger
curl http://localhost:3000/admin/cleanup/trigger

# Check status
curl http://localhost:3000/admin/cleanup/status
```

### Simulate Failures

```env
# Force Gemini as primary to test OpenAI fallback
USE_OPENAI_PRIMARY=false

# Disable fallback to test error handling
ENABLE_AI_FALLBACK=false

# Use invalid API key to test failure path
OPENAI_API_KEY=invalid_key
```

## 📁 File Structure

```
src/
├── ai-insights/
│   ├── ai-insights.module.ts
│   ├── ai-insights.service.ts
│   ├── interfaces/
│   │   └── ai-provider.interface.ts
│   └── providers/
│       ├── openai.provider.ts
│       └── gemini.provider.ts
├── task-scheduler/
│   ├── task-scheduler.module.ts
│   ├── task-scheduler.service.ts
│   └── task-scheduler.controller.ts
└── app.module.ts (updated)
```

## 🔍 Troubleshooting

### OpenAI Fails Immediately
- Check `OPENAI_API_KEY` is valid
- Verify API key has credits
- Check rate limits

### Gemini Fallback Not Working
- Check `GEMINI_API_KEY` is set
- Verify `ENABLE_AI_FALLBACK=true`
- Check Gemini free tier limits

### High Cache Miss Rate
- Increase `AI_CACHE_TTL_MS` (default 1 hour)
- Check if cache is being cleared unexpectedly
- Verify cache key generation

### Cleanup Not Running
- Check cron is enabled: `ScheduleModule.forRoot()`
- Verify timezone settings
- Check logs for errors

### Circuit Breaker Stuck Open
- Wait 5 minutes for auto-reset
- Fix underlying provider issue
- Restart service to reset state

## 🚨 Alerts & Monitoring

Monitor these metrics in production:

1. **High Fallback Rate** (>20%): Primary provider issues
2. **Low Cache Hit Rate** (<50%): Increase TTL or check cache
3. **Circuit Breaker Opens**: Provider down or rate limited
4. **Cleanup Errors**: Database connectivity or permissions
5. **High Concurrent Requests**: May need to increase limit

## 📚 API Reference

### AI Insights Service

#### `generateNewsInsights(newsItems)`
Generates AI insights for top N news items.
- **Input**: Array of news items
- **Output**: Array with AI insights added to top N items
- **Throws**: Never (degrades gracefully)

#### `generateTrendingAssetsInsights(assets)`
Generates AI insights for top N trending assets.
- **Input**: Array of asset objects
- **Output**: Array with AI insights added to top N assets
- **Throws**: Never (degrades gracefully)

#### `getMetrics()`
Returns current metrics for monitoring.
- **Output**: Metrics object with cache stats, provider stats, etc.

#### `clearCache()`
Clears the in-memory cache (for testing).
- **Output**: void

### Task Scheduler Service

#### `triggerManualCleanup()`
Manually triggers cleanup process.
- **Output**: Promise<CleanupMetrics>
- **Throws**: Error if cleanup already running

#### `getStatus()`
Returns current cleanup status and configuration.
- **Output**: Status object

## 🤝 Contributing

When modifying the AI system:

1. Update prompts in `ai-insights.service.ts`
2. Adjust limits in environment variables
3. Test fallback behavior
4. Monitor costs after changes
5. Update this documentation

## 📄 License

Part of QuantivaHQ trading platform.

## ✅ Checklist

- [x] OpenAI integration
- [x] Gemini fallback
- [x] In-memory caching
- [x] Retry logic
- [x] Circuit breaker
- [x] Concurrency control
- [x] Automated cleanup
- [x] Batch processing
- [x] Manual trigger endpoint
- [x] Comprehensive logging
- [x] Metrics tracking
- [x] Error handling
- [x] Documentation
