import {
  Controller,
  Get,
  Query,
  Logger,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { BinancePaperTradingService } from './binance-paper-trading.service';

@Controller('binance-paper-trading')
export class BinancePaperTradingController {
  private readonly logger = new Logger(BinancePaperTradingController.name);

  constructor(private readonly binanceService: BinancePaperTradingService) {}

  /**
   * GET /binance-paper-trading/status
   */
  @Get('status')
  async getStatus() {
    const status = this.binanceService.getStatus();
    const connected = status.configured
      ? await this.binanceService.verifyConnection()
      : false;
    return { ...status, connected, timestamp: new Date().toISOString() };
  }

  /**
   * GET /binance-paper-trading/dashboard
   * Full dashboard: account, balance, positions, open orders, recent orders, clock
   */
  @Get('dashboard')
  async getDashboard() {
    try {
      const data = await this.binanceService.getDashboardData();
      return { success: true, data };
    } catch (error: any) {
      this.logger.error(`Failed to get dashboard: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to get dashboard data',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /binance-paper-trading/balance
   */
  @Get('balance')
  async getBalance() {
    try {
      const balance = await this.binanceService.getAccountBalance();
      return { success: true, data: balance };
    } catch (error: any) {
      this.logger.error(`Failed to get balance: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to get balance',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /binance-paper-trading/positions
   */
  @Get('positions')
  async getPositions() {
    try {
      const positions = await this.binanceService.getPositions();
      return { success: true, data: positions };
    } catch (error: any) {
      this.logger.error(`Failed to get positions: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to get positions',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /binance-paper-trading/orders
   * ?status=open   -> open orders from Binance testnet
   * ?status=recent -> recent orders from DB
   * ?symbol=BTCUSDT -> filter by symbol (open orders only)
   * ?limit=50
   */
  @Get('orders')
  async getOrders(
    @Query('status') status?: string,
    @Query('symbol') symbol?: string,
    @Query('limit') limit?: string,
  ) {
    try {
      if (status === 'recent') {
        const orders = await this.binanceService.getRecentOrders(
          limit ? parseInt(limit, 10) : 50,
        );
        return { success: true, data: orders };
      }
      const orders = await this.binanceService.getOpenOrders(symbol);
      return { success: true, data: orders };
    } catch (error: any) {
      this.logger.error(`Failed to get orders: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to get orders',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /binance-paper-trading/trade-history
   * Closed trades with realized P&L
   */
  @Get('trade-history')
  async getTradeHistory(
    @Query('limit') limit?: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
  ) {
    try {
      const trades = await this.binanceService.getTradeHistory({
        limit: limit ? parseInt(limit, 10) : 100,
        startTime: startTime ? parseInt(startTime, 10) : undefined,
        endTime: endTime ? parseInt(endTime, 10) : undefined,
      });

      const totalTrades = trades.length;
      const profitableTrades = trades.filter((t: any) => t.profitLoss > 0).length;
      const totalProfitLoss = trades.reduce(
        (sum: number, t: any) => sum + (t.profitLoss || 0),
        0,
      );

      return {
        success: true,
        data: trades,
        summary: {
          totalTrades,
          profitableTrades,
          losingTrades: totalTrades - profitableTrades,
          totalProfitLoss,
          winRate: totalTrades > 0 ? (profitableTrades / totalTrades) * 100 : 0,
        },
      };
    } catch (error: any) {
      this.logger.error(`Failed to get trade history: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to get trade history',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
