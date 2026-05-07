import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { NewsService, CryptoNewsItem, StockNewsItem } from '../news/news.service';
import { COLD_REFRESH_QUEUE, ColdRefreshJobData } from './cold-refresh.processor';

export type PositionAssetType = 'crypto' | 'stock';

export interface PositionInsightItem {
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

export interface PositionInsightResponse {
  symbol: string;
  assetType: PositionAssetType;
  news_items: PositionInsightItem[];
  sentimentSummary: {
    positive: number;
    negative: number;
    neutral: number;
  };
  marketMood: 'bullish' | 'bearish' | 'neutral';
  refreshing: boolean;
  generatedAt: string;
  freshness?: string;
  lastUpdatedAt?: string | null;
}

const DEFAULT_LIMIT = 10;
const STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6 hours

@Injectable()
export class PositionInsightsService {
  private readonly logger = new Logger(PositionInsightsService.name);

  constructor(
    private readonly newsService: NewsService,
    @InjectQueue(COLD_REFRESH_QUEUE)
    private readonly coldRefreshQueue: Queue<ColdRefreshJobData>,
  ) {}

  async getInsight(
    rawSymbol: string,
    assetType: PositionAssetType,
  ): Promise<PositionInsightResponse> {
    const symbol = this.normalizeSymbol(rawSymbol, assetType);

    const items =
      assetType === 'crypto'
        ? await this.fetchCrypto(symbol)
        : await this.fetchStock(symbol);

    const sentimentSummary = this.computeSentimentSummary(items.news_items);
    const marketMood = this.deriveMarketMood(sentimentSummary);

    // Cold-tier: if DB is empty or > 6h stale, kick off a one-off refresh job
    // so the next poll/click returns fresh data. The endpoint itself stays
    // DB-only — we never block the user request on an upstream API call.
    const isStale = this.isStale(items.lastUpdatedAt);
    const shouldRefresh = items.news_items.length === 0 || isStale;
    let refreshing = false;
    if (shouldRefresh) {
      refreshing = await this.enqueueColdRefresh(symbol, assetType);
    }

    return {
      symbol,
      assetType,
      news_items: items.news_items,
      sentimentSummary,
      marketMood,
      refreshing,
      generatedAt: new Date().toISOString(),
      freshness: isStale && items.news_items.length === 0 ? 'no_data' : items.freshness,
      lastUpdatedAt: items.lastUpdatedAt,
    };
  }

  /**
   * Enqueue a single cold-refresh job. `jobId` is set to a deterministic key
   * so concurrent clicks on the same symbol collapse into one job. Returns
   * `true` if a job was added or already pending; never throws into the
   * request path — queue outages just degrade to "no refresh this turn".
   */
  private async enqueueColdRefresh(
    symbol: string,
    assetType: PositionAssetType,
  ): Promise<boolean> {
    try {
      const jobId = `${assetType}:${symbol}`;
      await this.coldRefreshQueue.add(
        'refresh',
        { symbol, assetType },
        {
          jobId,
          removeOnComplete: { age: 600 }, // keep 10 min so dedup window > polling window
          removeOnFail: { age: 600 },
          attempts: 1,
        },
      );
      return true;
    } catch (err: any) {
      this.logger.warn(
        `Failed to enqueue cold-refresh for ${assetType} ${symbol}: ${err?.message}`,
      );
      return false;
    }
  }

  private async fetchCrypto(symbol: string) {
    const res = await this.newsService.getRecentNewsFromDB(symbol, DEFAULT_LIMIT);
    return {
      news_items: this.mapItems(res.news_items),
      lastUpdatedAt: res.metadata?.last_updated_at ?? null,
      freshness: res.metadata?.freshness,
    };
  }

  private async fetchStock(symbol: string) {
    const res = await this.newsService.getRecentStockNewsFromDB(symbol, DEFAULT_LIMIT);
    return {
      news_items: this.mapItems(res.news_items),
      lastUpdatedAt: res.metadata?.last_updated_at ?? null,
      freshness: res.metadata?.freshness,
    };
  }

  private mapItems(
    items: Array<CryptoNewsItem | StockNewsItem>,
  ): PositionInsightItem[] {
    return items.map((it) => ({
      title: it.title,
      description: it.description,
      url: it.url,
      source: it.source,
      published_at: it.published_at,
      sentiment: {
        label: (it.sentiment?.label || 'neutral').toLowerCase(),
        score: Number(it.sentiment?.score ?? 0),
        confidence: Number(it.sentiment?.confidence ?? 0.5),
      },
    }));
  }

  private computeSentimentSummary(items: PositionInsightItem[]) {
    const summary = { positive: 0, negative: 0, neutral: 0 };
    for (const it of items) {
      const label = it.sentiment.label;
      if (label === 'positive') summary.positive++;
      else if (label === 'negative') summary.negative++;
      else summary.neutral++;
    }
    return summary;
  }

  private deriveMarketMood(s: {
    positive: number;
    negative: number;
    neutral: number;
  }): 'bullish' | 'bearish' | 'neutral' {
    if (s.positive === 0 && s.negative === 0) return 'neutral';
    if (s.positive > s.negative * 1.5) return 'bullish';
    if (s.negative > s.positive * 1.5) return 'bearish';
    return 'neutral';
  }

  private isStale(lastUpdatedAt: string | null | undefined): boolean {
    if (!lastUpdatedAt) return true;
    const ts = new Date(lastUpdatedAt).getTime();
    if (isNaN(ts)) return true;
    return Date.now() - ts > STALE_THRESHOLD_MS;
  }

  /**
   * Strip exchange suffixes (USDT, BUSD, USDC, USD) from crypto symbols so
   * `BTCUSDT` lookups resolve to the `BTC` row in `trending_news`. Stock
   * tickers are returned as-is. Always uppercased.
   */
  private normalizeSymbol(raw: string, assetType: PositionAssetType): string {
    const upper = (raw || '').trim().toUpperCase();
    if (assetType !== 'crypto') return upper;
    return upper
      .replace(/USDT$/, '')
      .replace(/BUSD$/, '')
      .replace(/USDC$/, '')
      .replace(/USD$/, '')
      || upper;
  }
}
