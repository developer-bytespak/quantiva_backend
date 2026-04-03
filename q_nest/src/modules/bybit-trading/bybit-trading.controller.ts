import {
  Controller,
  Get,
  Query,
  Logger,
  HttpException,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { BybitTradingService } from './bybit-trading.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { TokenPayload } from '../auth/services/token.service';

@Controller('bybit-trading')
@UseGuards(JwtAuthGuard)
export class BybitTradingController {
  private readonly logger = new Logger(BybitTradingController.name);

  constructor(private readonly bybitTradingService: BybitTradingService) {}

  @Get('dashboard')
  async getDashboard(@CurrentUser() user: TokenPayload) {
    try {
      const data = await this.bybitTradingService.getDashboard(user.sub);
      return { success: true, data };
    } catch (error: any) {
      this.logger.error(`getDashboard failed: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to get Bybit dashboard',
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('balance')
  async getBalance(@CurrentUser() user: TokenPayload) {
    try {
      const data = await this.bybitTradingService.getBalance(user.sub);
      return { success: true, data };
    } catch (error: any) {
      this.logger.error(`getBalance failed: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to get balance',
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('positions')
  async getPositions(@CurrentUser() user: TokenPayload) {
    try {
      const data = await this.bybitTradingService.getPositions(user.sub);
      return { success: true, data };
    } catch (error: any) {
      this.logger.error(`getPositions failed: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to get positions',
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('orders/open')
  async getOpenOrders(
    @CurrentUser() user: TokenPayload,
    @Query('symbol') symbol?: string,
  ) {
    try {
      const data = await this.bybitTradingService.getOpenOrders(user.sub, symbol);
      return { success: true, data };
    } catch (error: any) {
      this.logger.error(`getOpenOrders failed: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to get open orders',
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('orders/all')
  async getAllOrders(
    @CurrentUser() user: TokenPayload,
    @Query('symbol') symbol?: string,
    @Query('limit') limit?: string,
    @Query('period') period?: '1d' | '1w' | '1m' | '6m',
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
  ) {
    try {
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

      const allOrders = await this.bybitTradingService.getAllOrders(user.sub, {
        symbol,
        limit: limit ? parseInt(limit, 10) : 500,
      });

      const orders = (filterStartTime || filterEndTime)
        ? allOrders.filter((o: any) => {
            const orderTime = o.updateTime || o.time || 0;
            if (filterStartTime && orderTime < filterStartTime) return false;
            if (filterEndTime && orderTime > filterEndTime) return false;
            return true;
          })
        : allOrders;

      const totalOrders = orders.length;
      const filledOrders = orders.filter((o: any) => o.status === 'FILLED').length;
      const canceledOrders = orders.filter((o: any) => ['CANCELED', 'EXPIRED', 'REJECTED'].includes(o.status)).length;
      const pendingOrders = orders.filter((o: any) => ['NEW', 'PARTIALLY_FILLED'].includes(o.status)).length;
      const totalVolume = orders.reduce((sum: number, o: any) => sum + (o.totalValue || 0), 0);

      return {
        success: true,
        data: orders,
        summary: {
          totalOrders,
          filledOrders,
          canceledOrders,
          pendingOrders,
          totalVolume: Math.round(totalVolume * 100) / 100,
        },
      };
    } catch (error: any) {
      this.logger.error(`getAllOrders failed: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to get all orders',
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

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

      const allTrades = await this.bybitTradingService.getTradeHistory(user.sub, {
        symbol,
        limit: limit ? parseInt(limit, 10) : 500,
      });

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
          totalFees: Math.round(totalFees * 1e8) / 1e8,
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
