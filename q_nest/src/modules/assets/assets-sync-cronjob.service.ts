import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { MarketService } from '../market/market.service';

@Injectable()
export class AssetsSyncCronjobService implements OnModuleInit {
  private readonly logger = new Logger(AssetsSyncCronjobService.name);
  private lastSyncTime: Date | null = null;
  private isRunning = false;

  constructor(
    private prisma: PrismaService,
    private marketService: MarketService,
  ) {}

  async onModuleInit() {
    // Sync assets on startup (optional - runs once when server starts)
    // Uncomment the line below if you want to sync on startup
    // await this.syncAssetsFromCoinGecko();
  }

  /**
   * Sync top 500 coins from CoinGecko to assets and market_rankings tables
   * Runs every 15 minutes (CoinGecko Pro tier)
   */
  @Cron('*/15 * * * *') // Every 15 minutes
  async syncAssetsFromCoinGecko(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    try {
      const coins = await this.marketService.getTop500Coins();
      const result = await this.syncCoins(coins);
      this.logger.log(`CoinGecko sync complete: created=${result.created}, updated=${result.updated}, errors=${result.errors}, rankings=${result.marketSnapshots}`);
      this.lastSyncTime = new Date();
    } catch (error: any) {
      this.logger.error(`Fatal error in CoinGecko assets sync: ${error.message}`);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Shared sync logic used by both scheduled and manual sync.
   * Processes coins in batched upserts instead of sequential queries.
   * ~20 queries per sync instead of ~1,500.
   */
  private async syncCoins(coins: any[]): Promise<{ created: number; updated: number; errors: number; total: number; marketSnapshots: number }> {
    const BATCH_SIZE = 50;
    let upsertedCount = 0;
    let errorCount = 0;
    let marketRankingsCount = 0;
    const rankTimestamp = new Date();
    const now = new Date();

    for (let i = 0; i < coins.length; i += BATCH_SIZE) {
      const batch = coins.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(coins.length / BATCH_SIZE);

      // Step 1: Batch upsert assets
      try {
        const assetUpserts = batch.map((coin) => {
          const symbol = coin.symbol.toUpperCase();
          return this.prisma.assets.upsert({
            where: { symbol_asset_type: { symbol, asset_type: 'crypto' } },
            create: {
              symbol,
              name: coin.name,
              display_name: coin.name,
              coingecko_id: coin.id,
              logo_url: coin.image,
              market_cap_rank: coin.market_cap_rank,
              asset_type: 'crypto',
              is_active: true,
              first_seen_at: now,
              last_seen_at: now,
            },
            update: {
              name: coin.name,
              display_name: coin.name,
              coingecko_id: coin.id,
              logo_url: coin.image,
              market_cap_rank: coin.market_cap_rank,
              last_seen_at: now,
              is_active: true,
            },
            select: { asset_id: true },
          });
        });

        const results = await this.prisma.$transaction(assetUpserts);
        upsertedCount += results.length;

        // Step 2: Batch upsert market_rankings using the returned asset_ids
        const rankingUpserts = results.map((asset, idx) => {
          const coin = batch[idx];
          return this.prisma.market_rankings.upsert({
            where: {
              rank_timestamp_asset_id: {
                rank_timestamp: rankTimestamp,
                asset_id: asset.asset_id,
              },
            },
            create: {
              rank_timestamp: rankTimestamp,
              asset_id: asset.asset_id,
              rank: coin.market_cap_rank,
              market_cap: coin.market_cap,
              price_usd: coin.current_price,
              volume_24h: coin.total_volume,
              change_percent_24h: coin.price_change_percentage_24h || 0,
              change_24h: coin.price_change_24h || 0,
            },
            update: {
              rank: coin.market_cap_rank,
              market_cap: coin.market_cap,
              price_usd: coin.current_price,
              volume_24h: coin.total_volume,
              change_percent_24h: coin.price_change_percentage_24h || 0,
              change_24h: coin.price_change_24h || 0,
            },
          });
        });

        await this.prisma.$transaction(rankingUpserts);
        marketRankingsCount += rankingUpserts.length;

        this.logger.log(`Batch ${batchNum}/${totalBatches}: upserted ${results.length} assets + ${rankingUpserts.length} rankings`);
      } catch (error: any) {
        this.logger.error(`Batch ${batchNum}/${totalBatches} failed: ${error.message}`);
        errorCount += batch.length;
      }
    }

    return {
      created: 0, // upsert doesn't distinguish create vs update
      updated: upsertedCount,
      errors: errorCount,
      total: coins.length,
      marketSnapshots: marketRankingsCount,
    };
  }

  /**
   * Get sync status for monitoring
   */
  getSyncStatus(): {
    lastSyncTime: Date | null;
    isRunning: boolean;
  } {
    return {
      lastSyncTime: this.lastSyncTime,
      isRunning: this.isRunning,
    };
  }

  /**
   * Manual sync method (can be called via API endpoint)
   */
  async manualSync(): Promise<{ created: number; updated: number; errors: number; total: number; marketSnapshots: number }> {
    const coins = await this.marketService.getTop500Coins();
    return this.syncCoins(coins);
  }
}

