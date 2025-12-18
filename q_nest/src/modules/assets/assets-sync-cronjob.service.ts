import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { MarketService } from '../market/market.service';

@Injectable()
export class AssetsSyncCronjobService implements OnModuleInit {
  private readonly logger = new Logger(AssetsSyncCronjobService.name);

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
   * Sync top 500 coins from CoinGecko to assets table
   * Runs daily at 2:00 AM
   */
  @Cron('0 2 * * *') // Daily at 2:00 AM
  async syncAssetsFromCoinGecko(): Promise<void> {
    this.logger.log('Starting CoinGecko assets sync cronjob');
    const startTime = Date.now();
    let createdCount = 0;
    let updatedCount = 0;
    let errorCount = 0;

    try {
      // Fetch top 500 coins from CoinGecko
      this.logger.log('Fetching top 500 coins from CoinGecko...');
      const coins = await this.marketService.getTop500Coins();

      this.logger.log(`Fetched ${coins.length} coins from CoinGecko`);

      for (const coin of coins) {
        try {
          const symbol = coin.symbol.toUpperCase();
          const now = new Date();

          // Check if asset already exists
          const existingAsset = await this.prisma.assets.findFirst({
            where: { symbol },
          });

          if (existingAsset) {
            // Update existing asset (update last_seen_at and name if changed)
            await this.prisma.assets.update({
              where: { asset_id: existingAsset.asset_id },
              data: {
                name: coin.name,
                last_seen_at: now,
                is_active: true, // Reactivate if it was deactivated
              },
            });
            updatedCount++;
          } else {
            // Create new asset only if it doesn't exist
            // Double-check to prevent race conditions
            const duplicateCheck = await this.prisma.assets.findFirst({
              where: { symbol },
            });

            if (!duplicateCheck) {
              await this.prisma.assets.create({
                data: {
                  symbol,
                  name: coin.name,
                  asset_type: 'crypto',
                  is_active: true,
                  first_seen_at: now,
                  last_seen_at: now,
                },
              });
              createdCount++;
            } else {
              // Asset was created between checks, update it instead
              await this.prisma.assets.update({
                where: { asset_id: duplicateCheck.asset_id },
                data: {
                  name: coin.name,
                  last_seen_at: now,
                  is_active: true,
                },
              });
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
      this.logger.log(
        `CoinGecko assets sync completed: ${createdCount} created, ${updatedCount} updated, ${errorCount} errors, ${duration}ms`,
      );
    } catch (error: any) {
      this.logger.error(`Fatal error in CoinGecko assets sync: ${error.message}`);
    }
  }

  /**
   * Manual sync method (can be called via API endpoint)
   */
  async manualSync(): Promise<{ created: number; updated: number; errors: number; total: number }> {
    const startTime = Date.now();
    let createdCount = 0;
    let updatedCount = 0;
    let errorCount = 0;

    try {
      const coins = await this.marketService.getTop500Coins();
      this.logger.log(`Manually syncing ${coins.length} coins from CoinGecko`);

      for (const coin of coins) {
        try {
          const symbol = coin.symbol.toUpperCase();
          const now = new Date();

          // Check if asset already exists
          const existingAsset = await this.prisma.assets.findFirst({
            where: { symbol },
          });

          if (existingAsset) {
            // Update existing asset
            await this.prisma.assets.update({
              where: { asset_id: existingAsset.asset_id },
              data: {
                name: coin.name,
                last_seen_at: now,
                is_active: true,
              },
            });
            updatedCount++;
          } else {
            // Create new asset only if it doesn't exist
            // Double-check to prevent race conditions
            const duplicateCheck = await this.prisma.assets.findFirst({
              where: { symbol },
            });

            if (!duplicateCheck) {
              await this.prisma.assets.create({
                data: {
                  symbol,
                  name: coin.name,
                  asset_type: 'crypto',
                  is_active: true,
                  first_seen_at: now,
                  last_seen_at: now,
                },
              });
              createdCount++;
            } else {
              // Asset was created between checks, update it instead
              await this.prisma.assets.update({
                where: { asset_id: duplicateCheck.asset_id },
                data: {
                  name: coin.name,
                  last_seen_at: now,
                  is_active: true,
                },
              });
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
        `Manual sync completed: ${createdCount} created, ${updatedCount} updated, ${errorCount} errors, ${duration}ms`,
      );

      return {
        created: createdCount,
        updated: updatedCount,
        errors: errorCount,
        total: coins.length,
      };
    } catch (error: any) {
      this.logger.error(`Fatal error in manual sync: ${error.message}`);
      throw error;
    }
  }
}

