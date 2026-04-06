import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { MarketService } from '../market/market.service';
import axios from 'axios';

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
    // Sync assets on startup so market data is available immediately
    // Runs in background to not block server startup
    this.syncAssetsFromCoinGecko().catch((err) =>
      this.logger.error(`Startup sync failed: ${err.message}`),
    );
  }

  /**
   * Sync top 500 coins from CoinGecko to assets and market_rankings tables
   * Also fetches exchange availability from Binance/Bybit/Binance US direct APIs (free)
   * Runs every 15 minutes
   */
  @Cron('*/15 * * * *')
  async syncAssetsFromCoinGecko(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    try {
      // Step 1: Fetch exchange coin lists from direct APIs (free, 1 call each)
      const exchangeMap = await this.fetchExchangeAvailability();

      // Step 2: Fetch top 500 coins from CoinGecko (1 API call)
      const coins = await this.marketService.getTop500Coins();

      // Step 3: Sync to DB with exchange availability
      const result = await this.syncCoins(coins, exchangeMap);
      this.logger.log(`CoinGecko sync complete: created=${result.created}, updated=${result.updated}, errors=${result.errors}, rankings=${result.marketSnapshots}`);
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
  private async fetchExchangeAvailability(): Promise<Map<string, string[]>> {
    const symbolToExchanges = new Map<string, string[]>();

    const results = await Promise.allSettled([
      this.fetchBinanceUsdtSymbols(),
      this.fetchBybitUsdtSymbols(),
      this.fetchBinanceUSSymbols(),
    ]);

    const exchangeNames = ['binance', 'bybit', 'binance.us'];

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const exchangeName = exchangeNames[i];

      if (result.status === 'fulfilled') {
        this.logger.log(`${exchangeName}: ${result.value.length} USDT symbols fetched`);
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

    this.logger.log(`Exchange availability map built for ${symbolToExchanges.size} symbols`);
    return symbolToExchanges;
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
  ): Promise<{ created: number; updated: number; errors: number; total: number; marketSnapshots: number }> {
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

      try {
        const assetUpserts = batch.map((coin) => {
          const symbol = coin.symbol.toUpperCase();
          // Look up exchange availability by symbol
          const exchanges = exchangeMap.get(symbol) || [];
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
            select: { asset_id: true },
          });
        });

        const results = await this.prisma.$transaction(assetUpserts);
        upsertedCount += results.length;

        // Batch upsert market_rankings
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
   * Manual sync method (can be called via API endpoint)
   */
  async manualSync(): Promise<{ created: number; updated: number; errors: number; total: number; marketSnapshots: number }> {
    const exchangeMap = await this.fetchExchangeAvailability();
    const coins = await this.marketService.getTop500Coins();
    return this.syncCoins(coins, exchangeMap);
  }
}
