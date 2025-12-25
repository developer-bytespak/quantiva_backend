import { Controller, Get, Query, Param, HttpException, HttpStatus } from '@nestjs/common';
import { MarketService } from './market.service';

@Controller('api/market')
export class MarketController {
  constructor(private readonly marketService: MarketService) {}

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
   * Query params: limit (default: 500), search (optional)
   */
  @Get('coins/cached')
  async getCachedMarketData(
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    try {
      const limitNum = limit ? parseInt(limit, 10) : 500;
      if (isNaN(limitNum) || limitNum < 1 || limitNum > 500) {
        throw new HttpException(
          'Limit must be a number between 1 and 500',
          HttpStatus.BAD_REQUEST,
        );
      }
      return await this.marketService.getCachedMarketData(limitNum, search);
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
}

