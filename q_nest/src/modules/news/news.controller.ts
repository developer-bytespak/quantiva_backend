import { Controller, Get, Post, Query, Param, Body, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { NewsService } from './news.service';
import { NewsCronjobService } from './news-cronjob.service';
import { Public } from '../../common/decorators/public.decorator';

@Controller('news')
export class NewsController {
  private readonly logger = new Logger(NewsController.name);

  constructor(
    private readonly newsService: NewsService,
    private readonly newsCronjobService: NewsCronjobService,
  ) {}

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

  // ============== STOCK NEWS ENDPOINTS ==============

  @Public()
  @Get('stocks')
  async getStockNews(
    @Query('symbol') symbol?: string,
    @Query('symbols') symbols?: string,
    @Query('limit') limit?: string,
    @Query('forceRefresh') forceRefresh?: string,
  ) {
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

        this.logger.log(`Fetching stock news for ${symbolArray.length} symbols: ${symbolArray.join(', ')}`);

        const results = await Promise.all(
          symbolArray.map(async (sym) => {
            try {
              const news = await this.newsService.getRecentStockNewsFromDB(sym, limitNum);
              return { symbol: sym, success: true, data: news };
            } catch (error: any) {
              this.logger.error(`Error fetching stock news for ${sym}: ${error.message}`);
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

      // Single symbol
      if (forceRefresh === 'true' || forceRefresh === '1') {
        this.logger.log(`Force refresh requested for stock ${symbol}`);
        return await this.newsService.fetchAndStoreStockNewsFromPython(symbol, limitNum);
      }

      // Default: Read from database
      return await this.newsService.getRecentStockNewsFromDB(symbol, limitNum);
    } catch (error: any) {
      this.logger.error(`Error fetching stock news: ${error.message}`);
      throw new HttpException(
        error.message || 'Failed to fetch stock news',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Public()
  @Get('stocks/debug')
  async debugStockNews() {
    try {
      // Quick debug endpoint to check database state
      const stockAssets = await this.newsService['prisma'].assets.findMany({
        where: { asset_type: 'stock' },
        take: 10,
        select: { asset_id: true, symbol: true, asset_type: true },
      });

      const totalStockNewsCount = await this.newsService['prisma'].trending_news.count({
        where: {
          asset: { asset_type: 'stock' },
        },
      });

      const recentStockNews = await this.newsService['prisma'].trending_news.findMany({
        where: {
          asset: { asset_type: 'stock' },
        },
        take: 5,
        orderBy: { poll_timestamp: 'desc' },
        select: {
          trending_news_id: true,
          heading: true,
          article_url: true,
          source: true,
          poll_timestamp: true,
          asset: { select: { symbol: true, asset_type: true } },
        },
      });

      return {
        stock_assets_count: stockAssets.length,
        stock_assets_sample: stockAssets,
        total_stock_news_count: totalStockNewsCount,
        recent_stock_news_sample: recentStockNews,
      };
    } catch (error: any) {
      return { error: error.message };
    }
  }

  @Public()
  @Get('stocks/all')
  async getAllStockNews(@Query('limit') limit?: string) {
    const limitNum = limit ? parseInt(limit, 10) : 100;
    if (isNaN(limitNum) || limitNum < 1 || limitNum > 1000) {
      throw new HttpException('Limit must be a number between 1 and 1000', HttpStatus.BAD_REQUEST);
    }

    try {
      return await this.newsService.getAllStockNewsFromDB(limitNum);
    } catch (error: any) {
      this.logger.error(`Error fetching all stock news: ${error.message}`);
      throw new HttpException(
        error.message || 'Failed to fetch stock news',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Public()
  @Post('stocks/refresh/:symbol')
  async refreshStockNewsForSymbol(@Param('symbol') symbol: string) {
    try {
      // Trigger background refresh
      setImmediate(async () => {
        try {
          await this.newsService.fetchAndStoreStockNewsFromPython(symbol.toUpperCase(), 20);
          this.logger.log(`Background stock news refresh completed for ${symbol}`);
        } catch (error: any) {
          this.logger.error(`Background stock news refresh failed for ${symbol}: ${error.message}`);
        }
      });

      return {
        message: `Background refresh initiated for stock ${symbol}`,
        symbol: symbol.toUpperCase(),
        status: 'pending',
      };
    } catch (error: any) {
      throw new HttpException(
        error.message || 'Failed to trigger stock news refresh',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Public()
  @Post('stocks/refresh-general')
  async refreshGeneralStockNews(@Query('limit') limit?: string) {
    const limitNum = limit ? parseInt(limit, 10) : 30;
    
    try {
      this.logger.log(`Triggering general stock news refresh (limit=${limitNum})`);
      
      // Fetch and store general stock news - runs synchronously so user can see result
      const result = await this.newsService.fetchAndStoreGeneralStockNewsFromPython(limitNum);
      
      return {
        message: 'General stock news refresh completed',
        ...result,
      };
    } catch (error: any) {
      this.logger.error(`General stock news refresh failed: ${error.message}`);
      throw new HttpException(
        error.message || 'Failed to refresh general stock news',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Public()
  @Post('stocks/refresh-general-fast')
  async refreshGeneralStockNewsFast(@Query('limit') limit?: string) {
    const limitNum = limit ? parseInt(limit, 10) : 50;
    
    try {
      this.logger.log(`Triggering FAST general stock news refresh (limit=${limitNum}) - no sentiment analysis`);
      
      // Fetch and store general stock news WITHOUT sentiment analysis
      const result = await this.newsService.fetchAndStoreGeneralStockNewsFast(limitNum);
      
      return {
        message: 'General stock news refresh completed (fast mode - no sentiment)',
        ...result,
      };
    } catch (error: any) {
      this.logger.error(`Fast stock news refresh failed: ${error.message}`);
      throw new HttpException(
        error.message || 'Failed to refresh general stock news',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Public()
  @Post('stocks/trigger-aggregation')
  async triggerStockNewsAggregation(
    @Body() body?: { symbols?: string[] },
  ) {
    try {
      this.logger.log('Manual stock news aggregation triggered via API');
      const result = await this.newsCronjobService.triggerStockNewsAggregation(body?.symbols);
      return result;
    } catch (error: any) {
      this.logger.error(`Stock news aggregation failed: ${error.message}`);
      throw new HttpException(
        error.message || 'Failed to aggregate stock news',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
