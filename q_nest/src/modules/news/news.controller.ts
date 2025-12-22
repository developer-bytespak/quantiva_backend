import { Controller, Get, Post, Query, Param, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { NewsService } from './news.service';
import { Public } from '../../common/decorators/public.decorator';

@Controller('news')
export class NewsController {
  private readonly logger = new Logger(NewsController.name);

  constructor(private readonly newsService: NewsService) {}

  @Public()
  @Get('all')
  async getAllNews(
    @Query('limit') limit?: string,
  ) {
    const limitNum = limit ? parseInt(limit, 10) : 100;
    if (isNaN(limitNum) || limitNum < 1 || limitNum > 1000) {
      throw new HttpException('Limit must be a number between 1 and 1000', HttpStatus.BAD_REQUEST);
    }

    try {
      return await this.newsService.getAllNewsFromDB(limitNum);
    } catch (error: any) {
      this.logger.error(`Error fetching all news: ${error.message}`);
      throw new HttpException(
        error.message || 'Failed to fetch news',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Public()
  @Get('crypto')
  async getCryptoNews(
    @Query('symbol') symbol?: string,
    @Query('symbols') symbols?: string, // Comma-separated list
    @Query('limit') limit?: string,
    @Query('forceRefresh') forceRefresh?: string,
  ) {
    // Support both single symbol and multiple symbols
    if (!symbol && !symbols) {
      throw new HttpException('Either symbol or symbols query parameter is required', HttpStatus.BAD_REQUEST);
    }

    const limitNum = limit ? parseInt(limit, 10) : 10;
    if (isNaN(limitNum) || limitNum < 1 || limitNum > 50) {
      throw new HttpException('Limit must be a number between 1 and 50', HttpStatus.BAD_REQUEST);
    }

    try {
      // Multiple symbols requested
      if (symbols) {
        const symbolArray = symbols.split(',').map(s => s.trim().toUpperCase()).filter(s => s);
        
        if (symbolArray.length === 0) {
          throw new HttpException('No valid symbols provided', HttpStatus.BAD_REQUEST);
        }

        if (symbolArray.length > 20) {
          throw new HttpException('Maximum 20 symbols allowed per request', HttpStatus.BAD_REQUEST);
        }

        this.logger.log(`Fetching news for ${symbolArray.length} symbols: ${symbolArray.join(', ')}`);
        
        // Fetch news for all symbols in parallel
        const results = await Promise.all(
          symbolArray.map(async (sym) => {
            try {
              const news = await this.newsService.getRecentNewsFromDB(sym, limitNum);
              return { symbol: sym, success: true, data: news };
            } catch (error: any) {
              this.logger.error(`Error fetching news for ${sym}: ${error.message}`);
              return { symbol: sym, success: false, error: error.message };
            }
          })
        );

        return {
          total_symbols: symbolArray.length,
          successful: results.filter(r => r.success).length,
          failed: results.filter(r => !r.success).length,
          results: results,
        };
      }

      // Single symbol (existing logic)
      // For admin/testing: force refresh from Python API (slow)
      if (forceRefresh === 'true' || forceRefresh === '1') {
        this.logger.log(`Force refresh requested for ${symbol}`);
        return await this.newsService.fetchAndStoreNewsFromPython(symbol, limitNum);
      }

      // Default: Read from database (instant)
      return await this.newsService.getRecentNewsFromDB(symbol, limitNum);
    } catch (error: any) {
      this.logger.error(`Error fetching crypto news: ${error.message}`);
      throw new HttpException(
        error.message || 'Failed to fetch crypto news',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Public()
  @Post('refresh/:symbol')
  async refreshNewsForSymbol(@Param('symbol') symbol: string) {
    try {
      // Trigger background refresh (don't wait for completion)
      setImmediate(async () => {
        try {
          await this.newsService.fetchAndStoreNewsFromPython(symbol.toUpperCase(), 20);
          this.logger.log(`Background refresh completed for ${symbol}`);
        } catch (error: any) {
          this.logger.error(`Background refresh failed for ${symbol}: ${error.message}`);
        }
      });

      return {
        message: `Background refresh initiated for ${symbol}`,
        symbol: symbol.toUpperCase(),
        status: 'pending',
      };
    } catch (error: any) {
      throw new HttpException(
        error.message || 'Failed to trigger refresh',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Public()
  @Get('assets')
  async getAllAssets() {
    try {
      const assets = await this.newsService.getAllActiveAssets();
      return {
        total: assets.length,
        assets: assets,
      };
    } catch (error: any) {
      this.logger.error(`Error fetching assets: ${error.message}`);
      throw new HttpException(
        error.message || 'Failed to fetch assets',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Public()
  @Get('stats')
  async getNewsStats() {
    try {
      const stats = await this.newsService.getNewsStats();
      return stats;
    } catch (error: any) {
      this.logger.error(`Error fetching news stats: ${error.message}`);
      throw new HttpException(
        error.message || 'Failed to fetch news stats',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
