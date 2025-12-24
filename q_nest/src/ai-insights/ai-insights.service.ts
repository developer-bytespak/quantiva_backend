import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenAIProvider } from './providers/openai.provider';
import { GeminiProvider } from './providers/gemini.provider';
import {
  AIProvider,
  AIProviderName,
  CircuitBreakerState,
} from './interfaces/ai-provider.interface';

interface CachedInsight {
  insight: string;
  timestamp: number;
  provider: AIProviderName;
  expiresAt: number;
}

interface InsightResult {
  insight: string;
  provider: AIProviderName;
  fallbackUsed: boolean;
  cached: boolean;
}

interface TrendingAsset {
  asset_id: string;
  symbol: string;
  display_name?: string;
  name?: string;
  price_usd: number;
  price_change_24h: number;
  volume_24h?: number;
  trend_score?: number;
}

interface StrategySignal {
  signal_id: string;
  action: string;
  confidence: number;
  final_score: number;
  entry_price?: number;
  stop_loss?: number;
  take_profit_1?: number;
  sentiment_score?: number;
  trend_score?: number;
}

/**
 * AI Insights Service
 * Manages AI-generated insights with caching, fallback, and retry logic
 */
@Injectable()
export class AiInsightsService {
  private readonly logger = new Logger(AiInsightsService.name);

  // Configuration
  private readonly AI_NEWS_LIMIT: number;
  private readonly TRENDING_ASSETS_LIMIT: number;
  private readonly MAX_CONCURRENT_AI_REQUESTS: number;
  private readonly AI_CACHE_TTL_MS: number;
  private readonly USE_OPENAI_PRIMARY: boolean;
  private readonly ENABLE_AI_FALLBACK: boolean;
  private readonly MAX_RETRIES = 2;
  private readonly RETRY_DELAYS = [1000, 2000]; // Exponential backoff: 1s, 2s

  // In-memory cache
  private cache: Map<string, CachedInsight> = new Map();

  // Circuit breaker state per provider
  private circuitBreakers: Map<AIProviderName, CircuitBreakerState> = new Map();
  private readonly CIRCUIT_BREAKER_THRESHOLD = 10; // Open after 10 failures
  private readonly CIRCUIT_BREAKER_TIMEOUT = 5 * 60 * 1000; // 5 minutes

  // Semaphore for concurrency control
  private activeConcurrentRequests = 0;

  // Metrics
  private metrics = {
    totalRequests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    openaiSuccess: 0,
    openaiFailures: 0,
    geminiSuccess: 0,
    geminiFailures: 0,
    fallbacksUsed: 0,
  };

  constructor(
    private configService: ConfigService,
    private openaiProvider: OpenAIProvider,
    private geminiProvider: GeminiProvider,
  ) {
    // Load configuration
    this.AI_NEWS_LIMIT = parseInt(
      this.configService.get<string>('AI_NEWS_LIMIT') || '2',
      10,
    );
    this.TRENDING_ASSETS_LIMIT = parseInt(
      this.configService.get<string>('TRENDING_ASSETS_LIMIT') || '2',
      10,
    );
    this.MAX_CONCURRENT_AI_REQUESTS = parseInt(
      this.configService.get<string>('MAX_CONCURRENT_AI_REQUESTS') || '3',
      10,
    );
    this.AI_CACHE_TTL_MS = parseInt(
      this.configService.get<string>('AI_CACHE_TTL_MS') || '21600000', // 6 hours
      10,
    );
    this.USE_OPENAI_PRIMARY =
      this.configService.get<string>('USE_OPENAI_PRIMARY') !== 'false';
    this.ENABLE_AI_FALLBACK =
      this.configService.get<string>('ENABLE_AI_FALLBACK') !== 'false';

    this.logger.log(
      `AI Insights Service initialized: assets=${this.TRENDING_ASSETS_LIMIT}, concurrent=${this.MAX_CONCURRENT_AI_REQUESTS}, cache=${this.AI_CACHE_TTL_MS}ms`,
    );
  }

  /**
   * Generate AI insight for a single asset with strategy context
   * Used for on-demand generation when user clicks a card
   */
  async generateAssetInsight(
    asset: TrendingAsset,
    strategyId: string,
    strategyName: string,
    signal?: StrategySignal,
  ): Promise<string> {
    const cacheKey = `asset-${asset.asset_id}-strategy-${strategyId}`;

    try {
      // Check cache first (6 hour TTL)
      const cached = this.getFromCache(cacheKey);
      if (cached) {
        this.logger.debug(
          `Cache hit for asset ${asset.symbol} with strategy ${strategyId}`,
        );
        this.metrics.cacheHits++;
        return cached.insight;
      }

      this.metrics.cacheMisses++;

      // Build prompt with strategy context
      const assetName = asset.display_name || asset.name || asset.symbol;
      const price = Number(asset.price_usd).toFixed(2);
      const change = Number(asset.price_change_24h).toFixed(2);
      const volume = asset.volume_24h ? `$${(Number(asset.volume_24h) / 1e6).toFixed(2)}M` : 'N/A';

      let prompt = `You are a trading advisor. Analyze ${asset.symbol} (${assetName}) for the ${strategyName} strategy.

MARKET DATA:
- Current Price: $${price}
- 24h Change: ${change}%
- 24h Volume: ${volume}
- Trend Score: ${asset.trend_score || 'N/A'}
`;

      // Add signal data if available
      if (signal) {
        const entryPrice = signal.entry_price ? `$${Number(signal.entry_price).toFixed(2)}` : 'N/A';
        const stopLoss = signal.stop_loss ? `$${Number(signal.stop_loss).toFixed(2)}` : 'N/A';
        const takeProfit = signal.take_profit_1 ? `$${Number(signal.take_profit_1).toFixed(2)}` : 'N/A';

        prompt += `
SIGNAL DATA:
- Action: ${signal.action}
- Confidence: ${(Number(signal.confidence) * 100).toFixed(1)}%
- Entry Price: ${entryPrice}
- Stop Loss: ${stopLoss}
- Take Profit: ${takeProfit}
- Sentiment: ${signal.sentiment_score || 'N/A'}
- Trend: ${signal.trend_score || 'N/A'}
`;
      }

      prompt += `\nProvide a concise 2-3 sentence trading insight explaining why this strategy shows ${signal?.action || 'this'} signal, the risk/reward, and a clear recommendation (BUY/SELL/HOLD). Keep it under 100 words.`;

      // Generate insight with fallback
      const result = await this.generateWithFallback(prompt, 150);

      // Cache result
      this.setCache(cacheKey, result.insight, result.provider);

      this.logger.log(
        `Generated insight for ${asset.symbol} with strategy ${strategyId} (provider: ${result.provider})`,
      );

      return result.insight;
    } catch (error: any) {
      this.logger.error(
        `Failed to generate insight for asset ${asset.symbol}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Generate insights for top N trending assets (batch processing)
   */
  async generateTrendingAssetsInsights(
    assets: TrendingAsset[],
    strategyId: string,
    strategyName: string,
    signals: Map<string, StrategySignal>,
    limit: number = 2,
  ): Promise<any[]> {
    if (!assets || assets.length === 0) {
      return [];
    }

    // Only process top N assets
    const limitedAssets = assets.slice(0, limit);

    this.logger.log(
      `Generating insights for ${limitedAssets.length} assets with strategy ${strategyId}`,
    );

    // Generate insights with concurrency control
    const insightsPromises = limitedAssets.map(async (asset) => {
      const signal = signals.get(asset.asset_id);
      try {
        const insight = await this.generateAssetInsight(asset, strategyId, strategyName, signal);
        return {
          ...asset,
          aiInsight: insight,
          hasAiInsight: true,
        };
      } catch (error) {
        return {
          ...asset,
          hasAiInsight: false,
        };
      }
    });

    const results = await this.processConcurrently(insightsPromises);
    return results;
  }

  /**
   * Generate insight with provider fallback and retry logic
   */
  private async generateWithFallback(
    prompt: string,
    maxTokens: number,
  ): Promise<InsightResult> {
    this.metrics.totalRequests++;

    // Determine provider order based on configuration
    const primaryProvider = this.USE_OPENAI_PRIMARY
      ? this.openaiProvider
      : this.geminiProvider;
    const fallbackProvider = this.USE_OPENAI_PRIMARY
      ? this.geminiProvider
      : this.openaiProvider;

    // Try primary provider
    try {
      const result = await this.generateWithRetry(
        primaryProvider,
        prompt,
        maxTokens,
      );
      this.recordSuccess(primaryProvider.name);
      return {
        insight: result.content,
        provider: result.provider,
        fallbackUsed: false,
        cached: false,
      };
    } catch (primaryError: any) {
      this.recordFailure(primaryProvider.name);
      this.logger.warn(
        `Primary provider (${primaryProvider.name}) failed: ${primaryError.message}`,
      );

      // Try fallback if enabled
      if (this.ENABLE_AI_FALLBACK && fallbackProvider.isAvailable()) {
        this.logger.log(
          `Attempting fallback to ${fallbackProvider.name}...`,
        );
        this.metrics.fallbacksUsed++;

        try {
          const result = await this.generateWithRetry(
            fallbackProvider,
            prompt,
            maxTokens,
          );
          this.recordSuccess(fallbackProvider.name);
          this.logger.warn(
            `${primaryProvider.name} failed, successfully used ${fallbackProvider.name} fallback`,
          );
          return {
            insight: result.content,
            provider: result.provider,
            fallbackUsed: true,
            cached: false,
          };
        } catch (fallbackError: any) {
          this.recordFailure(fallbackProvider.name);
          this.logger.error(
            `Fallback provider (${fallbackProvider.name}) also failed: ${fallbackError.message}`,
          );
          throw new Error(
            `All AI providers failed: Primary (${primaryProvider.name}), Fallback (${fallbackProvider.name})`,
          );
        }
      } else {
        throw new Error(
          `Primary provider (${primaryProvider.name}) failed and fallback is disabled or unavailable`,
        );
      }
    }
  }

  /**
   * Generate with retry logic (exponential backoff)
   */
  private async generateWithRetry(
    provider: AIProvider,
    prompt: string,
    maxTokens: number,
  ): Promise<any> {
    // Check circuit breaker
    if (this.isCircuitBreakerOpen(provider.name)) {
      throw new Error(
        `Circuit breaker is open for ${provider.name} (too many recent failures)`,
      );
    }

    if (!provider.isAvailable()) {
      throw new Error(`Provider ${provider.name} is not available`);
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        const result = await provider.generate({
          prompt,
          maxTokens,
          temperature: 0.7,
        });

        // Reset circuit breaker on success
        this.resetCircuitBreaker(provider.name);

        return result;
      } catch (error: any) {
        lastError = error;
        this.logger.warn(
          `${provider.name} attempt ${attempt + 1}/${this.MAX_RETRIES + 1} failed: ${error.message}`,
        );

        // Don't retry if it's the last attempt
        if (attempt < this.MAX_RETRIES) {
          const delay = this.RETRY_DELAYS[attempt] || 2000;
          await this.sleep(delay);
        }
      }
    }

    throw lastError || new Error(`${provider.name} generation failed`);
  }

  /**
   * Process promises with concurrency control
   */
  private async processConcurrently<T>(
    promises: Promise<T>[],
  ): Promise<T[]> {
    const results: T[] = [];
    const executing: Promise<void>[] = [];

    for (const promise of promises) {
      const p = promise.then((result) => {
        results.push(result);
        executing.splice(executing.indexOf(p), 1);
        this.activeConcurrentRequests--;
      });

      executing.push(p);
      this.activeConcurrentRequests++;

      // Wait if we've reached the concurrency limit
      if (executing.length >= this.MAX_CONCURRENT_AI_REQUESTS) {
        await Promise.race(executing);
      }
    }

    await Promise.all(executing);
    return results;
  }

  // Cache management
  private getFromCache(key: string): CachedInsight | null {
    const cached = this.cache.get(key);
    if (cached && Date.now() < cached.expiresAt) {
      return cached;
    }
    if (cached) {
      this.cache.delete(key); // Remove expired entry
    }
    return null;
  }

  private setCache(
    key: string,
    insight: string,
    provider: AIProviderName,
  ): void {
    const now = Date.now();
    this.cache.set(key, {
      insight,
      timestamp: now,
      provider,
      expiresAt: now + this.AI_CACHE_TTL_MS,
    });
  }

  // Circuit breaker management
  private isCircuitBreakerOpen(provider: AIProviderName): boolean {
    const state = this.circuitBreakers.get(provider);
    if (!state || !state.isOpen) {
      return false;
    }

    // Check if it's time to retry
    if (Date.now() >= state.nextRetryTime) {
      this.logger.log(`Circuit breaker closed for ${provider} (timeout reached)`);
      this.resetCircuitBreaker(provider);
      return false;
    }

    return true;
  }

  private recordFailure(provider: AIProviderName): void {
    let state = this.circuitBreakers.get(provider);
    if (!state) {
      state = {
        isOpen: false,
        failureCount: 0,
        lastFailureTime: 0,
        nextRetryTime: 0,
      };
    }

    state.failureCount++;
    state.lastFailureTime = Date.now();

    if (state.failureCount >= this.CIRCUIT_BREAKER_THRESHOLD) {
      state.isOpen = true;
      state.nextRetryTime = Date.now() + this.CIRCUIT_BREAKER_TIMEOUT;
      this.logger.warn(
        `Circuit breaker opened for ${provider} (${state.failureCount} consecutive failures)`,
      );
    }

    this.circuitBreakers.set(provider, state);
  }

  private recordSuccess(provider: AIProviderName): void {
    if (provider === 'openai') {
      this.metrics.openaiSuccess++;
    } else {
      this.metrics.geminiSuccess++;
    }
  }

  private resetCircuitBreaker(provider: AIProviderName): void {
    this.circuitBreakers.delete(provider);
  }

  // Utility methods
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get metrics for monitoring
   */
  getMetrics() {
    const cacheSize = this.cache.size;
    const cacheHitRate =
      this.metrics.totalRequests > 0
        ? (this.metrics.cacheHits / this.metrics.totalRequests) * 100
        : 0;

    return {
      ...this.metrics,
      cacheSize,
      cacheHitRate: cacheHitRate.toFixed(2) + '%',
      activeConcurrentRequests: this.activeConcurrentRequests,
      circuitBreakers: Array.from(this.circuitBreakers.entries()).map(
        ([provider, state]) => ({
          provider,
          ...state,
        }),
      ),
    };
  }

  /**
   * Clear cache (useful for testing)
   */
  clearCache(): void {
    this.cache.clear();
    this.logger.log('Cache cleared');
  }
}
