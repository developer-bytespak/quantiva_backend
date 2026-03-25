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
   * GET /binance-trading/dashboard
   * Full dashboard: account info + balance + portfolio + positions + open orders
   */
  @Get('dashboard')
  async getDashboard(@CurrentUser() user: TokenPayload) {
    try {
      const data = await this.binanceTradingService.getDashboard(user.sub);
      return { success: true, data };
    } catch (error: any) {
      this.logger.error(`getDashboard failed: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to get Binance dashboard',
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /binance-trading/balance
   * All asset balances (free + locked) with total USDT value
   */
  @Get('balance')
  async getBalance(@CurrentUser() user: TokenPayload) {
    try {
      const data = await this.binanceTradingService.getBalance(user.sub);
      return { success: true, data };
    } catch (error: any) {
      this.logger.error(`getBalance failed: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to get balance',
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /binance-trading/positions
   * Current holdings with live prices and unrealized P&L
   */
  @Get('positions')
  async getPositions(@CurrentUser() user: TokenPayload) {
    try {
      const data = await this.binanceTradingService.getPositions(user.sub);
      return { success: true, data };
    } catch (error: any) {
      this.logger.error(`getPositions failed: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to get positions',
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /binance-trading/orders/open
   * Currently open / working orders
   * ?symbol=BTCUSDT  (optional — filter by symbol)
   */
  @Get('orders/open')
  async getOpenOrders(
    @CurrentUser() user: TokenPayload,
    @Query('symbol') symbol?: string,
  ) {
    try {
      const data = await this.binanceTradingService.getOpenOrders(user.sub, symbol);
      return { success: true, data };
    } catch (error: any) {
      this.logger.error(`getOpenOrders failed: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to get open orders',
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /binance-trading/orders/all
   * All orders for a symbol (NEW, FILLED, CANCELED, EXPIRED)
   * ?symbol=BTCUSDT  (optional — if omitted, queries all held asset pairs)
   * ?limit=100
   * ?startTime=<ms timestamp>
   * ?endTime=<ms timestamp>
   */
  @Get('orders/all')
  async getAllOrders(
    @CurrentUser() user: TokenPayload,
    @Query('symbol') symbol?: string,
    @Query('limit') limit?: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
  ) {
    try {
      const data = await this.binanceTradingService.getAllOrders(user.sub, {
        symbol,
        limit: limit ? parseInt(limit, 10) : 100,
        startTime: startTime ? parseInt(startTime, 10) : undefined,
        endTime: endTime ? parseInt(endTime, 10) : undefined,
      });
      return { success: true, data };
    } catch (error: any) {
      this.logger.error(`getAllOrders failed: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to get all orders',
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

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
  ) {
    try {
      const trades = await this.binanceTradingService.getTradeHistory(user.sub, {
        symbol,
        limit: limit ? parseInt(limit, 10) : 100,
        startTime: startTime ? parseInt(startTime, 10) : undefined,
        endTime: endTime ? parseInt(endTime, 10) : undefined,
      });

      const totalTrades = trades.length;
      const profitableTrades = trades.filter((t: any) => t.profitLoss > 0).length;
      const totalProfitLoss = trades.reduce((sum: number, t: any) => sum + (t.profitLoss || 0), 0);

      return {
        success: true,
        data: trades,
        summary: {
          totalTrades,
          profitableTrades,
          losingTrades: totalTrades - profitableTrades,
          totalProfitLoss: Math.round(totalProfitLoss * 1000) / 1000,
          winRate: totalTrades > 0 ? Math.round((profitableTrades / totalTrades) * 10000) / 100 : 0,
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
