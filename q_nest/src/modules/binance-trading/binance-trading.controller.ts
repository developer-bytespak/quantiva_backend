import {
  Controller,
  Get,
  Query,
  Logger,
  HttpException,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { BinanceTradingService } from './binance-trading.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { TokenPayload } from '../auth/services/token.service';

@Controller('binance-trading')
@UseGuards(JwtAuthGuard)
export class BinanceTradingController {
  private readonly logger = new Logger(BinanceTradingController.name);

  constructor(private readonly binanceTradingService: BinanceTradingService) {}

  /**
   * GET /binance-trading/trade-history
   * Closed trades with realized P&L (FIFO matched BUY/SELL fills)
   * ?symbol=BTCUSDT  (optional — if omitted, queries all held asset pairs)
   * ?limit=100
   * ?startTime=<ms timestamp>
   * ?endTime=<ms timestamp>
   */
  @Get('trade-history')
  async getTradeHistory(
    @CurrentUser() user: TokenPayload,
    @Query('symbol') symbol?: string,
    @Query('limit') limit?: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
    @Query('period') period?: '1d' | '1w' | '1m' | '6m',
  ) {
    try {
      // Resolve time filter boundaries (period shortcut or explicit startTime/endTime)
      let filterStartTime: number | undefined;
      let filterEndTime: number | undefined;

      if (period) {
        const now = Date.now();
        const periodMs: Record<string, number> = {
          '1d': 24 * 60 * 60 * 1000,
          '1w': 7 * 24 * 60 * 60 * 1000,
          '1m': 30 * 24 * 60 * 60 * 1000,
          '6m': 180 * 24 * 60 * 60 * 1000,
        };
        if (periodMs[period]) {
          filterStartTime = now - periodMs[period];
          filterEndTime = now;
        }
      } else {
        filterStartTime = startTime ? parseInt(startTime, 10) : undefined;
        filterEndTime = endTime ? parseInt(endTime, 10) : undefined;
      }

      // Fetch ALL trades (no time filter to Binance) so FIFO matching works correctly,
      // then filter by time after enrichment + P&L calculation
      const allTrades = await this.binanceTradingService.getTradeHistory(user.sub, {
        symbol,
        limit: limit ? parseInt(limit, 10) : 500,
      });

      // Apply time filter after FIFO matching
      // Use updateTime (when order was filled/triggered) instead of time (when order was placed)
      // This correctly handles stop-loss/limit orders that were placed days/weeks before triggering
      const trades = (filterStartTime || filterEndTime)
        ? allTrades.filter((t: any) => {
            const fillTime = t.updateTime || t.time || 0;
            if (filterStartTime && fillTime < filterStartTime) return false;
            if (filterEndTime && fillTime > filterEndTime) return false;
            return true;
          })
        : allTrades;

      const totalTrades = trades.length;
      const sellTrades = trades.filter((t: any) => t.side === 'SELL');
      const profitableTrades = sellTrades.filter((t: any) => t.profitLoss > 0).length;
      const losingTrades = sellTrades.filter((t: any) => t.profitLoss < 0).length;
      const totalProfitLoss = trades.reduce((sum: number, t: any) => sum + (t.profitLoss || 0), 0);
      const totalVolume = trades.reduce((sum: number, t: any) => sum + (t.totalValue || 0), 0);
      const totalFees = trades.reduce((sum: number, t: any) => sum + (t.totalFee || 0), 0);

      return {
        success: true,
        data: trades,
        summary: {
          totalTrades,
          profitableTrades,
          losingTrades,
          totalProfitLoss: Math.round(totalProfitLoss * 1000) / 1000,
          winRate: sellTrades.length > 0 ? Math.round((profitableTrades / sellTrades.length) * 10000) / 100 : 0,
          totalVolume: Math.round(totalVolume * 100) / 100,
          totalFees: Math.round(totalFees * 100000000) / 100000000,
        },
      };
    } catch (error: any) {
      this.logger.error(`getTradeHistory failed: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to get trade history',
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
