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
  metadata?: {
    source: 'database' | 'python_api';
    is_fresh: boolean;
    last_updated_at: string;
    freshness: string;
    message?: string;
    total_count?: number;
  };
}

// Stock News Interfaces
export interface StockNewsItem {
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

export interface StockMarketMetrics {
  total_news_count: number;
  sentiment_summary: {
    positive: number;
    negative: number;
    neutral: number;
  };
  avg_sentiment_score: number;
}

export interface StockNewsResponse {
  symbol: string;
  news_items: StockNewsItem[];
  market_metrics: StockMarketMetrics;
  timestamp: string;
  metadata?: {
    source: 'database' | 'python_api';
    is_fresh: boolean;
    last_updated_at: string;
    freshness: string;
    message?: string;
    total_count?: number;
  };
}

@Injectable()
export class NewsService {
  private readonly logger = new Logger(NewsService.name);
  
  // Simple in-memory cache (5 minutes TTL) - supports both crypto and stock news
  private cache: Map<string, { data: CryptoNewsResponse | StockNewsResponse; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes in milliseconds

  constructor(
    private pythonApi: PythonApiService,
    private prisma: PrismaService,
    private assetsService: AssetsService,
  ) {}

  /**
   * Get all news from database (no filtering by asset or time)
   * Returns ALL news with actual content
   */
  async getAllNewsFromDB(limit: number = 100) {
    try {
      // Query all news with URL and heading present
      const newsRecords = await this.prisma.trending_news.findMany({
        where: {
          article_url: { not: '' },
          heading: { not: '' },
        },
        orderBy: {
          poll_timestamp: 'desc',
        },
        take: limit,
        include: {
          asset: {
            select: {
              symbol: true,
              asset_type: true,
            },
          },
        },
      });

      this.logger.log(`Found ${newsRecords.length} news records with URLs in database`);

      // Transform to response format
      const news_items = newsRecords.map((record) => {
        const metadata = record.metadata as any;
        const newsDetail = record.news_detail as any;
        
        let description = newsDetail?.description || '';
        
        return {
          symbol: record.asset?.symbol || 'Unknown',
          title: record.heading,
          description: description,
          url: record.article_url,
          source: record.source || 'Unknown',
          published_at: record.published_at?.toISOString() || record.poll_timestamp.toISOString(),
          sentiment: {
            label: record.sentiment_label || 'neutral',
            score: Number(record.news_sentiment || 0),
            confidence: metadata?.confidence || 0.5,
          },
        };
      });

      this.logger.log(`Returning ${news_items.length} complete news items`);

      return {
        total_count: news_items.length,
        news_items: news_items,
        timestamp: new Date().toISOString(),
      };
    } catch (error: any) {
      this.logger.error(`Error reading all news from database: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get recent news from database (FAST - for user requests)
   * Reads from trending_news and sentiment_analyses tables
   */
  async getRecentNewsFromDB(symbol: string, limit: number = 10): Promise<CryptoNewsResponse> {
    try {
      const symbolUpper = symbol.toUpperCase();

      // Get or find asset
      let asset = await this.assetsService.findBySymbol(symbolUpper);
      if (!asset) {
        this.logger.warn(`Asset ${symbolUpper} not found in database`);
        return {
          symbol: symbolUpper,
          news_items: [],
          social_metrics: {
            galaxy_score: 0,
            alt_rank: 999999,
            social_volume: 0,
            price: 0,
            volume_24h: 0,
            market_cap: 0,
          },
          timestamp: new Date().toISOString(),
          metadata: {
            source: 'database',
            last_updated_at: null,
            is_fresh: false,
            freshness: 'no_data',
            message: 'No data available. Please try again later.',
          },
        };
      }

      const assetId = asset.asset_id;
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      // Single query: Fetch latest news with URL and heading present
      const newsRecords = await this.prisma.trending_news.findMany({
        where: {
          asset_id: assetId,
          poll_timestamp: { gte: sevenDaysAgo },
          article_url: { not: '' },
          heading: { not: '' },
        },
        orderBy: { poll_timestamp: 'desc' },
        take: limit,
      });

      this.logger.debug(`Found ${newsRecords.length} news records for ${symbolUpper}`);

      // Transform to response format
      const news_items: CryptoNewsItem[] = newsRecords.map((record) => {
        const newsDetail = record.news_detail as any;
        const metadata = record.metadata as any;
        
        // Extract description
        let description = newsDetail?.description || '';
        
        return {
          title: record.heading,
          description: description,
          url: record.article_url,
          source: record.source || 'Unknown',
          published_at: record.published_at?.toISOString() || record.poll_timestamp.toISOString(),
          sentiment: {
            label: record.sentiment_label || 'neutral',
            score: Number(record.news_sentiment || 0),
            confidence: metadata?.confidence || 0.5,
          },
        };
      });

      // Get latest social metrics from trending_assets
      const latestTrendingAsset = await this.prisma.trending_assets.findFirst({
        where: {
          asset_id: assetId,
        },
        orderBy: {
          poll_timestamp: 'desc',
        },
      });

      const social_metrics = {
        galaxy_score: Number(latestTrendingAsset?.galaxy_score || 0),
        alt_rank: Number(latestTrendingAsset?.alt_rank || 999999),
        social_volume: 0, // Not stored in trending_assets
        price: Number(latestTrendingAsset?.price_usd || 0),
        volume_24h: Number(latestTrendingAsset?.market_volume || 0),
        market_cap: 0, // Not stored in trending_assets
      };

      // Calculate freshness
      const latestNewsTime = newsRecords[0]?.poll_timestamp;
      const ageMinutes = latestNewsTime
        ? (now.getTime() - new Date(latestNewsTime).getTime()) / 1000 / 60
        : 999999;

      let is_fresh = false;
      if (ageMinutes < 30) is_fresh = true;

      return {
        symbol: symbolUpper,
        news_items,
        social_metrics,
        timestamp: now.toISOString(),
        metadata: {
          source: 'database',
          last_updated_at: latestNewsTime?.toISOString() || null,
          is_fresh,
          freshness: ageMinutes < 30 ? 'fresh' : ageMinutes < 120 ? 'recent' : 'cached',
          total_count: newsRecords.length,
        },
      };
    } catch (error: any) {
      this.logger.error(`Error reading news from database for ${symbol}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Fetch news from Python API and store in database (SLOW - for background jobs)
   * This method should ONLY be called by cron jobs or admin refresh endpoints
   */
  async fetchAndStoreNewsFromPython(symbol: string, limit: number = 20): Promise<CryptoNewsResponse> {
    const cacheKey = `${symbol}_${limit}`;
    
    // Check cache first
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      this.logger.debug(`Returning cached news for ${symbol}`);
      return cached.data as CryptoNewsResponse;
    }

    try {
      // Call Python API endpoint
      const response = await this.pythonApi.post<CryptoNewsResponse>(
        '/api/v1/news/crypto',
        {
          symbol: symbol.toUpperCase(),
          limit: limit,
        },
        { timeout: 300000 }, // 5 minute timeout for background jobs
      );

      const data = response.data;

      // Store news articles and sentiment data in database
      try {
        await this.storeNewsAndSentiment(symbol, data);
        this.logger.log(`Stored ${data.news_items.length} news items for ${symbol}`);
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

      this.logger.log(`Fetched ${data.news_items.length} news items from Python for ${symbol}`);
      return data;
    } catch (error: any) {
      this.logger.error(`Error fetching crypto news from Python for ${symbol}: ${error.message}`);
      
      // Return cached data if available, even if expired
      if (cached) {
        this.logger.warn(`Returning expired cache for ${symbol} due to error`);
        return cached.data as CryptoNewsResponse;
      }
      
      // Don't throw in background jobs - return partial data
      return {
        symbol: symbol.toUpperCase(),
        news_items: [],
        social_metrics: {
          galaxy_score: 0,
          alt_rank: 999999,
          social_volume: 0,
          price: 0,
          volume_24h: 0,
          market_cap: 0,
        },
        timestamp: new Date().toISOString(),
      };
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

  /**
   * Get all active crypto assets from database
   */
  async getAllActiveAssets() {
    const assets = await this.prisma.assets.findMany({
      where: {
        is_active: true,
        asset_type: 'crypto',
      },
      select: {
        asset_id: true,
        symbol: true,
        asset_type: true,
        created_at: true,
      },
      orderBy: {
        symbol: 'asc',
      },
    });

    return assets;
  }

  /**
   * Get statistics about news in database
   */
  async getNewsStats() {
    const [totalNews, newsWithContent, newsBySymbol, recentNews] = await Promise.all([
      // Total news count
      this.prisma.trending_news.count(),
      
      // News with actual content (not empty placeholders)
      this.prisma.trending_news.count({
        where: {
          OR: [
            { AND: [{ heading: { not: null } }, { heading: { not: '' } }] },
            { AND: [{ article_url: { not: null } }, { article_url: { not: '' } }] },
          ],
        },
      }),
      
      // Count by symbol
      this.prisma.trending_news.groupBy({
        by: ['asset_id'],
        _count: true,
        orderBy: {
          _count: {
            asset_id: 'desc',
          },
        },
        take: 10,
      }),
      
      // Recent news (last 24h)
      this.prisma.trending_news.count({
        where: {
          poll_timestamp: {
            gte: new Date(Date.now() - 24 * 60 * 60 * 1000),
          },
        },
      }),
    ]);

    // Get asset symbols for top assets
    const assetIds = newsBySymbol.map(item => item.asset_id);
    const assets = await this.prisma.assets.findMany({
      where: {
        asset_id: {
          in: assetIds,
        },
      },
      select: {
        asset_id: true,
        symbol: true,
      },
    });

    const assetMap = new Map(assets.map(a => [a.asset_id, a.symbol]));
    const topAssets = newsBySymbol.map(item => ({
      symbol: assetMap.get(item.asset_id) || 'Unknown',
      count: item._count,
    }));

    return {
      total_news: totalNews,
      news_with_content: newsWithContent,
      empty_placeholders: totalNews - newsWithContent,
      recent_24h: recentNews,
      top_assets: topAssets,
    };
  }

  // ============== STOCK NEWS METHODS ==============

  /**
   * Get recent stock news from database (FAST - for user requests)
   * Reads from trending_news table filtered by asset_type='stock'
   */
  async getRecentStockNewsFromDB(symbol: string, limit: number = 10): Promise<StockNewsResponse> {
    try {
      const symbolUpper = symbol.toUpperCase();

      // Find stock asset
      let asset = await this.prisma.assets.findFirst({
        where: {
          symbol: symbolUpper,
          asset_type: 'stock',
        },
      });

      if (!asset) {
        this.logger.warn(`Stock asset ${symbolUpper} not found in database`);
        return {
          symbol: symbolUpper,
          news_items: [],
          market_metrics: {
            total_news_count: 0,
            sentiment_summary: { positive: 0, negative: 0, neutral: 0 },
            avg_sentiment_score: 0,
          },
          timestamp: new Date().toISOString(),
          metadata: {
            source: 'database',
            last_updated_at: null,
            is_fresh: false,
            freshness: 'no_data',
            message: 'No data available. Please try again later.',
          },
        };
      }

      const assetId = asset.asset_id;
      const now = new Date();
      const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      this.logger.debug(`Querying stock news for asset_id: ${assetId}, symbol: ${symbolUpper}`);

      // Query trending_news for stock articles
      let newsRecords = await this.prisma.trending_news.findMany({
        where: {
          asset_id: assetId,
          poll_timestamp: {
            gte: twentyFourHoursAgo,
          },
          OR: [
            { AND: [{ heading: { not: null } }, { heading: { not: '' } }] },
            { AND: [{ article_url: { not: null } }, { article_url: { not: '' } }] },
          ],
        },
        orderBy: {
          poll_timestamp: 'desc',
        },
        take: limit * 3,
      });

      // If no news in 24h, try 7 days
      if (newsRecords.length === 0) {
        this.logger.debug(`No stock news in 24h, trying 7 days for ${symbolUpper}`);
        const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        newsRecords = await this.prisma.trending_news.findMany({
          where: {
            asset_id: assetId,
            poll_timestamp: {
              gte: sevenDaysAgo,
            },
            OR: [
              { AND: [{ heading: { not: null } }, { heading: { not: '' } }] },
              { AND: [{ article_url: { not: null } }, { article_url: { not: '' } }] },
            ],
          },
          orderBy: {
            poll_timestamp: 'desc',
          },
          take: limit * 3,
        });
      }

      // Filter and limit results
      const filteredRecords = newsRecords
        .filter((record) => {
          const metadata = record.metadata as any;
          return metadata?.note !== 'No text data available';
        })
        .slice(0, limit);

      // Transform to response format
      const news_items: StockNewsItem[] = filteredRecords.map((record) => {
        const metadata = record.metadata as any;
        const newsDetail = record.news_detail as any;

        let description = '';
        if (metadata?.description) {
          description = metadata.description;
        } else if (newsDetail?.description) {
          description = newsDetail.description;
        } else if (typeof record.news_detail === 'string') {
          description = record.news_detail;
        }

        return {
          title: record.heading || 'Stock News',
          description: description,
          url: record.article_url || '',
          source: record.source || 'StockNewsAPI',
          published_at: record.published_at?.toISOString() || record.poll_timestamp.toISOString(),
          sentiment: {
            label: record.sentiment_label || 'neutral',
            score: Number(record.news_sentiment || 0),
            confidence: metadata?.confidence || metadata?.sentiment?.confidence || 0.5,
          },
        };
      });

      // Calculate market metrics
      const sentiment_summary = { positive: 0, negative: 0, neutral: 0 };
      let totalScore = 0;

      for (const item of news_items) {
        const label = item.sentiment.label.toLowerCase();
        if (label === 'positive') sentiment_summary.positive++;
        else if (label === 'negative') sentiment_summary.negative++;
        else sentiment_summary.neutral++;
        totalScore += item.sentiment.score;
      }

      const market_metrics: StockMarketMetrics = {
        total_news_count: news_items.length,
        sentiment_summary,
        avg_sentiment_score: news_items.length > 0 ? totalScore / news_items.length : 0,
      };

      // Calculate freshness
      const latestNewsTime = filteredRecords[0]?.poll_timestamp;
      const ageMinutes = latestNewsTime
        ? (now.getTime() - new Date(latestNewsTime).getTime()) / 1000 / 60
        : 999999;

      return {
        symbol: symbolUpper,
        news_items,
        market_metrics,
        timestamp: now.toISOString(),
        metadata: {
          source: 'database',
          last_updated_at: latestNewsTime?.toISOString() || null,
          is_fresh: ageMinutes < 30,
          freshness: ageMinutes < 30 ? 'fresh' : ageMinutes < 120 ? 'recent' : 'cached',
          total_count: filteredRecords.length,
        },
      };
    } catch (error: any) {
      this.logger.error(`Error reading stock news from database for ${symbol}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Fetch stock news from Python API and store in database (SLOW - for background jobs)
   */
  async fetchAndStoreStockNewsFromPython(symbol: string, limit: number = 20): Promise<StockNewsResponse> {
    const cacheKey = `stock_${symbol}_${limit}`;

    // Check cache first
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      this.logger.debug(`Returning cached stock news for ${symbol}`);
      return cached.data as StockNewsResponse;
    }

    try {
      // Call Python API endpoint for stock news
      const response = await this.pythonApi.post<StockNewsResponse>(
        '/api/v1/news/stocks',
        {
          symbol: symbol.toUpperCase(),
          limit: limit,
        },
        { timeout: 300000 }, // 5 minute timeout
      );

      const data = response.data;

      // Store news articles in database
      try {
        await this.storeStockNewsAndSentiment(symbol, data);
        this.logger.log(`Stored ${data.news_items.length} stock news items for ${symbol}`);
      } catch (storageError: any) {
        this.logger.error(
          `Error storing stock news for ${symbol}: ${storageError.message}`,
        );
      }

      // Cache the response
      this.cache.set(cacheKey, {
        data,
        timestamp: Date.now(),
      });

      this.cleanupCache();

      this.logger.log(`Fetched ${data.news_items.length} stock news items from Python for ${symbol}`);
      return data;
    } catch (error: any) {
      this.logger.error(`Error fetching stock news from Python for ${symbol}: ${error.message}`);

      // Return cached data if available
      if (cached) {
        this.logger.warn(`Returning expired cache for stock ${symbol} due to error`);
        return cached.data as StockNewsResponse;
      }

      // Return empty response
      return {
        symbol: symbol.toUpperCase(),
        news_items: [],
        market_metrics: {
          total_news_count: 0,
          sentiment_summary: { positive: 0, negative: 0, neutral: 0 },
          avg_sentiment_score: 0,
        },
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Store stock news articles and sentiment data in database
   */
  private async storeStockNewsAndSentiment(
    symbol: string,
    data: StockNewsResponse,
  ): Promise<void> {
    // Get or create stock asset
    let asset = await this.prisma.assets.findFirst({
      where: {
        symbol: symbol.toUpperCase(),
        asset_type: 'stock',
      },
    });

    if (!asset) {
      this.logger.debug(`Creating new stock asset for symbol ${symbol}`);
      asset = await this.prisma.assets.create({
        data: {
          symbol: symbol.toUpperCase(),
          asset_type: 'stock',
          is_active: true,
          first_seen_at: new Date(),
          last_seen_at: new Date(),
        },
      });
    }

    const assetId = asset.asset_id;
    const currentTimestamp = new Date();

    let storedCount = 0;
    let skippedCount = 0;

    for (const newsItem of data.news_items) {
      // Check for duplicate
      if (newsItem.url) {
        const existingNews = await this.prisma.trending_news.findFirst({
          where: {
            asset_id: assetId,
            article_url: newsItem.url,
          },
        });

        if (existingNews) {
          skippedCount++;
          continue;
        }
      }

      // Map source to enum
      const sourceEnum = this.mapSourceToEnum(newsItem.source, 'stock');
      const sentimentLabelEnum = this.mapSentimentToEnum(newsItem.sentiment.label);

      // Parse published_at
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

      const pollTimestamp = publishedAt || currentTimestamp;
      const uniqueTimestamp = new Date(pollTimestamp.getTime() + storedCount * 1000);

      try {
        await this.prisma.trending_news.create({
          data: {
            poll_timestamp: uniqueTimestamp,
            asset_id: assetId,
            news_sentiment: newsItem.sentiment.score,
            news_score: newsItem.sentiment.score,
            news_volume: 1,
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
              },
            },
          } as any,
        });

        storedCount++;
      } catch (error: any) {
        this.logger.warn(`Error storing stock news article for ${symbol}: ${error.message}`);
      }
    }

    this.logger.debug(
      `Stored ${storedCount} stock news articles, skipped ${skippedCount} duplicates for ${symbol}`,
    );
  }

  /**
   * Fetch general stock news from Python API and store in database
   * This fetches news for multiple popular stocks at once
   */
  async fetchAndStoreGeneralStockNewsFromPython(limit: number = 30): Promise<{
    total_fetched: number;
    total_stored: number;
    symbols: string[];
  }> {
    try {
      this.logger.log(`Fetching general stock news from Python API (limit=${limit})`);

      // Call Python API endpoint for general stock news
      const response = await this.pythonApi.post<{
        total_count: number;
        news_items: Array<{
          symbol: string;
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
        }>;
        timestamp: string;
      }>(
        '/api/v1/news/stocks/general',
        { limit },
        { timeout: 300000 }, // 5 minute timeout for sentiment analysis
      );

      const data = response.data;
      const symbols = new Set<string>();
      let storedCount = 0;

      this.logger.log(`Received ${data.news_items.length} general stock news items from Python`);

      // Store each news item
      for (const newsItem of data.news_items) {
        try {
          const symbol = newsItem.symbol || 'GENERAL';
          symbols.add(symbol);

          // Get or create stock asset
          let asset = await this.prisma.assets.findFirst({
            where: {
              symbol: symbol.toUpperCase(),
              asset_type: 'stock',
            },
          });

          if (!asset) {
            asset = await this.prisma.assets.create({
              data: {
                symbol: symbol.toUpperCase(),
                asset_type: 'stock',
                is_active: true,
                first_seen_at: new Date(),
                last_seen_at: new Date(),
              },
            });
            this.logger.debug(`Created new stock asset: ${symbol}`);
          }

          // Check for duplicate
          if (newsItem.url) {
            const existingNews = await this.prisma.trending_news.findFirst({
              where: {
                asset_id: asset.asset_id,
                article_url: newsItem.url,
              },
            });

            if (existingNews) {
              continue; // Skip duplicate
            }
          }

          // Map source and sentiment
          const sourceEnum = this.mapSourceToEnum(newsItem.source, 'stock');
          const sentimentLabelEnum = this.mapSentimentToEnum(newsItem.sentiment.label);

          // Parse published_at
          let publishedAt: Date | null = null;
          if (newsItem.published_at) {
            try {
              publishedAt = new Date(newsItem.published_at);
              if (isNaN(publishedAt.getTime())) publishedAt = null;
            } catch (e) {
              publishedAt = null;
            }
          }

          const pollTimestamp = publishedAt || new Date();
          const uniqueTimestamp = new Date(pollTimestamp.getTime() + storedCount * 1000);

          await this.prisma.trending_news.create({
            data: {
              poll_timestamp: uniqueTimestamp,
              asset_id: asset.asset_id,
              news_sentiment: newsItem.sentiment.score,
              news_score: newsItem.sentiment.score,
              news_volume: 1,
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
                },
              },
            } as any,
          });

          storedCount++;
        } catch (error: any) {
          this.logger.warn(`Error storing news item: ${error.message}`);
        }
      }

      this.logger.log(`Stored ${storedCount} general stock news items for ${symbols.size} symbols`);

      return {
        total_fetched: data.news_items.length,
        total_stored: storedCount,
        symbols: Array.from(symbols),
      };
    } catch (error: any) {
      this.logger.error(`Error fetching general stock news: ${error.message}`);
      throw error;
    }
  }

  /**
   * Fetch general stock news FAST (no sentiment analysis)
   * Use this for initial data population
   */
  async fetchAndStoreGeneralStockNewsFast(limit: number = 20, tickers?: string[]): Promise<{
    total_fetched: number;
    total_stored: number;
    symbols: string[];
  }> {
    const defaultTickers = ["AAPL", "TSLA", "GOOGL", "AMZN", "MSFT"];
    const tickersToUse = tickers || defaultTickers;
    
    try {
      this.logger.log(`Fetching stock news FAST for [${tickersToUse.join(', ')}] - limit=${limit}`);

      // Call Python API endpoint for fast stock news (no sentiment)
      const response = await this.pythonApi.post<{
        total_count: number;
        news_items: Array<{
          symbol: string;
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
        }>;
        timestamp: string;
      }>(
        '/api/v1/news/stocks/general/fast',
        { limit, tickers: tickersToUse },
        { timeout: 30000 }, // 30 second timeout
      );

      const data = response.data;
      const symbols = new Set<string>();
      let storedCount = 0;

      this.logger.log(`Received ${data.news_items.length} stock news items (fast mode)`);

      // Store each news item
      for (const newsItem of data.news_items) {
        try {
          const symbol = newsItem.symbol || 'GENERAL';
          symbols.add(symbol);

          // Get or create stock asset
          let asset = await this.prisma.assets.findFirst({
            where: {
              symbol: symbol.toUpperCase(),
              asset_type: 'stock',
            },
          });

          if (!asset) {
            asset = await this.prisma.assets.create({
              data: {
                symbol: symbol.toUpperCase(),
                asset_type: 'stock',
                is_active: true,
                first_seen_at: new Date(),
                last_seen_at: new Date(),
              },
            });
            this.logger.debug(`Created new stock asset: ${symbol}`);
          }

          // Check for duplicate by URL
          if (newsItem.url) {
            const existingNews = await this.prisma.trending_news.findFirst({
              where: {
                asset_id: asset.asset_id,
                article_url: newsItem.url,
              },
            });

            if (existingNews) {
              continue; // Skip duplicate
            }
          }

          // Parse published_at
          let publishedAt: Date | null = null;
          if (newsItem.published_at) {
            try {
              publishedAt = new Date(newsItem.published_at);
              if (isNaN(publishedAt.getTime())) publishedAt = null;
            } catch (e) {
              publishedAt = null;
            }
          }

          const pollTimestamp = publishedAt || new Date();
          const uniqueTimestamp = new Date(pollTimestamp.getTime() + storedCount * 1000);

          await this.prisma.trending_news.create({
            data: {
              poll_timestamp: uniqueTimestamp,
              asset_id: asset.asset_id,
              news_sentiment: 0, // Neutral - no sentiment analysis
              news_score: 0,
              news_volume: 1,
              heading: newsItem.title || null,
              article_url: newsItem.url || null,
              published_at: publishedAt,
              sentiment_label: 'neutral' as any,
              source: 'StockNewsAPI' as any,
              news_detail: {
                description: newsItem.description,
                source: newsItem.source,
              },
              metadata: {
                fast_mode: true,
                needs_sentiment: true,
              },
            } as any,
          });

          storedCount++;
        } catch (error: any) {
          this.logger.warn(`Error storing news item: ${error.message}`);
        }
      }

      this.logger.log(`FAST: Stored ${storedCount} stock news items for ${symbols.size} symbols`);

      return {
        total_fetched: data.news_items.length,
        total_stored: storedCount,
        symbols: Array.from(symbols),
      };
    } catch (error: any) {
      this.logger.error(`Error in fast stock news fetch: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get all stock news from database
   */
  async getAllStockNewsFromDB(limit: number = 100) {
    try {
      // First, check how many stock assets exist
      const stockAssetCount = await this.prisma.assets.count({
        where: { asset_type: 'stock' },
      });
      this.logger.debug(`Total stock assets in database: ${stockAssetCount}`);

      // Check total trending_news for stocks (without article filter)
      const totalStockNews = await this.prisma.trending_news.count({
        where: {
          asset: {
            asset_type: 'stock',
          },
        },
      });
      this.logger.debug(`Total stock news records (no filter): ${totalStockNews}`);

      const newsRecords = await this.prisma.trending_news.findMany({
        where: {
          AND: [
            { article_url: { not: null } },
            { article_url: { not: '' } },
            { heading: { not: null } },
            { heading: { not: '' } },
          ],
          asset: {
            asset_type: 'stock',
          },
        },
        orderBy: {
          poll_timestamp: 'desc',
        },
        take: limit * 3,
        include: {
          asset: {
            select: {
              symbol: true,
              asset_type: true,
            },
          },
        },
      });

      this.logger.log(`Found ${newsRecords.length} stock news records in database (with article filter)`);

      // If no records with strict filter, try without article_url filter
      if (newsRecords.length === 0 && totalStockNews > 0) {
        this.logger.warn('No records with article_url, fetching without that filter');
        const fallbackRecords = await this.prisma.trending_news.findMany({
          where: {
            heading: { not: null },
            asset: {
              asset_type: 'stock',
            },
          },
          orderBy: {
            poll_timestamp: 'desc',
          },
          take: limit,
          include: {
            asset: {
              select: {
                symbol: true,
                asset_type: true,
              },
            },
          },
        });
        this.logger.log(`Fallback query found ${fallbackRecords.length} records`);
        
        // Use fallback records if main query was empty
        if (fallbackRecords.length > 0) {
          const fallbackItems = fallbackRecords.map((record) => {
            const metadata = record.metadata as any;
            const newsDetail = record.news_detail as any;
            
            let description = '';
            if (newsDetail?.description) description = newsDetail.description;
            else if (metadata?.sentiment?.description) description = metadata.sentiment.description;
            
            // Confidence is stored in metadata.sentiment.confidence
            const confidence = metadata?.sentiment?.confidence ?? metadata?.confidence ?? 0.5;

            return {
              symbol: record.asset?.symbol || 'Unknown',
              title: record.heading || 'Stock News',
              description: description,
              url: record.article_url || '',
              source: String(record.source || 'StockNewsAPI'),
              published_at: record.published_at?.toISOString() || record.poll_timestamp.toISOString(),
              sentiment: {
                label: String(record.sentiment_label || 'neutral'),
                score: Number(record.news_sentiment || 0),
                confidence: Number(confidence),
              },
            };
          });

          return {
            total_count: fallbackItems.length,
            news_items: fallbackItems,
            timestamp: new Date().toISOString(),
          };
        }
      }

      const news_items = newsRecords
        .map((record) => {
          const metadata = record.metadata as any;
          const newsDetail = record.news_detail as any;

          let description = '';
          if (newsDetail?.description) {
            description = newsDetail.description;
          } else if (metadata?.description) {
            description = metadata.description;
          }

          // Confidence is stored in metadata.sentiment.confidence
          const confidence = metadata?.sentiment?.confidence ?? metadata?.confidence ?? 0.5;

          return {
            symbol: record.asset?.symbol || 'Unknown',
            title: record.heading || 'Stock News',
            description: description,
            url: record.article_url || '',
            source: String(record.source || 'StockNewsAPI'),
            published_at: record.published_at?.toISOString() || record.poll_timestamp.toISOString(),
            sentiment: {
              label: String(record.sentiment_label || 'neutral'),
              score: Number(record.news_sentiment || 0),
              confidence: Number(confidence),
            },
          };
        })
        .slice(0, limit);

      return {
        total_count: news_items.length,
        news_items: news_items,
        timestamp: new Date().toISOString(),
      };
    } catch (error: any) {
      this.logger.error(`Error reading all stock news from database: ${error.message}`);
      throw error;
    }
  }
}
