import {
  Controller,
  Get,
  Query,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import {
  PositionInsightsService,
  PositionAssetType,
} from './position-insights.service';

@Controller('insights')
export class PositionInsightsController {
  private readonly logger = new Logger(PositionInsightsController.name);

  constructor(private readonly insights: PositionInsightsService) {}

  @Public()
  @Get('position')
  async getPositionInsight(
    @Query('symbol') symbol?: string,
    @Query('assetType') assetType?: string,
  ) {
    if (!symbol || !symbol.trim()) {
      throw new HttpException('symbol query param is required', HttpStatus.BAD_REQUEST);
    }
    const at = (assetType || '').toLowerCase();
    if (at !== 'crypto' && at !== 'stock') {
      throw new HttpException(
        'assetType must be either "crypto" or "stock"',
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      return await this.insights.getInsight(symbol, at as PositionAssetType);
    } catch (error: any) {
      this.logger.error(
        `Error fetching position insight for ${symbol} (${at}): ${error?.message}`,
      );
      throw new HttpException(
        error?.message || 'Failed to fetch position insight',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
