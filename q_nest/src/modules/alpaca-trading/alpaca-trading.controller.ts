import {
  Controller,
  Get,
  Query,
  Logger,
  HttpException,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { AlpacaTradingService } from './alpaca-trading.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { TokenPayload } from '../auth/services/token.service';

@Controller('alpaca-trading')
@UseGuards(JwtAuthGuard)
export class AlpacaTradingController {
  private readonly logger = new Logger(AlpacaTradingController.name);

  constructor(private readonly alpacaTradingService: AlpacaTradingService) {}

  /**
   * GET /alpaca-trading/dashboard
   * Full dashboard: account info + balance + portfolio + positions + open orders + market clock
   */
  @Get('dashboard')
  async getDashboard(@CurrentUser() user: TokenPayload) {
    try {
      const data = await this.alpacaTradingService.getDashboard(user.sub);
      return { success: true, data };
    } catch (error: any) {
      this.logger.error(`getDashboard failed: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to get Alpaca dashboard',
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /alpaca-trading/balance
   * Account balance: buying power, cash, portfolio value
   */
  @Get('balance')
  async getBalance(@CurrentUser() user: TokenPayload) {
    try {
      const data = await this.alpacaTradingService.getBalance(user.sub);
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
   * GET /alpaca-trading/positions
   * Current holdings with live prices and unrealized P&L
   */
  @Get('positions')
  async getPositions(@CurrentUser() user: TokenPayload) {
    try {
      const data = await this.alpacaTradingService.getPositions(user.sub);
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
   * GET /alpaca-trading/orders/open
   * Currently open / working orders
   * ?symbol=AAPL  (optional — filter by symbol)
   */
  @Get('orders/open')
  async getOpenOrders(
    @CurrentUser() user: TokenPayload,
    @Query('symbol') symbol?: string,
  ) {
    try {
      const data = await this.alpacaTradingService.getOpenOrders(user.sub, symbol);
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
   * GET /alpaca-trading/orders/all
   * All orders (open + closed)
   * ?symbol=AAPL  (optional — filter by symbol)
   * ?limit=100
   */
  @Get('orders/all')
  async getAllOrders(
    @CurrentUser() user: TokenPayload,
    @Query('symbol') symbol?: string,
    @Query('limit') limit?: string,
  ) {
    try {
      const data = await this.alpacaTradingService.getAllOrders(user.sub, {
        symbol,
        limit: limit ? parseInt(limit, 10) : 100,
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
   * GET /alpaca-trading/trade-history
   * Filled orders as trade history
   * ?symbol=AAPL  (optional — filter by symbol)
   * ?limit=100
   */
  @Get('trade-history')
  async getTradeHistory(
    @CurrentUser() user: TokenPayload,
    @Query('symbol') symbol?: string,
    @Query('limit') limit?: string,
  ) {
    try {
      const trades = await this.alpacaTradingService.getTradeHistory(user.sub, {
        symbol,
        limit: limit ? parseInt(limit, 10) : 100,
      });

      const totalTrades = trades.length;
      const buyTrades   = trades.filter((t: any) => t.side === 'BUY').length;
      const sellTrades  = trades.filter((t: any) => t.side === 'SELL').length;
      const totalVolume = trades.reduce((sum: number, t: any) => sum + (t.notional || 0), 0);

      return {
        success: true,
        data: trades,
        summary: {
          totalTrades,
          buyTrades,
          sellTrades,
          totalVolume: Math.round(totalVolume * 100) / 100,
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
