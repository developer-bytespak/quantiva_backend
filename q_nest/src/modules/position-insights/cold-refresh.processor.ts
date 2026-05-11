import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { NewsService } from '../news/news.service';

export const COLD_REFRESH_QUEUE = 'position-cold-refresh';

export interface ColdRefreshJobData {
  symbol: string;
  assetType: 'crypto' | 'stock';
}

/**
 * Processes click-triggered news refreshes for held positions whose symbol
 * isn't currently warm in `trending_news`. Concurrency = 1 so we spread calls
 * out and never burst against the Python-side quota gate.
 */
@Processor(COLD_REFRESH_QUEUE, {
  concurrency: 1,
  drainDelay: 60,
  stalledInterval: 60_000,
})
@Injectable()
export class ColdRefreshProcessor extends WorkerHost {
  private readonly logger = new Logger(ColdRefreshProcessor.name);

  constructor(private readonly newsService: NewsService) {
    super();
  }

  async process(job: Job<ColdRefreshJobData>): Promise<void> {
    const { symbol, assetType } = job.data;
    if (!symbol || !assetType) {
      this.logger.warn(`cold-refresh job ${job.id} missing symbol/assetType`);
      return;
    }

    const upper = symbol.toUpperCase();
    this.logger.log(`cold-refresh: ${assetType} ${upper}`);

    try {
      if (assetType === 'crypto') {
        await this.newsService.fetchAndStoreNewsFromPython(upper, 20);
      } else {
        // Single-ticker stock refresh — simpler than batching on cold path.
        await this.newsService.fetchAndStoreStockNewsFromPython(upper, 20);
      }
    } catch (err: any) {
      // Don't throw — Python-side quota gate denials surface as empty
      // responses, not exceptions, so any real exception here is a bug.
      // Log and let BullMQ mark the job complete.
      this.logger.error(
        `cold-refresh failed for ${assetType} ${upper}: ${err?.message}`,
      );
    }
  }
}
