import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { MarketService } from '../market/market.service';
import axios from 'axios';

@Injectable()
export class AssetsSyncCronjobService {
  private readonly logger = new Logger(AssetsSyncCronjobService.name);
  private lastSyncTime: Date | null = null;
  private isRunning = false;

  constructor(
    private prisma: PrismaService,
    private marketService: MarketService,
  ) {}

  /**
   * Sync top 500 coins from CoinGecko to assets and market_rankings tables.
   * Also fetches exchange availability from Binance/Bybit/Binance US direct APIs (free).
   * Runs every 30 minutes — top-500 market-cap rankings move slowly enough
   * that 15-min cadence was wasted CoinGecko calls.
   */
  @Cron('*/30 * * * *')
  async syncAssetsFromCoinGecko(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    try {
      // Step 1: Fetch exchange coin lists from direct APIs (free, 1 call each)
      const { symbolToExchanges, succeededExchanges } = await this.fetchExchangeAvailability();

      // Step 2: Fetch top 500 coins from CoinGecko (Pro first, free fallback with pagination)
      const coins = await this.marketService.getTop500Coins();

      // Step 3: Sync to DB with exchange availability
      const result = await this.syncCoins(coins, symbolToExchanges, succeededExchanges);
      this.logger.log(`CoinGecko sync complete: created=${result.created}, updated=${result.updated}, errors=${result.errors}, rankings=${result.marketSnapshots}`);

      // Step 4: Clean up duplicate/old market_rankings rows (keep only the latest per asset)
      await this.cleanupOldRankings();
      this.lastSyncTime = new Date();
    } catch (error: any) {
      this.logger.error(`Fatal error in CoinGecko assets sync: ${error.message}`);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Fetch USDT trading pair symbols from Binance, Bybit, and Binance US direct APIs.
   * Returns a Map of uppercase symbol -> list of exchanges it's available on.
   * Uses direct exchange APIs (free, no CoinGecko credits).
   */
  private async fetchExchangeAvailability(): Promise<{ symbolToExchanges: Map<string, string[]>; succeededExchanges: string[] }> {
    const symbolToExchanges = new Map<string, string[]>();

    const results = await Promise.allSettled([
      this.fetchBinanceUsdtSymbols(),
      this.fetchBybitUsdtSymbols(),
      this.fetchBinanceUSSymbols(),
    ]);

    const exchangeNames = ['binance', 'bybit', 'binance.us'];
    const succeededExchanges: string[] = [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const exchangeName = exchangeNames[i];

      if (result.status === 'fulfilled') {
        this.logger.log(`${exchangeName}: ${result.value.length} USDT symbols fetched`);
        succeededExchanges.push(exchangeName);
        for (const symbol of result.value) {
          const upper = symbol.toUpperCase();
          const existing = symbolToExchanges.get(upper) || [];
          existing.push(exchangeName);
          symbolToExchanges.set(upper, existing);
        }
      } else {
        this.logger.warn(`Failed to fetch ${exchangeName} symbols: ${result.reason}`);
      }
    }

    this.logger.log(`Exchange availability map built for ${symbolToExchanges.size} symbols (succeeded: ${succeededExchanges.join(', ')})`);
    return { symbolToExchanges, succeededExchanges };
  }

  /**
   * Fetch all USDT pair base symbols from Binance.
   * GET https://api.binance.com/api/v3/exchangeInfo — 1 free call, returns all pairs.
   */
  private async fetchBinanceUsdtSymbols(): Promise<string[]> {
    const response = await axios.get('https://api.binance.com/api/v3/exchangeInfo', {
      timeout: 15000,
    });

    const symbols = new Set<string>();
    for (const s of response.data.symbols || []) {
      if (s.quoteAsset === 'USDT' && s.status === 'TRADING') {
        symbols.add(s.baseAsset.toUpperCase());
      }
    }
    return Array.from(symbols);
  }

  /**
   * Fetch all USDT pair base symbols from Bybit.
   * GET https://api.bybit.com/v5/market/instruments-info?category=spot — 1 free call.
   */
  private async fetchBybitUsdtSymbols(): Promise<string[]> {
    const response = await axios.get('https://api.bybit.com/v5/market/instruments-info', {
      params: { category: 'spot' },
      timeout: 15000,
    });

    const symbols = new Set<string>();
    const list = response.data?.result?.list || [];
    for (const item of list) {
      if (item.quoteCoin === 'USDT' && item.status === 'Trading') {
        symbols.add(item.baseCoin.toUpperCase());
      }
    }
    return Array.from(symbols);
  }

  /**
   * Fetch all USD/USDT pair base symbols from Binance US.
   * GET https://api.binance.us/api/v3/exchangeInfo — 1 free call.
   */
  private async fetchBinanceUSSymbols(): Promise<string[]> {
    const response = await axios.get('https://api.binance.us/api/v3/exchangeInfo', {
      timeout: 15000,
    });

    const symbols = new Set<string>();
    for (const s of response.data.symbols || []) {
      if ((s.quoteAsset === 'USDT' || s.quoteAsset === 'USD') && s.status === 'TRADING') {
        symbols.add(s.baseAsset.toUpperCase());
      }
    }
    return Array.from(symbols);
  }

  /**
   * Shared sync logic used by both scheduled and manual sync.
   * Processes coins in batched upserts instead of sequential queries.
   */
  private async syncCoins(
    coins: any[],
    exchangeMap: Map<string, string[]>,
    succeededExchanges: string[],
  ): Promise<{ created: number; updated: number; errors: number; total: number; marketSnapshots: number }> {
    const BATCH_SIZE = 50;
    let upsertedCount = 0;
    let errorCount = 0;
    let marketRankingsCount = 0;
    const now = new Date();

    // Pre-fetch existing assets so we can merge exchange tags
    const existingAssets = await this.prisma.assets.findMany({
      where: { asset_type: 'crypto' },
      select: { symbol: true, available_exchanges: true },
    });
    const existingTagsMap = new Map<string, string[]>();
    for (const asset of existingAssets) {
      existingTagsMap.set(asset.symbol, Array.isArray(asset.available_exchanges) ? asset.available_exchanges as string[] : []);
    }

    for (let i = 0; i < coins.length; i += BATCH_SIZE) {
      const batch = coins.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(coins.length / BATCH_SIZE);

      try {
        const assetUpserts = batch.map((coin) => {
          const symbol = coin.symbol.toUpperCase();
          const freshTags = exchangeMap.get(symbol) || [];
          // Merge: keep old tags for exchanges that failed, use fresh data for exchanges that succeeded
          const oldTags = existingTagsMap.get(symbol) || [];
          const merged = [
            ...oldTags.filter((tag) => !succeededExchanges.includes(tag)),
            ...freshTags,
          ];
          const exchanges = [...new Set(merged)];

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
              available_exchanges: exchanges,
            },
            update: {
              name: coin.name,
              display_name: coin.name,
              coingecko_id: coin.id,
              logo_url: coin.image,
              market_cap_rank: coin.market_cap_rank,
              last_seen_at: now,
              is_active: true,
              available_exchanges: exchanges,
            },
            select: { asset_id: true, symbol: true },
          });
        });

        const results = await this.prisma.$transaction(assetUpserts);
        upsertedCount += results.length;

        // Update market_rankings: find latest row per asset and update it, or create if none exists
        for (let idx = 0; idx < results.length; idx++) {
          const asset = results[idx];
          const coin = batch[idx];
          try {
            const existing = await this.prisma.market_rankings.findFirst({
              where: { asset_id: asset.asset_id },
              orderBy: { rank_timestamp: 'desc' },
              select: { rank_timestamp: true, asset_id: true },
            });

            if (existing) {
              await this.prisma.market_rankings.update({
                where: {
                  rank_timestamp_asset_id: {
                    rank_timestamp: existing.rank_timestamp,
                    asset_id: existing.asset_id,
                  },
                },
                data: {
                  rank: coin.market_cap_rank,
                  market_cap: coin.market_cap,
                  price_usd: coin.current_price,
                  volume_24h: coin.total_volume,
                  change_percent_24h: coin.price_change_percentage_24h || 0,
                  change_24h: coin.price_change_24h || 0,
                  rank_timestamp: now,
                },
              });
            } else {
              await this.prisma.market_rankings.create({
                data: {
                  rank_timestamp: now,
                  asset_id: asset.asset_id,
                  rank: coin.market_cap_rank,
                  market_cap: coin.market_cap,
                  price_usd: coin.current_price,
                  volume_24h: coin.total_volume,
                  change_percent_24h: coin.price_change_percentage_24h || 0,
                  change_24h: coin.price_change_24h || 0,
                },
              });
            }
            marketRankingsCount++;
          } catch (error: any) {
            this.logger.warn(`Failed to update ranking for ${asset.symbol}: ${error.message}`);
          }
        }

        this.logger.log(`Batch ${batchNum}/${totalBatches}: upserted ${results.length} assets + ${marketRankingsCount} rankings`);
      } catch (error: any) {
        this.logger.error(`Batch ${batchNum}/${totalBatches} failed: ${error.message}`);
        errorCount += batch.length;
      }
    }

    return {
      created: 0,
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
   * Remove duplicate market_rankings rows, keeping only the latest per asset.
   */
  private async cleanupOldRankings(): Promise<void> {
    try {
      const result = await this.prisma.$executeRawUnsafe(`
        DELETE FROM market_rankings
        WHERE ctid NOT IN (
          SELECT DISTINCT ON (asset_id) ctid
          FROM market_rankings
          ORDER BY asset_id, rank_timestamp DESC
        )
      `);
      this.logger.log(`Cleaned up ${result} old market_rankings rows`);
    } catch (error: any) {
      this.logger.warn(`Failed to cleanup old rankings: ${error.message}`);
    }
  }

  /**
   * Manual sync method (can be called via API endpoint)
   */
  async manualSync(): Promise<{ created: number; updated: number; errors: number; total: number; marketSnapshots: number }> {
    const { symbolToExchanges, succeededExchanges } = await this.fetchExchangeAvailability();
    const coins = await this.marketService.getTop500Coins();
    return this.syncCoins(coins, symbolToExchanges, succeededExchanges);
  }
}
