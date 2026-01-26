import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import axios, { AxiosInstance } from 'axios';

export interface CoinGeckoCoin {
  id: string;
  symbol: string;
  name: string;
  image: string;
  current_price: number;
  market_cap: number;
  market_cap_rank: number;
  fully_diluted_valuation: number | null;
  total_volume: number;
  high_24h: number;
  low_24h: number;
  price_change_24h: number;
  price_change_percentage_24h: number;
  market_cap_change_24h: number;
  market_cap_change_percentage_24h: number;
  circulating_supply: number;
  total_supply: number | null;
  max_supply: number | null;
  ath: number;
  ath_change_percentage: number;
  ath_date: string;
  atl: number;
  atl_change_percentage: number;
  atl_date: string;
  last_updated: string;
}

@Injectable()
export class MarketService {
  private readonly logger = new Logger(MarketService.name);
  private readonly apiClient: AxiosInstance;
  private readonly apiKey: string | null;
  private readonly baseUrl: string;

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {
    this.apiKey = this.configService.get<string>('COINGECKO_API_KEY') || null;
    
    // Determine base URL based on API key type
    const isProApiKey = this.apiKey && this.apiKey.startsWith('CG-');
    this.baseUrl = isProApiKey
      ? 'https://pro-api.coingecko.com/api/v3'
      : 'https://api.coingecko.com/api/v3';

    this.apiClient = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        ...(isProApiKey && this.apiKey
          ? { 'x-cg-pro-api-key': this.apiKey }
          : {}),
      },
    });

    this.logger.log(
      `CoinGecko API initialized: ${isProApiKey ? 'Pro API' : 'Free API'}`,
    );
  }

  /**
   * Fetch top N cryptocurrencies by market cap
   */
  async getTopCoins(limit: number = 5): Promise<CoinGeckoCoin[]> {
    try {
      const response = await this.apiClient.get<CoinGeckoCoin[]>(
        '/coins/markets',
        {
          params: {
            vs_currency: 'usd',
            order: 'market_cap_desc',
            per_page: limit,
            page: 1,
            sparkline: false,
            price_change_percentage: '24h',
          },
        },
      );

      return response.data;
    } catch (error: any) {
      this.logger.error('Failed to fetch top coins from CoinGecko', {
        message: error?.message,
        status: error?.response?.status,
        data: error?.response?.data,
      });

      if (error?.response?.status === 429) {
        throw new Error('CoinGecko API rate limit exceeded. Please try again later.');
      }

      if (error?.response?.status === 401) {
        throw new Error('CoinGecko API key is invalid or expired.');
      }

      throw new Error(
        `Failed to fetch top coins: ${error?.message || 'Unknown error'}`,
      );
    }
  }

  /**
   * Fetch top 500 cryptocurrencies by market cap
   */
  async getTop500Coins(): Promise<CoinGeckoCoin[]> {
    try {
      const response = await this.apiClient.get<CoinGeckoCoin[]>(
        '/coins/markets',
        {
          params: {
            vs_currency: 'usd',
            order: 'market_cap_desc',
            per_page: 500,
            page: 1,
            sparkline: false,
            price_change_percentage: '24h',
          },
        },
      );

      return response.data;
    } catch (error: any) {
      this.logger.error('Failed to fetch top 500 coins from CoinGecko', {
        message: error?.message,
        status: error?.response?.status,
        data: error?.response?.data,
      });

      if (error?.response?.status === 429) {
        throw new Error('CoinGecko API rate limit exceeded. Please try again later.');
      }

      if (error?.response?.status === 401) {
        throw new Error('CoinGecko API key is invalid or expired.');
      }

      throw new Error(
        `Failed to fetch top 500 coins: ${error?.message || 'Unknown error'}`,
      );
    }
  }

  /**
   * Search for a coin by symbol and return its ID
   */
  async searchCoinBySymbol(symbol: string): Promise<string | null> {
    try {
      const response = await this.apiClient.get<{
        coins: Array<{ id: string; name: string; symbol: string }>;
      }>('/search', {
        params: {
          query: symbol,
        },
      });

      const coins = response.data.coins || [];

      if (coins.length === 0) {
        return null;
      }

      // First, try exact symbol match (case-insensitive)
      const symbolMatch = coins.find(
        (c) => c.symbol?.toLowerCase() === symbol.toLowerCase(),
      );

      if (symbolMatch) {
        return symbolMatch.id;
      }

      // If no exact symbol match, try to find by name or ID
      const nameOrIdMatch = coins.find(
        (c) =>
          c.name?.toLowerCase() === symbol.toLowerCase() ||
          c.id?.toLowerCase() === symbol.toLowerCase(),
      );

      if (nameOrIdMatch) {
        return nameOrIdMatch.id;
      }

      // If still no match, return the first result (best match from search)
      return coins[0]?.id || null;
    } catch (error: any) {
      this.logger.error('Failed to search coin by symbol', {
        symbol,
        message: error?.message,
        status: error?.response?.status,
      });
      return null;
    }
  }

  /**
   * Fetch detailed information about a specific coin
   * Accepts either coin ID (e.g., "bitcoin") or symbol (e.g., "BTC")
   */
  async getCoinDetails(coinIdOrSymbol: string): Promise<any> {
    try {
      let coinId = coinIdOrSymbol.toLowerCase();

      // Always try to search by symbol first if it looks like a symbol
      // Symbols are typically 2-5 characters and uppercase
      const isLikelySymbol =
        coinIdOrSymbol.length >= 2 &&
        coinIdOrSymbol.length <= 5 &&
        coinIdOrSymbol === coinIdOrSymbol.toUpperCase();

      if (isLikelySymbol) {
        const foundId = await this.searchCoinBySymbol(coinIdOrSymbol);
        if (foundId) {
          coinId = foundId;
        }
      }

      const response = await this.apiClient.get(`/coins/${coinId}`, {
        params: {
          localization: false,
          tickers: false,
          market_data: true,
          community_data: true,
          developer_data: true,
          sparkline: false,
        },
      });

      return response.data;
    } catch (error: any) {
      this.logger.error('Failed to fetch coin details from CoinGecko', {
        coinIdOrSymbol,
        message: error?.message,
        status: error?.response?.status,
        data: error?.response?.data,
      });

      if (error?.response?.status === 404) {
        throw new Error(
          `Coin "${coinIdOrSymbol}" not found. Please check if the symbol is correct.`,
        );
      }

      if (error?.response?.status === 429) {
        throw new Error('CoinGecko API rate limit exceeded. Please try again later.');
      }

      if (error?.response?.status === 401) {
        throw new Error('CoinGecko API key is invalid or expired.');
      }

      throw new Error(
        `Failed to fetch coin details: ${error?.message || 'Unknown error'}`,
      );
    }
  }

  /**
   * Fetch coins from database (cached data from cron job)
   * Much faster than CoinGecko API calls
   */
  async getCachedMarketData(
    limit: number = 500,
    search?: string,
  ): Promise<{ coins: CoinGeckoCoin[]; lastSyncTime: Date | null }> {
    try {
      // Get latest market_rankings timestamp
      const latestRanking = await this.prisma.market_rankings.findFirst({
        orderBy: { rank_timestamp: 'desc' },
        select: { rank_timestamp: true },
      });

      if (!latestRanking) {
        this.logger.warn('No market rankings found in database - waiting for first sync');
        return { coins: [], lastSyncTime: null };
      }

      this.logger.log(`Fetching cached market data from timestamp: ${latestRanking.rank_timestamp}`);

      // Build search filter
      const searchFilter = search
        ? {
            OR: [
              { symbol: { contains: search, mode: 'insensitive' as any } },
              { name: { contains: search, mode: 'insensitive' as any } },
            ],
          }
        : {};

      // Fetch assets with latest market rankings
      const assets = await this.prisma.assets.findMany({
        where: {
          asset_type: 'crypto',
          is_active: true,
          ...searchFilter,
        },
        include: {
          market_rankings: {
            where: {
              rank_timestamp: latestRanking.rank_timestamp,
            },
            orderBy: {
              rank_timestamp: 'desc',
            },
            take: 1,
          },
        },
        orderBy: {
          market_cap_rank: 'asc',
        },
        take: limit,
      });

      this.logger.log(`Found ${assets.length} assets with market rankings`);

      // Transform to CoinGeckoCoin format
      const coins: CoinGeckoCoin[] = assets
        .filter((asset) => asset.market_rankings.length > 0)
        .map((asset) => {
          const ranking = asset.market_rankings[0];
          const currentPrice = Number(ranking.price_usd || 0);
          const marketCap = Number(ranking.market_cap || 0);
          const volume = Number(ranking.volume_24h || 0);
          const change24h = Number(ranking.change_24h || 0);
          const changePercent24h = Number(ranking.change_percent_24h || 0);

          return {
            id: asset.coingecko_id || asset.asset_id,
            symbol: asset.symbol?.toUpperCase() || '',
            name: asset.display_name || asset.name || '',
            image: asset.logo_url || '',
            current_price: currentPrice,
            market_cap: marketCap,
            market_cap_rank: asset.market_cap_rank || ranking.rank,
            fully_diluted_valuation: null,
            total_volume: volume,
            high_24h: currentPrice * 1.02,
            low_24h: currentPrice * 0.98,
            price_change_24h: change24h,
            price_change_percentage_24h: changePercent24h,
            market_cap_change_24h: 0,
            market_cap_change_percentage_24h: 0,
            circulating_supply: 0,
            total_supply: null,
            max_supply: null,
            ath: currentPrice,
            ath_change_percentage: 0,
            ath_date: new Date().toISOString(),
            atl: currentPrice,
            atl_change_percentage: 0,
            atl_date: new Date().toISOString(),
            last_updated: ranking.rank_timestamp.toISOString(),
          };
        });

      this.logger.log(`Returning ${coins.length} coins with 24h price changes from database`);

      return {
        coins,
        lastSyncTime: latestRanking.rank_timestamp,
      };
    } catch (error: any) {
      this.logger.error('Failed to fetch cached market data from database', {
        message: error?.message,
        stack: error?.stack,
      });
      throw new Error(
        `Failed to fetch cached market data: ${error?.message || 'Unknown error'}`,
      );
    }
  }
}

