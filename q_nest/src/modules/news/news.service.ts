import { Injectable, Logger } from '@nestjs/common';
import { PythonApiService } from '../../kyc/integrations/python-api.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AssetsService } from '../assets/assets.service';

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
    layer_breakdown?: any;
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

  constructor(
    private pythonApi: PythonApiService,
    private prisma: PrismaService,
    private assetsService: AssetsService,
  ) {}

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

      // Store news articles and sentiment data in database
      try {
        await this.storeNewsAndSentiment(symbol, data);
      } catch (storageError: any) {
        // Log error but don't fail the request
        this.logger.error(
          `Error storing news and sentiment for ${symbol}: ${storageError.message}`,
        );
      }

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

  /**
   * Store news articles and sentiment data in database
   */
  private async storeNewsAndSentiment(
    symbol: string,
    data: CryptoNewsResponse,
  ): Promise<void> {
    // Get or create asset
    let asset = await this.assetsService.findBySymbol(symbol);
    if (!asset) {
      this.logger.debug(`Creating new asset for symbol ${symbol}`);
      asset = await this.assetsService.create({
        symbol: symbol,
        asset_type: 'crypto',
        is_active: true,
      });
    }

    const assetId = asset.asset_id;
    const currentTimestamp = new Date();

    // Store each news item in trending_news (with deduplication)
    let storedCount = 0;
    let skippedCount = 0;
    let aggregatedSentiment = {
      totalScore: 0,
      totalConfidence: 0,
      count: 0,
      labels: { positive: 0, negative: 0, neutral: 0 },
    };

    for (const newsItem of data.news_items) {
      // Check if news article already exists (deduplication by URL + asset_id)
      if (newsItem.url) {
        const existingNews = await this.prisma.trending_news.findFirst({
          where: {
            asset_id: assetId,
            article_url: newsItem.url,
          },
          orderBy: {
            poll_timestamp: 'desc',
          },
        });

        if (existingNews) {
          skippedCount++;
          this.logger.debug(
            `Skipping duplicate news article: ${newsItem.url} for ${symbol}`,
          );
          
          // Still store sentiment analysis result even for duplicate articles
          // (each sentiment engine result is a separate analysis event)
          try {
            const sourceEnum = this.mapSourceToEnum(newsItem.source, 'crypto');
            await this.prisma.sentiment_analyses.create({
              data: {
                source_type: sourceEnum || 'news',
                label: newsItem.sentiment.label,
                score: newsItem.sentiment.score,
                confidence: newsItem.sentiment.confidence,
                created_at: currentTimestamp,
              },
            });
          } catch (error: any) {
            this.logger.warn(
              `Error storing sentiment analysis for duplicate article ${symbol}: ${error.message}`,
            );
          }
          
          // Still aggregate sentiment for EMA state (even if article already stored)
          aggregatedSentiment.totalScore += newsItem.sentiment.score;
          aggregatedSentiment.totalConfidence += newsItem.sentiment.confidence;
          aggregatedSentiment.count++;
          const label = newsItem.sentiment.label.toLowerCase();
          if (label === 'positive') {
            aggregatedSentiment.labels.positive++;
          } else if (label === 'negative') {
            aggregatedSentiment.labels.negative++;
          } else {
            aggregatedSentiment.labels.neutral++;
          }
          continue;
        }
      }

      // Map source to enum
      const sourceEnum = this.mapSourceToEnum(newsItem.source, 'crypto');

      // Map sentiment label to enum
      const sentimentLabelEnum = this.mapSentimentToEnum(
        newsItem.sentiment.label,
      );

      // Parse published_at date
      let publishedAt: Date | null = null;
      if (newsItem.published_at) {
        try {
          publishedAt = new Date(newsItem.published_at);
          if (isNaN(publishedAt.getTime())) {
            publishedAt = null;
          }
        } catch (e) {
          publishedAt = null;
        }
      }

      // Use published_at as poll_timestamp if available, otherwise use current time
      // Add small offset (milliseconds) to ensure uniqueness for primary key constraint
      const pollTimestamp = publishedAt || currentTimestamp;
      // Add milliseconds offset based on storedCount to ensure unique timestamps
      const uniqueTimestamp = new Date(
        pollTimestamp.getTime() + storedCount * 1000,
      );

      // Store news article
      try {
        await this.prisma.trending_news.create({
          data: {
            poll_timestamp: uniqueTimestamp,
            asset_id: assetId,
            news_sentiment: newsItem.sentiment.score,
            news_score: newsItem.sentiment.score,
            news_volume: 1, // Single article
            heading: newsItem.title || null,
            article_url: newsItem.url || null,
            published_at: publishedAt,
            sentiment_label: sentimentLabelEnum as any,
            source: sourceEnum as any,
            news_detail: {
              description: newsItem.description,
              source: newsItem.source,
            },
            metadata: {
              sentiment: {
                label: newsItem.sentiment.label,
                score: newsItem.sentiment.score,
                confidence: newsItem.sentiment.confidence,
                layer_breakdown: newsItem.sentiment.layer_breakdown,
              },
            },
          } as any,
        });

        // Store sentiment analysis result in sentiment_analyses table
        try {
          await this.prisma.sentiment_analyses.create({
            data: {
              source_type: sourceEnum || 'news',
              label: newsItem.sentiment.label,
              score: newsItem.sentiment.score,
              confidence: newsItem.sentiment.confidence,
              created_at: uniqueTimestamp,
            },
          });
        } catch (error: any) {
          this.logger.warn(
            `Error storing sentiment analysis for ${symbol}: ${error.message}`,
          );
          // Continue with next article
        }

        storedCount++;

        // Aggregate sentiment for EMA state
        aggregatedSentiment.totalScore += newsItem.sentiment.score;
        aggregatedSentiment.totalConfidence += newsItem.sentiment.confidence;
        aggregatedSentiment.count++;
        const label = newsItem.sentiment.label.toLowerCase();
        if (label === 'positive') {
          aggregatedSentiment.labels.positive++;
        } else if (label === 'negative') {
          aggregatedSentiment.labels.negative++;
        } else {
          aggregatedSentiment.labels.neutral++;
        }
      } catch (error: any) {
        this.logger.warn(
          `Error storing news article for ${symbol}: ${error.message}`,
        );
        // Continue with next article
      }
    }

    // Store aggregated sentiment in sentiment_ema_state
    if (aggregatedSentiment.count > 0) {
      try {
        const avgScore =
          aggregatedSentiment.totalScore / aggregatedSentiment.count;
        const avgConfidence =
          aggregatedSentiment.totalConfidence / aggregatedSentiment.count;

        // Determine overall sentiment label
        const { positive, negative, neutral } = aggregatedSentiment.labels;
        let overallSentiment = 'neutral';
        if (positive > negative && positive > neutral) {
          overallSentiment = 'positive';
        } else if (negative > positive && negative > neutral) {
          overallSentiment = 'negative';
        }

        await this.prisma.sentiment_ema_state.upsert({
          where: {
            asset_id: symbol, // Uses symbol (VARCHAR) not UUID
          },
          update: {
            ema_value: avgScore,
            raw_score: avgScore,
            last_timestamp: currentTimestamp,
            metadata: {
              sentiment: overallSentiment,
              confidence: avgConfidence,
              total_texts: aggregatedSentiment.count,
              labels: aggregatedSentiment.labels,
              last_updated: currentTimestamp.toISOString(),
            },
          },
          create: {
            asset_id: symbol,
            ema_value: avgScore,
            raw_score: avgScore,
            momentum: 0, // Will be calculated by EMA service
            last_timestamp: currentTimestamp,
            metadata: {
              sentiment: overallSentiment,
              confidence: avgConfidence,
              total_texts: aggregatedSentiment.count,
              labels: aggregatedSentiment.labels,
            },
          },
        });
      } catch (error: any) {
        this.logger.warn(
          `Error storing sentiment EMA state for ${symbol}: ${error.message}`,
        );
      }
    }

    // Store social metrics in trending_assets
    try {
      await this.prisma.trending_assets.create({
        data: {
          poll_timestamp: currentTimestamp,
          asset_id: assetId,
          galaxy_score: data.social_metrics.galaxy_score || null,
          alt_rank: data.social_metrics.alt_rank || null,
          social_score: data.social_metrics.social_volume || null,
          market_volume: data.social_metrics.volume_24h || null,
          price_usd: data.social_metrics.price || null,
        },
      });
    } catch (error: any) {
      // Ignore duplicate key errors (same timestamp + asset_id)
      if (!error.message?.includes('Unique constraint')) {
        this.logger.warn(
          `Error storing trending assets for ${symbol}: ${error.message}`,
        );
      }
    }

    this.logger.debug(
      `Stored ${storedCount} news articles, skipped ${skippedCount} duplicates for ${symbol}`,
    );
  }

  /**
   * Map source string to NewsSource enum
   */
  private mapSourceToEnum(source: string, assetType: string): any {
    if (!source) {
      return assetType === 'stock' ? 'StockNewsAPI' : 'LunarCrush';
    }

    const sourceLower = source.toLowerCase();

    if (
      sourceLower.includes('stock_news') ||
      sourceLower.includes('stocknews') ||
      sourceLower.includes('stock_news_api')
    ) {
      return 'StockNewsAPI';
    } else if (
      sourceLower.includes('lunarcrush') ||
      sourceLower.includes('lunar')
    ) {
      return 'LunarCrush';
    } else {
      return assetType === 'stock' ? 'StockNewsAPI' : 'LunarCrush';
    }
  }

  /**
   * Map sentiment string to SentimentLabel enum
   */
  private mapSentimentToEnum(sentiment: string): any {
    if (!sentiment) return null;

    const sentimentLower = sentiment.toLowerCase();

    if (sentimentLower === 'positive') {
      return 'positive';
    } else if (sentimentLower === 'negative') {
      return 'negative';
    } else if (sentimentLower === 'neutral') {
      return 'neutral';
    }

    return null;
  }
}

