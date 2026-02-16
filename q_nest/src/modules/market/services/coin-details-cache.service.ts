import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import axios, { AxiosInstance } from 'axios';
import { ConfigService } from '@nestjs/config';

export interface CoinDetailResponse {
  id: string;
  symbol: string;
  name: string;
  description?: {
    en?: string;
  };
  links?: {
    homepage?: string[];
  };
  image?: {
    large?: string;
  };
  market_cap_rank?: number;
  market_data?: {
    current_price?: { usd?: number };
    market_cap?: { usd?: number };
    fully_diluted_valuation?: { usd?: number };
    total_volume?: { usd?: number };
    circulating_supply?: number;
    total_supply?: number;
    max_supply?: number;
    ath?: { usd?: number };
    ath_date?: { usd?: string };
    atl?: { usd?: number };
    atl_date?: { usd?: string };
    price_change_24h?: number;
    price_change_percentage_24h?: number;
    price_change_percentage_1h_in_currency?: { usd?: number };
    price_change_percentage_24h_in_currency?: { usd?: number };
    price_change_percentage_7d_in_currency?: { usd?: number };
    price_change_percentage_30d_in_currency?: { usd?: number };
    price_change_percentage_1y_in_currency?: { usd?: number };
  };
}

@Injectable()
export class CoinDetailsCacheService {
  private readonly logger = new Logger(CoinDetailsCacheService.name);
  private readonly apiClient: AxiosInstance;
  private readonly apiKey: string | null;
  private readonly STALE_THRESHOLD = 6 * 60 * 60 * 1000; // 6 hours

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {
    this.apiKey = this.configService.get<string>('COINGECKO_API_KEY') || null;
    
    const isProApiKey = this.apiKey && this.apiKey.startsWith('CG-');
    const baseUrl = isProApiKey
      ? 'https://pro-api.coingecko.com/api/v3'
      : 'https://api.coingecko.com/api/v3';

    this.apiClient = axios.create({
      baseURL: baseUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        ...(isProApiKey && this.apiKey
          ? { 'x-cg-pro-api-key': this.apiKey }
          : {}),
      },
    });
  }

  /**
   * Get coin details from database cache
   * Returns null if not found or stale
   */
  async getCoinDetailsFromDB(
    coinIdOrSymbol: string,
  ): Promise<any | null> {
    try {
      const normalizedInput = coinIdOrSymbol.toLowerCase();
      
      // Try to find by coingecko_id first, then by symbol
      const coinDetail = await this.prisma.coin_details.findFirst({
        where: {
          OR: [
            { coingecko_id: normalizedInput },
            { symbol: normalizedInput },
          ],
        },
        orderBy: {
          last_updated: 'desc',
        },
      });

      if (!coinDetail) {
        this.logger.debug(`Coin "${coinIdOrSymbol}" not found in database`);
        return null;
      }

      // Check if data is stale
      const age = Date.now() - coinDetail.last_updated.getTime();
      if (age > this.STALE_THRESHOLD) {
        this.logger.debug(`Coin "${coinIdOrSymbol}" data is stale (${Math.round(age / 1000 / 60)} minutes old)`);
        return null;
      }

      this.logger.log(`Returning cached coin details for "${coinIdOrSymbol}" from database`);
      
      // Transform to CoinGecko API format
      return this.transformDBToAPIFormat(coinDetail);
    } catch (error: any) {
      this.logger.error('Failed to fetch coin details from database', {
        coinIdOrSymbol,
        error: error.message,
      });
      return null;
    }
  }

  /**
   * Fetch coin details from CoinGecko API and save to database
   */
  async syncCoinDetails(coinId: string): Promise<any> {
    try {
      this.logger.log(`Fetching coin details from CoinGecko API: ${coinId}`);
      
      // Fetch detailed coin info
      const detailsResponse = await this.apiClient.get<CoinDetailResponse>(
        `/coins/${coinId}`,
        {
          params: {
            localization: false,
            tickers: false,
            market_data: true,
            community_data: true,
            developer_data: true,
            sparkline: false,
          },
        },
      );

      // Also fetch market data which includes all price change percentages
      let marketData = null;
      try {
        const marketResponse = await this.apiClient.get('/coins/markets', {
          params: {
            vs_currency: 'usd',
            ids: coinId,
            order: 'market_cap_desc',
            per_page: 1,
            page: 1,
            sparkline: false,
            price_change_percentage: '1h,24h,7d,30d,1y',
          },
        });
        marketData = marketResponse.data?.[0];
      } catch (error) {
        this.logger.warn(`Failed to fetch market data for ${coinId}, continuing with details only`);
      }

      // Merge data
      const data = detailsResponse.data;
      if (marketData && data.market_data) {
        // Map the market endpoint fields to the detail endpoint format
        data.market_data.price_change_percentage_1h_in_currency = { 
          usd: marketData.price_change_percentage_1h_in_currency || null 
        };
        data.market_data.price_change_percentage_24h_in_currency = { 
          usd: marketData.price_change_percentage_24h_in_currency || marketData.price_change_percentage_24h || null 
        };
        data.market_data.price_change_percentage_7d_in_currency = { 
          usd: marketData.price_change_percentage_7d_in_currency || null 
        };
        data.market_data.price_change_percentage_30d_in_currency = { 
          usd: marketData.price_change_percentage_30d_in_currency || null 
        };
        data.market_data.price_change_percentage_1y_in_currency = { 
          usd: marketData.price_change_percentage_1y_in_currency || null 
        };
      }
      
      // Save to database
      await this.saveCoinDetailsToDatabase(data);
      
      return data;
    } catch (error: any) {
      this.logger.error('Failed to sync coin details from CoinGecko', {
        coinId,
        error: error.message,
        status: error?.response?.status,
      });
      throw error;
    }
  }

  /**
   * Save coin details to database (upsert)
   */
  async saveCoinDetailsToDatabase(data: CoinDetailResponse): Promise<void> {
    try {
      const description = data.description?.en || '';
      const homepageUrl = data.links?.homepage?.[0] || '';
      const imageUrl = data.image?.large || '';
      
      await this.prisma.coin_details.upsert({
        where: {
          coingecko_id: data.id,
        },
        update: {
          symbol: data.symbol?.toLowerCase() || '',
          name: data.name || '',
          description: description,
          homepage_url: homepageUrl,
          image_url: imageUrl,
          market_cap_rank: data.market_cap_rank || null,
          market_cap_usd: data.market_data?.market_cap?.usd || null,
          fully_diluted_valuation_usd: data.market_data?.fully_diluted_valuation?.usd || null,
          circulating_supply: data.market_data?.circulating_supply || null,
          total_supply: data.market_data?.total_supply || null,
          max_supply: data.market_data?.max_supply || null,
          ath_usd: data.market_data?.ath?.usd || null,
          ath_date: data.market_data?.ath_date?.usd ? new Date(data.market_data.ath_date.usd) : null,
          atl_usd: data.market_data?.atl?.usd || null,
          atl_date: data.market_data?.atl_date?.usd ? new Date(data.market_data.atl_date.usd) : null,
          total_volume_24h: data.market_data?.total_volume?.usd || null,
          current_price_usd: data.market_data?.current_price?.usd || null,
          price_change_24h: data.market_data?.price_change_24h || null,
          price_change_percentage_24h: data.market_data?.price_change_percentage_24h || null,
          last_updated: new Date(),
        },
        create: {
          coingecko_id: data.id,
          symbol: data.symbol?.toLowerCase() || '',
          name: data.name || '',
          description: description,
          homepage_url: homepageUrl,
          image_url: imageUrl,
          market_cap_rank: data.market_cap_rank || null,
          market_cap_usd: data.market_data?.market_cap?.usd || null,
          fully_diluted_valuation_usd: data.market_data?.fully_diluted_valuation?.usd || null,
          circulating_supply: data.market_data?.circulating_supply || null,
          total_supply: data.market_data?.total_supply || null,
          max_supply: data.market_data?.max_supply || null,
          ath_usd: data.market_data?.ath?.usd || null,
          ath_date: data.market_data?.ath_date?.usd ? new Date(data.market_data.ath_date.usd) : null,
          atl_usd: data.market_data?.atl?.usd || null,
          atl_date: data.market_data?.atl_date?.usd ? new Date(data.market_data.atl_date.usd) : null,
          total_volume_24h: data.market_data?.total_volume?.usd || null,
          current_price_usd: data.market_data?.current_price?.usd || null,
          price_change_24h: data.market_data?.price_change_24h || null,
          price_change_percentage_24h: data.market_data?.price_change_percentage_24h || null,
        },
      });

      this.logger.log(`Saved coin details to database: ${data.id}`);
    } catch (error: any) {
      this.logger.error('Failed to save coin details to database', {
        coinId: data.id,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Sync top N coins by market cap
   */
  async syncTopCoins(limit: number = 200): Promise<{ success: number; failed: number }> {
    try {
      this.logger.log(`Starting sync of top ${limit} coins...`);
      
      // Get list of top coins
      const response = await this.apiClient.get('/coins/markets', {
        params: {
          vs_currency: 'usd',
          order: 'market_cap_desc',
          per_page: Math.min(limit, 250),
          page: 1,
          sparkline: false,
        },
      });

      const coins = response.data;
      let success = 0;
      let failed = 0;

      // Sync each coin with delay to avoid rate limits
      for (const coin of coins) {
        try {
          await this.syncCoinDetails(coin.id);
          success++;
          
          // Reduced delay between requests (200ms instead of 500ms)
          await new Promise(resolve => setTimeout(resolve, 200));
        } catch (error) {
          failed++;
          this.logger.warn(`Failed to sync coin: ${coin.id}`);
        }
      }

      this.logger.log(`Coin sync completed: ${success} success, ${failed} failed`);
      return { success, failed };
    } catch (error: any) {
      this.logger.error('Failed to sync top coins', {
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Refresh stale coins (older than 6 hours)
   */
  async refreshStaleCoins(maxCoins: number = 50): Promise<{ success: number; failed: number }> {
    try {
      const sixHoursAgo = new Date(Date.now() - this.STALE_THRESHOLD);
      
      const staleCoins = await this.prisma.coin_details.findMany({
        where: {
          last_updated: {
            lt: sixHoursAgo,
          },
        },
        orderBy: {
          market_cap_rank: 'asc',
        },
        take: maxCoins,
      });

      this.logger.log(`Found ${staleCoins.length} stale coins to refresh`);

      let success = 0;
      let failed = 0;

      for (const coin of staleCoins) {
        try {
          await this.syncCoinDetails(coin.coingecko_id);
          success++;
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
          failed++;
        }
      }

      this.logger.log(`Stale coin refresh completed: ${success} success, ${failed} failed`);
      return { success, failed };
    } catch (error: any) {
      this.logger.error('Failed to refresh stale coins', {
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Transform database record to CoinGecko API format
   */
  private transformDBToAPIFormat(coinDetail: any): any {
    return {
      id: coinDetail.coingecko_id,
      symbol: coinDetail.symbol,
      name: coinDetail.name,
      description: {
        en: coinDetail.description || '',
      },
      links: {
        homepage: coinDetail.homepage_url ? [coinDetail.homepage_url] : [],
      },
      image: {
        large: coinDetail.image_url || '',
      },
      market_cap_rank: coinDetail.market_cap_rank,
      market_data: {
        current_price: {
          usd: coinDetail.current_price_usd ? Number(coinDetail.current_price_usd) : 0,
        },
        market_cap: {
          usd: coinDetail.market_cap_usd ? Number(coinDetail.market_cap_usd) : 0,
        },
        fully_diluted_valuation: {
          usd: coinDetail.fully_diluted_valuation_usd ? Number(coinDetail.fully_diluted_valuation_usd) : null,
        },
        total_volume: {
          usd: coinDetail.total_volume_24h ? Number(coinDetail.total_volume_24h) : 0,
        },
        circulating_supply: coinDetail.circulating_supply ? Number(coinDetail.circulating_supply) : 0,
        total_supply: coinDetail.total_supply ? Number(coinDetail.total_supply) : null,
        max_supply: coinDetail.max_supply ? Number(coinDetail.max_supply) : null,
        ath: {
          usd: coinDetail.ath_usd ? Number(coinDetail.ath_usd) : 0,
        },
        ath_date: {
          usd: coinDetail.ath_date ? coinDetail.ath_date.toISOString() : null,
        },
        atl: {
          usd: coinDetail.atl_usd ? Number(coinDetail.atl_usd) : 0,
        },
        // Note: Historical price changes (1h, 7d, 30d, 1y) are not stored in cache
        // These will return as undefined and show "N/A" in UI unless freshly fetched from API
        price_change_percentage_1h_in_currency: { usd: undefined },
        price_change_percentage_24h_in_currency: { 
          usd: coinDetail.price_change_percentage_24h ? Number(coinDetail.price_change_percentage_24h) : undefined 
        },
        price_change_percentage_7d_in_currency: { usd: undefined },
        price_change_percentage_30d_in_currency: { usd: undefined },
        price_change_percentage_1y_in_currency: { usd: undefined },
        atl_date: {
          usd: coinDetail.atl_date ? coinDetail.atl_date.toISOString() : null,
        },
        price_change_24h: coinDetail.price_change_24h ? Number(coinDetail.price_change_24h) : 0,
        price_change_percentage_24h: coinDetail.price_change_percentage_24h ? Number(coinDetail.price_change_percentage_24h) : 0,
      },
    };
  }

  /**
   * Get cache statistics
   */
  async getCacheStats(): Promise<{
    totalCoins: number;
    freshCoins: number;
    staleCoins: number;
    oldestUpdate: Date | null;
  }> {
    const sixHoursAgo = new Date(Date.now() - this.STALE_THRESHOLD);
    
    const [total, fresh, oldest] = await Promise.all([
      this.prisma.coin_details.count(),
      this.prisma.coin_details.count({
        where: {
          last_updated: {
            gte: sixHoursAgo,
          },
        },
      }),
      this.prisma.coin_details.findFirst({
        orderBy: {
          last_updated: 'asc',
        },
        select: {
          last_updated: true,
        },
      }),
    ]);

    return {
      totalCoins: total,
      freshCoins: fresh,
      staleCoins: total - fresh,
      oldestUpdate: oldest?.last_updated || null,
    };
  }

  /**
   * Get stale data from DB regardless of age.
   * Used as a rate-limit fallback — better to show old data than nothing.
   */
  async getStaleData(coinIdOrSymbol: string): Promise<any | null> {
    try {
      const normalizedInput = coinIdOrSymbol.toLowerCase();

      const coinDetail = await this.prisma.coin_details.findFirst({
        where: {
          OR: [
            { coingecko_id: normalizedInput },
            { symbol: normalizedInput },
          ],
        },
        orderBy: {
          last_updated: 'desc',
        },
      });

      if (!coinDetail) {
        this.logger.debug(`No stale data found for "${coinIdOrSymbol}"`);
        return null;
      }

      const age = Date.now() - coinDetail.last_updated.getTime();
      this.logger.log(
        `Returning stale data for "${coinIdOrSymbol}" (${Math.round(age / 1000 / 60)} minutes old)`,
      );
      return this.transformDBToAPIFormat(coinDetail);
    } catch (error: any) {
      this.logger.error('Failed to fetch stale data from database', {
        coinIdOrSymbol,
        error: error.message,
      });
      return null;
    }
  }
}
