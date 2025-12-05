import { Controller, Get, Query, HttpException, HttpStatus } from '@nestjs/common';
import { NewsService } from './news.service';
import { Public } from '../../common/decorators/public.decorator';

@Controller('news')
export class NewsController {
  constructor(private readonly newsService: NewsService) {}

  @Public()
  @Get('crypto')
  async getCryptoNews(
    @Query('symbol') symbol?: string,
    @Query('limit') limit?: string,
  ) {
    if (!symbol) {
      throw new HttpException('Symbol query parameter is required', HttpStatus.BAD_REQUEST);
    }

    const limitNum = limit ? parseInt(limit, 10) : 2;
    if (isNaN(limitNum) || limitNum < 1 || limitNum > 50) {
      throw new HttpException('Limit must be a number between 1 and 50', HttpStatus.BAD_REQUEST);
    }

    try {
      return await this.newsService.getCryptoNews(symbol, limitNum);
    } catch (error: any) {
      throw new HttpException(
        error.message || 'Failed to fetch crypto news',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}

