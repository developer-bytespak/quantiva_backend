import { Controller, Get, Query, Param, HttpException, HttpStatus, Post, UseGuards, Logger } from '@nestjs/common';
import { MarketService } from './market.service';
import { CoinDetailsCacheService } from './services/coin-details-cache.service';
import { ExchangesService as MarketExchangesService } from './services/exchanges.service';
import { ExchangesService } from '../exchanges/exchanges.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { TokenPayload } from '../auth/services/token.service';

@Controller('api/market')
export class MarketController {
  private readonly logger = new Logger(MarketController.name);

  constructor(
    private readonly marketService: MarketService,
    private readonly coinDetailsCacheService: CoinDetailsCacheService,
    private readonly exchangesService: MarketExchangesService,
    private readonly exchangesConnectionService: ExchangesService,
  ) {}

  /**
   * GET /api/market/coins/top
   * Fetch top N cryptocurrencies by market cap
   * Query params: limit (default: 5)
   */
  @Get('coins/top')
  async getTopCoins(@Query('limit') limit?: string) {
    try {
      const limitNum = limit ? parseInt(limit, 10) : 5;
      if (isNaN(limitNum) || limitNum < 1 || limitNum > 500) {
        throw new HttpException(
          'Limit must be a number between 1 and 500',
          HttpStatus.BAD_REQUEST,
        );
      }
      return await this.marketService.getTopCoins(limitNum);
    } catch (error: any) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        error.message || 'Failed to fetch top coins',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/market/coins/top500
   * Fetch top 500 cryptocurrencies by market cap
   */
  @Get('coins/top500')
  async getTop500Coins() {
    try {
      return await this.marketService.getTop500Coins();
    } catch (error: any) {
      throw new HttpException(
        error.message || 'Failed to fetch top 500 coins',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/market/coins/cached
   * Fetch cached market data from database (updated every 5 minutes)
   * Automatically filters by user's connected exchange if authenticated
   * Query params: limit (default: 500), search (optional)
   */
  @Get('coins/cached')
  async getCachedMarketData(
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @CurrentUser() user?: TokenPayload,
  ) {
    try {
      const limitNum = limit ? parseInt(limit, 10) : 500;
      if (isNaN(limitNum) || limitNum < 1 || limitNum > 500) {
        throw new HttpException(
          'Limit must be a number between 1 and 500',
          HttpStatus.BAD_REQUEST,
        );
      }

      // If user is authenticated, get their exchange connection
      let exchangeName: string | undefined;
      if (user && user.sub) {
        try {
          const connection = await this.exchangesConnectionService.getActiveConnection(user.sub);
          exchangeName = connection.exchange.name.toLowerCase();
          // Only use if it's Binance or Bybit
          if (exchangeName !== 'binance' && exchangeName !== 'bybit') {
            exchangeName = undefined; // Fall back to default (Binance)
          }
        } catch (error) {
          // If no connection found, fall back to default (Binance)
          this.logger.debug('No active connection found for user, using default exchange');
        }
      }

      return await this.marketService.getCachedMarketData(limitNum, search, exchangeName);
    } catch (error: any) {
      throw new HttpException(
        error.message || 'Failed to fetch cached market data',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/market/coins/search
   * Search for coins by query string
   * Query params: query (required)
   */
  @Get('coins/search')
  async searchCoins(@Query('query') query?: string) {
    try {
      if (!query) {
        throw new HttpException(
          'Query parameter is required',
          HttpStatus.BAD_REQUEST,
        );
      }
      const coinId = await this.marketService.searchCoinBySymbol(query);
      return { coinId };
    } catch (error: any) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        error.message || 'Failed to search coins',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/market/exchanges/binance/coins
   * Fetch all coins available on Binance from CoinGecko Pro API
   */
  @Get('exchanges/binance/coins')
  async getBinanceCoins() {
    try {
      const coins = await this.exchangesService.getAllBinanceCoins();
      return { coins };
    } catch (error: any) {
      throw new HttpException(
        error.message || 'Failed to fetch Binance coins',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/market/exchanges/bybit/coins
   * Fetch all coins available on Bybit from CoinGecko Pro API
   */
  @Get('exchanges/bybit/coins')
  async getBybitCoins() {
    try {
      const coins = await this.exchangesService.getAllBybitCoins();
      return { coins };
    } catch (error: any) {
      throw new HttpException(
        error.message || 'Failed to fetch Bybit coins',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/market/exchanges/coins
   * Fetch coins for the user's connected exchange (Binance or Bybit)
   * Automatically routes based on user's active exchange connection
   * Requires authentication
   */
  @Get('exchanges/coins')
  @UseGuards(JwtAuthGuard)
  async getExchangeCoins(@CurrentUser() user: TokenPayload) {
    try {
      if (!user || !user.sub) {
        throw new HttpException(
          'User not authenticated',
          HttpStatus.UNAUTHORIZED,
        );
      }

      // Get user's active connection
      const connection = await this.exchangesConnectionService.getActiveConnection(user.sub);
      const exchangeName = connection.exchange.name.toLowerCase();

      // Route to appropriate exchange based on connection
      let coins: string[];
      if (exchangeName === 'bybit') {
        coins = await this.exchangesService.getBybitCoinsWithUsdtPairs();
      } else if (exchangeName === 'binance') {
        coins = await this.exchangesService.getBinanceCoinsWithUsdtPairs();
      } else {
        throw new HttpException(
          `Exchange ${exchangeName} is not supported for coin filtering`,
          HttpStatus.BAD_REQUEST,
        );
      }

      return { 
        coins,
        exchange: exchangeName,
      };
    } catch (error: any) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        error.message || 'Failed to fetch exchange coins',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/market/coins/:coinIdOrSymbol
   * Fetch detailed information about a specific coin
   * Accepts either coin ID (e.g., "bitcoin") or symbol (e.g., "BTC")
   * MUST BE LAST - catch-all route
   */
  @Get('coins/:coinIdOrSymbol')
  async getCoinDetails(@Param('coinIdOrSymbol') coinIdOrSymbol: string) {
    try {
      if (!coinIdOrSymbol) {
        throw new HttpException(
          'Coin ID or symbol is required',
          HttpStatus.BAD_REQUEST,
        );
      }
      return await this.marketService.getCoinDetails(coinIdOrSymbol);
    } catch (error: any) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        error.message || 'Failed to fetch coin details',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /api/market/coins/sync
   * Manually trigger sync of top N coins (admin only)
   * Body: { limit?: number }
   */
  @Post('coins/sync')
  async syncTopCoins(@Query('limit') limit?: string) {
    try {
      const limitNum = limit ? parseInt(limit, 10) : 200;
      if (isNaN(limitNum) || limitNum < 1 || limitNum > 500) {
        throw new HttpException(
          'Limit must be a number between 1 and 500',
          HttpStatus.BAD_REQUEST,
        );
      }
      
      const result = await this.coinDetailsCacheService.syncTopCoins(limitNum);
      
      return {
        message: 'Coin sync completed',
        ...result,
      };
    } catch (error: any) {
      throw new HttpException(
        error.message || 'Failed to sync coins',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /api/market/coins/refresh-stale
   * Manually trigger refresh of stale coins
   * Query params: maxCoins (default: 50)
   */
  @Post('coins/refresh-stale')
  async refreshStaleCoins(@Query('maxCoins') maxCoins?: string) {
    try {
      const max = maxCoins ? parseInt(maxCoins, 10) : 50;
      if (isNaN(max) || max < 1 || max > 200) {
        throw new HttpException(
          'maxCoins must be a number between 1 and 200',
          HttpStatus.BAD_REQUEST,
        );
      }
      
      const result = await this.coinDetailsCacheService.refreshStaleCoins(max);
      
      return {
        message: 'Stale coins refresh completed',
        ...result,
      };
    } catch (error: any) {
      throw new HttpException(
        error.message || 'Failed to refresh stale coins',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/market/coins/cache/stats
   * Get cache statistics
   */
  @Get('coins/cache/stats')
  async getCacheStats() {
    try {
      const stats = await this.coinDetailsCacheService.getCacheStats();
      return stats;
    } catch (error: any) {
      throw new HttpException(
        error.message || 'Failed to get cache stats',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}

