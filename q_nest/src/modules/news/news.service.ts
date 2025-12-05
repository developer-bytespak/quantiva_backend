import { Injectable, Logger } from '@nestjs/common';
import { PythonApiService } from '../../kyc/integrations/python-api.service';

export interface CryptoNewsItem {
  title: string;
  description: string;
  url: string;
  source: string;
  published_at: string | null;
  sentiment: {
    label: string;
    score: number;
    confidence: number;
  };
}

export interface SocialMetrics {
  galaxy_score: number;
  alt_rank: number;
  social_volume: number;
  price: number;
  volume_24h: number;
  market_cap: number;
}

export interface CryptoNewsResponse {
  symbol: string;
  news_items: CryptoNewsItem[];
  social_metrics: SocialMetrics;
  timestamp: string;
}

@Injectable()
export class NewsService {
  private readonly logger = new Logger(NewsService.name);
  
  // Simple in-memory cache (5 minutes TTL)
  private cache: Map<string, { data: CryptoNewsResponse; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes in milliseconds

  constructor(private pythonApi: PythonApiService) {}

  async getCryptoNews(symbol: string, limit: number = 2): Promise<CryptoNewsResponse> {
    const cacheKey = `${symbol}_${limit}`;
    
    // Check cache first
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      this.logger.debug(`Returning cached news for ${symbol}`);
      return cached.data;
    }

    try {
      // Call Python API endpoint
      const response = await this.pythonApi.post<CryptoNewsResponse>(
        '/api/v1/news/crypto',
        {
          symbol: symbol.toUpperCase(),
          limit: limit,
        },
      );

      const data = response.data;

      // Cache the response
      this.cache.set(cacheKey, {
        data,
        timestamp: Date.now(),
      });

      // Clean up old cache entries (simple cleanup)
      this.cleanupCache();

      this.logger.log(`Fetched ${data.news_items.length} news items for ${symbol}`);
      return data;
    } catch (error: any) {
      this.logger.error(`Error fetching crypto news for ${symbol}: ${error.message}`);
      
      // Return cached data if available, even if expired
      if (cached) {
        this.logger.warn(`Returning expired cache for ${symbol} due to error`);
        return cached.data;
      }
      
      throw error;
    }
  }

  private cleanupCache(): void {
    const now = Date.now();
    for (const [key, value] of this.cache.entries()) {
      if (now - value.timestamp >= this.CACHE_TTL * 2) {
        // Remove entries older than 2x TTL
        this.cache.delete(key);
      }
    }
  }
}

