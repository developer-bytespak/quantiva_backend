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
   * Runs every 5 minutes (CoinGecko Pro tier)
   */
  @Cron('*/5 * * * *') // Every 5 minutes
  async syncAssetsFromCoinGecko(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Sync already in progress, skipping this run');
      return;
    }

    this.isRunning = true;
    this.logger.log('Starting CoinGecko assets sync cronjob');
    const startTime = Date.now();
    let createdCount = 0;
    let updatedCount = 0;
    let errorCount = 0;
    let marketRankingsCount = 0;

    try {
      // Fetch top 500 coins from CoinGecko
      this.logger.log('Fetching top 500 coins from CoinGecko (Pro tier)...');
      const coins = await this.marketService.getTop500Coins();

      this.logger.log(`Fetched ${coins.length} coins from CoinGecko`);
      const rankTimestamp = new Date();

      for (const coin of coins) {
        try {
          const symbol = coin.symbol.toUpperCase();
          const now = new Date();

          // Check if asset already exists
          const existingAsset = await this.prisma.assets.findFirst({
            where: { symbol },
          });

          if (existingAsset) {
            // Update existing asset with full metadata
            await this.prisma.assets.update({
              where: { asset_id: existingAsset.asset_id },
              data: {
                name: coin.name,
                display_name: coin.name,
                coingecko_id: coin.id,
                logo_url: coin.image,
                market_cap_rank: coin.market_cap_rank,
                last_seen_at: now,
                is_active: true,
              },
            });

            // Create market_rankings snapshot
            await this.createMarketRankingSnapshot(
              existingAsset.asset_id,
              coin,
              rankTimestamp,
            );
            marketRankingsCount++;
            updatedCount++;
          } else {
            // Create new asset only if it doesn't exist
            // Double-check to prevent race conditions
            const duplicateCheck = await this.prisma.assets.findFirst({
              where: { symbol },
            });

            if (!duplicateCheck) {
              const newAsset = await this.prisma.assets.create({
                data: {
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
              });

              // Create initial market_rankings snapshot
              await this.createMarketRankingSnapshot(
                newAsset.asset_id,
                coin,
                rankTimestamp,
              );
              marketRankingsCount++;
              createdCount++;
            } else {
              // Asset was created between checks, update it instead
              await this.prisma.assets.update({
                where: { asset_id: duplicateCheck.asset_id },
                data: {
                  name: coin.name,
                  display_name: coin.name,
                  coingecko_id: coin.id,
                  logo_url: coin.image,
                  market_cap_rank: coin.market_cap_rank,
                  last_seen_at: now,
                  is_active: true,
                },
              });

              // Create market_rankings snapshot
              await this.createMarketRankingSnapshot(
                duplicateCheck.asset_id,
                coin,
                rankTimestamp,
              );
              marketRankingsCount++;
              updatedCount++;
            }
          }
        } catch (error: any) {
          // Handle duplicate key errors (in case unique constraint is added later)
          if (error.code === 'P2002' || error.message?.includes('Unique constraint')) {
            // Asset already exists, try to update it
            try {
              const existingAsset = await this.prisma.assets.findFirst({
                where: { symbol: coin.symbol.toUpperCase() },
              });
              if (existingAsset) {
                await this.prisma.assets.update({
                  where: { asset_id: existingAsset.asset_id },
                  data: {
                    name: coin.name,
                    display_name: coin.name,
                    coingecko_id: coin.id,
                    logo_url: coin.image,
                    market_cap_rank: coin.market_cap_rank,
                    last_seen_at: new Date(),
                    is_active: true,
                  },
                });
                updatedCount++;
              }
            } catch (updateError: any) {
              errorCount++;
              this.logger.error(
                `Error updating asset ${coin.symbol} after duplicate error: ${updateError.message}`,
              );
            }
          } else {
            errorCount++;
            this.logger.error(
              `Error syncing asset ${coin.symbol}: ${error.message}`,
            );
          }
          // Continue with next coin
        }
      }

      const duration = Date.now() - startTime;
      this.lastSyncTime = new Date();
      this.logger.log(
        `CoinGecko assets sync completed: ${createdCount} created, ${updatedCount} updated, ${marketRankingsCount} market snapshots, ${errorCount} errors, ${duration}ms`,
      );
    } catch (error: any) {
      this.logger.error(`Fatal error in CoinGecko assets sync: ${error.message}`);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Create or update market_rankings snapshot for an asset
   */
  private async createMarketRankingSnapshot(
    assetId: string,
    coin: any,
    rankTimestamp: Date,
  ): Promise<void> {
    try {
      await this.prisma.market_rankings.upsert({
        where: {
          rank_timestamp_asset_id: {
            rank_timestamp: rankTimestamp,
            asset_id: assetId,
          },
        },
        create: {
          rank_timestamp: rankTimestamp,
          asset_id: assetId,
          rank: coin.market_cap_rank,
          market_cap: coin.market_cap,
          price_usd: coin.current_price,
          volume_24h: coin.total_volume,
        },
        update: {
          rank: coin.market_cap_rank,
          market_cap: coin.market_cap,
          price_usd: coin.current_price,
          volume_24h: coin.total_volume,
        },
      });
    } catch (error: any) {
      this.logger.debug(
        `Could not create market_rankings for asset ${assetId}: ${error.message}`,
      );
    }
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
    const startTime = Date.now();
    let createdCount = 0;
    let updatedCount = 0;
    let errorCount = 0;
    let marketRankingsCount = 0;

    try {
      const coins = await this.marketService.getTop500Coins();
      this.logger.log(`Manually syncing ${coins.length} coins from CoinGecko`);
      const rankTimestamp = new Date();

      for (const coin of coins) {
        try {
          const symbol = coin.symbol.toUpperCase();
          const now = new Date();

          // Check if asset already exists
          const existingAsset = await this.prisma.assets.findFirst({
            where: { symbol },
          });

          if (existingAsset) {
            // Update existing asset with full metadata
            await this.prisma.assets.update({
              where: { asset_id: existingAsset.asset_id },
              data: {
                name: coin.name,
                display_name: coin.name,
                coingecko_id: coin.id,
                logo_url: coin.image,
                market_cap_rank: coin.market_cap_rank,
                last_seen_at: now,
                is_active: true,
              },
            });

            // Create market_rankings snapshot
            await this.createMarketRankingSnapshot(
              existingAsset.asset_id,
              coin,
              rankTimestamp,
            );
            marketRankingsCount++;
            updatedCount++;
          } else {
            // Create new asset only if it doesn't exist
            // Double-check to prevent race conditions
            const duplicateCheck = await this.prisma.assets.findFirst({
              where: { symbol },
            });

            if (!duplicateCheck) {
              const newAsset = await this.prisma.assets.create({
                data: {
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
              });

              // Create initial market_rankings snapshot
              await this.createMarketRankingSnapshot(
                newAsset.asset_id,
                coin,
                rankTimestamp,
              );
              marketRankingsCount++;
              createdCount++;
            } else {
              // Asset was created between checks, update it instead
              await this.prisma.assets.update({
                where: { asset_id: duplicateCheck.asset_id },
                data: {
                  name: coin.name,
                  display_name: coin.name,
                  coingecko_id: coin.id,
                  logo_url: coin.image,
                  market_cap_rank: coin.market_cap_rank,
                  last_seen_at: now,
                  is_active: true,
                },
              });

              // Create market_rankings snapshot
              await this.createMarketRankingSnapshot(
                duplicateCheck.asset_id,
                coin,
                rankTimestamp,
              );
              marketRankingsCount++;
              updatedCount++;
            }
          }
        } catch (error: any) {
          // Handle duplicate key errors (in case unique constraint is added later)
          if (error.code === 'P2002' || error.message?.includes('Unique constraint')) {
            // Asset already exists, try to update it
            try {
              const existingAsset = await this.prisma.assets.findFirst({
                where: { symbol: coin.symbol.toUpperCase() },
              });
              if (existingAsset) {
                await this.prisma.assets.update({
                  where: { asset_id: existingAsset.asset_id },
                  data: {
                    name: coin.name,
                    display_name: coin.name,
                    coingecko_id: coin.id,
                    logo_url: coin.image,
                    market_cap_rank: coin.market_cap_rank,
                    last_seen_at: new Date(),
                    is_active: true,
                  },
                });
                updatedCount++;
              }
            } catch (updateError: any) {
              errorCount++;
              this.logger.error(
                `Error updating asset ${coin.symbol} after duplicate error: ${updateError.message}`,
              );
            }
          } else {
            errorCount++;
            this.logger.error(`Error syncing asset ${coin.symbol}: ${error.message}`);
          }
        }
      }

      const duration = Date.now() - startTime;
      this.logger.log(
        `Manual sync completed: ${createdCount} created, ${updatedCount} updated, ${marketRankingsCount} market snapshots, ${errorCount} errors, ${duration}ms`,
      );

      return {
        created: createdCount,
        updated: updatedCount,
        errors: errorCount,
        total: coins.length,
        marketSnapshots: marketRankingsCount,
      };
    } catch (error: any) {
      this.logger.error(`Fatal error in manual sync: ${error.message}`);
      throw error;
    }
  }
}

