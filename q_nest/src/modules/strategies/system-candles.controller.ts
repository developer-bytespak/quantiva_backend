import {
  Controller,
  Get,
  Param,
  Query,
  Logger,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { BinanceService } from '../exchanges/integrations/binance.service';
import { AlpacaMarketService } from '../stocks-market/services/alpaca-market.service';

/**
 * System candles endpoint for server-side callers (e.g. Python signal cronjob).
 * Uses env-based Binance/Alpaca credentials. No auth required (internal/cron use).
 *
 * GET /candles/system/:symbol?interval=1d&limit=200&asset_type=crypto
 *
 * Response shape matches what Python technical_engine expects:
 * { success: true, data: [ { openTime, open, high, low, close, volume }, ... ] }
 */
@Controller('candles/system')
export class SystemCandlesController {
  private readonly logger = new Logger(SystemCandlesController.name);

  constructor(
    private readonly binanceService: BinanceService,
    private readonly alpacaMarketService: AlpacaMarketService,
  ) {}

  @Get(':symbol')
  async getCandles(
    @Param('symbol') symbol: string,
    @Query('interval') interval: string = '1h',
    @Query('limit') limit: string = '200',
    @Query('asset_type') assetType: string = 'crypto',
  ) {
    const limitNum = Math.min(1000, Math.max(1, parseInt(limit, 10) || 200));
    const normalizedType = (assetType || 'crypto').toLowerCase();

    try {
      if (normalizedType === 'stock' || normalizedType === 'stocks') {
        return this.getStockCandles(symbol, interval, limitNum);
      }
      return this.getCryptoCandles(symbol, interval, limitNum);
    } catch (error: any) {
      this.logger.warn(
        `System candles failed for ${symbol} (${normalizedType}): ${error?.message}`,
      );
      throw new HttpException(
        error?.message || 'Failed to fetch candles',
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  private async getCryptoCandles(
    symbol: string,
    interval: string,
    limit: number,
  ) {
    const pair = symbol.toUpperCase().includes('USDT')
      ? symbol.toUpperCase()
      : `${symbol.toUpperCase()}USDT`;

    const candles = await this.binanceService.getCandlestickData(
      pair,
      interval || '1h',
      limit,
    );

    const data = candles.map((c: any) => ({
      openTime: c.openTime,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));

    return { success: true, data };
  }

  private async getStockCandles(
    symbol: string,
    timeframe: string,
    limit: number,
  ) {
    const bars = await this.alpacaMarketService.getHistoricalBars(
      symbol.toUpperCase(),
      timeframe || '1d',
      limit,
    );

    const data = bars.map((bar: any) => ({
      openTime: new Date(bar.t).getTime(),
      open: bar.o,
      high: bar.h,
      low: bar.l,
      close: bar.c,
      volume: bar.v,
    }));

    return { success: true, data };
  }
}
