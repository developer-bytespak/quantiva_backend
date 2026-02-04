import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Body,
  Param,
  Query,
  Logger,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { AlpacaPaperTradingService, PlaceOrderParams } from './alpaca-paper-trading.service';

@Controller('alpaca-paper-trading')
export class AlpacaPaperTradingController {
  private readonly logger = new Logger(AlpacaPaperTradingController.name);

  constructor(private readonly alpacaService: AlpacaPaperTradingService) {}

  /**
   * Health check and status
   */
  @Get('status')
  async getStatus() {
    const status = this.alpacaService.getStatus();
    const connected = status.configured ? await this.alpacaService.verifyConnection() : false;
    
    return {
      ...status,
      connected,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Get full dashboard data (account, positions, orders, clock)
   */
  @Get('dashboard')
  async getDashboard() {
    try {
      const data = await this.alpacaService.getDashboardData();
      return {
        success: true,
        data,
      };
    } catch (error: any) {
      this.logger.error(`Failed to get dashboard: ${error?.message}`);
      throw new HttpException(
        error?.response?.data?.message || error?.message || 'Failed to get dashboard data',
        error?.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get account information
   */
  @Get('account')
  async getAccount() {
    try {
      const account = await this.alpacaService.getAccount();
      return {
        success: true,
        data: account,
      };
    } catch (error: any) {
      this.logger.error(`Failed to get account: ${error?.message}`);
      throw new HttpException(
        error?.response?.data?.message || error?.message || 'Failed to get account',
        error?.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get account balance summary
   */
  @Get('balance')
  async getBalance() {
    try {
      const balance = await this.alpacaService.getAccountBalance();
      return {
        success: true,
        data: balance,
      };
    } catch (error: any) {
      this.logger.error(`Failed to get balance: ${error?.message}`);
      throw new HttpException(
        error?.response?.data?.message || error?.message || 'Failed to get balance',
        error?.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get all positions
   */
  @Get('positions')
  async getPositions() {
    try {
      const positions = await this.alpacaService.getPositions();
      return {
        success: true,
        data: positions,
        count: positions.length,
      };
    } catch (error: any) {
      this.logger.error(`Failed to get positions: ${error?.message}`);
      throw new HttpException(
        error?.response?.data?.message || error?.message || 'Failed to get positions',
        error?.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get position for a specific symbol
   */
  @Get('positions/:symbol')
  async getPosition(@Param('symbol') symbol: string) {
    try {
      const position = await this.alpacaService.getPosition(symbol.toUpperCase());
      if (!position) {
        return {
          success: true,
          data: null,
          message: `No position found for ${symbol}`,
        };
      }
      return {
        success: true,
        data: position,
      };
    } catch (error: any) {
      this.logger.error(`Failed to get position for ${symbol}: ${error?.message}`);
      throw new HttpException(
        error?.response?.data?.message || error?.message || 'Failed to get position',
        error?.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Close a position
   */
  @Delete('positions/:symbol')
  async closePosition(
    @Param('symbol') symbol: string,
    @Query('qty') qty?: string,
    @Query('percentage') percentage?: string,
  ) {
    try {
      const order = await this.alpacaService.closePosition(
        symbol.toUpperCase(),
        qty ? parseFloat(qty) : undefined,
        percentage ? parseFloat(percentage) : undefined,
      );
      return {
        success: true,
        data: order,
        message: `Position ${symbol} closed`,
      };
    } catch (error: any) {
      this.logger.error(`Failed to close position ${symbol}: ${error?.message}`);
      throw new HttpException(
        error?.response?.data?.message || error?.message || 'Failed to close position',
        error?.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Close all positions
   */
  @Delete('positions')
  async closeAllPositions(@Query('cancel_orders') cancelOrders?: string) {
    try {
      const orders = await this.alpacaService.closeAllPositions(cancelOrders !== 'false');
      return {
        success: true,
        data: orders,
        message: 'All positions closed',
      };
    } catch (error: any) {
      this.logger.error(`Failed to close all positions: ${error?.message}`);
      throw new HttpException(
        error?.response?.data?.message || error?.message || 'Failed to close positions',
        error?.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get orders
   */
  @Get('orders')
  async getOrders(
    @Query('status') status?: 'open' | 'closed' | 'all',
    @Query('limit') limit?: string,
    @Query('after') after?: string,
    @Query('until') until?: string,
    @Query('direction') direction?: 'asc' | 'desc',
    @Query('symbols') symbols?: string,
  ) {
    try {
      const orders = await this.alpacaService.getOrders({
        status: status || 'all',
        limit: limit ? parseInt(limit, 10) : 100,
        after,
        until,
        direction,
        symbols,
      });
      return {
        success: true,
        data: orders,
        count: orders.length,
      };
    } catch (error: any) {
      this.logger.error(`Failed to get orders: ${error?.message}`);
      throw new HttpException(
        error?.response?.data?.message || error?.message || 'Failed to get orders',
        error?.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get a specific order
   */
  @Get('orders/:orderId')
  async getOrder(@Param('orderId') orderId: string) {
    try {
      const order = await this.alpacaService.getOrder(orderId);
      return {
        success: true,
        data: order,
      };
    } catch (error: any) {
      this.logger.error(`Failed to get order ${orderId}: ${error?.message}`);
      throw new HttpException(
        error?.response?.data?.message || error?.message || 'Failed to get order',
        error?.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Place a new order
   */
  @Post('orders')
  async placeOrder(@Body() orderParams: PlaceOrderParams) {
    try {
      // Validate required fields
      if (!orderParams.symbol) {
        throw new HttpException('Symbol is required', HttpStatus.BAD_REQUEST);
      }
      if (!orderParams.side || !['buy', 'sell'].includes(orderParams.side)) {
        throw new HttpException('Side must be "buy" or "sell"', HttpStatus.BAD_REQUEST);
      }
      if (!orderParams.type) {
        orderParams.type = 'market';
      }
      if (!orderParams.time_in_force) {
        orderParams.time_in_force = 'day';
      }
      if (!orderParams.qty && !orderParams.notional) {
        throw new HttpException('Either qty or notional is required', HttpStatus.BAD_REQUEST);
      }

      const order = await this.alpacaService.placeOrder(orderParams);
      return {
        success: true,
        data: order,
        message: `Order placed: ${order.side} ${order.qty} ${order.symbol}`,
      };
    } catch (error: any) {
      this.logger.error(`Failed to place order: ${error?.message}`);
      throw new HttpException(
        error?.response?.data?.message || error?.message || 'Failed to place order',
        error?.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Cancel an order
   */
  @Delete('orders/:orderId')
  async cancelOrder(@Param('orderId') orderId: string) {
    try {
      await this.alpacaService.cancelOrder(orderId);
      return {
        success: true,
        message: `Order ${orderId} canceled`,
      };
    } catch (error: any) {
      this.logger.error(`Failed to cancel order ${orderId}: ${error?.message}`);
      throw new HttpException(
        error?.response?.data?.message || error?.message || 'Failed to cancel order',
        error?.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Cancel all orders
   */
  @Delete('orders')
  async cancelAllOrders() {
    try {
      const result = await this.alpacaService.cancelAllOrders();
      return {
        success: true,
        data: result,
        message: 'All orders canceled',
      };
    } catch (error: any) {
      this.logger.error(`Failed to cancel all orders: ${error?.message}`);
      throw new HttpException(
        error?.response?.data?.message || error?.message || 'Failed to cancel orders',
        error?.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Replace/modify an order
   */
  @Patch('orders/:orderId')
  async replaceOrder(
    @Param('orderId') orderId: string,
    @Body() params: {
      qty?: number;
      time_in_force?: string;
      limit_price?: number;
      stop_price?: number;
      trail?: number;
    },
  ) {
    try {
      const order = await this.alpacaService.replaceOrder(orderId, params);
      return {
        success: true,
        data: order,
        message: `Order ${orderId} updated`,
      };
    } catch (error: any) {
      this.logger.error(`Failed to replace order ${orderId}: ${error?.message}`);
      throw new HttpException(
        error?.response?.data?.message || error?.message || 'Failed to replace order',
        error?.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get portfolio history
   */
  @Get('portfolio/history')
  async getPortfolioHistory(
    @Query('period') period?: string,
    @Query('timeframe') timeframe?: string,
    @Query('date_end') dateEnd?: string,
    @Query('extended_hours') extendedHours?: string,
  ) {
    try {
      const history = await this.alpacaService.getPortfolioHistory({
        period: period || '1M',
        timeframe: timeframe || '1D',
        date_end: dateEnd,
        extended_hours: extendedHours === 'true',
      });
      return {
        success: true,
        data: history,
      };
    } catch (error: any) {
      this.logger.error(`Failed to get portfolio history: ${error?.message}`);
      throw new HttpException(
        error?.response?.data?.message || error?.message || 'Failed to get portfolio history',
        error?.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get account activities
   */
  @Get('activities')
  async getActivities(
    @Query('activity_types') activityTypes?: string,
    @Query('after') after?: string,
    @Query('until') until?: string,
    @Query('direction') direction?: 'asc' | 'desc',
    @Query('page_size') pageSize?: string,
  ) {
    try {
      const types = activityTypes?.split(',') || undefined;
      const activities = await this.alpacaService.getAccountActivities(types, {
        after,
        until,
        direction,
        page_size: pageSize ? parseInt(pageSize, 10) : undefined,
      });
      return {
        success: true,
        data: activities,
        count: activities.length,
      };
    } catch (error: any) {
      this.logger.error(`Failed to get activities: ${error?.message}`);
      throw new HttpException(
        error?.response?.data?.message || error?.message || 'Failed to get activities',
        error?.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get trade history with realized P&L
   */
  @Get('trade-history')
  async getTradeHistory(
    @Query('limit') limit?: string,
    @Query('after') after?: string,
    @Query('until') until?: string,
  ) {
    try {
      const history = await this.alpacaService.getTradeHistory({
        limit: limit ? parseInt(limit, 10) : 200,
        after,
        until,
      });
      
      // Calculate summary statistics
      const totalProfitLoss = history.reduce((sum, trade) => sum + trade.profitLoss, 0);
      const profitableTrades = history.filter(t => t.profitLoss > 0).length;
      const losingTrades = history.filter(t => t.profitLoss < 0).length;
      const winRate = history.length > 0 ? (profitableTrades / history.length) * 100 : 0;
      const avgProfit = history.length > 0 ? totalProfitLoss / history.length : 0;
      
      return {
        success: true,
        data: history,
        summary: {
          totalTrades: history.length,
          profitableTrades,
          losingTrades,
          totalProfitLoss,
          winRate,
          avgProfit,
        },
      };
    } catch (error: any) {
      this.logger.error(`Failed to get trade history: ${error?.message}`);
      throw new HttpException(
        error?.response?.data?.message || error?.message || 'Failed to get trade history',
        error?.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get market clock
   */
  @Get('clock')
  async getClock() {
    try {
      const clock = await this.alpacaService.getClock();
      return {
        success: true,
        data: clock,
      };
    } catch (error: any) {
      this.logger.error(`Failed to get clock: ${error?.message}`);
      throw new HttpException(
        error?.response?.data?.message || error?.message || 'Failed to get market clock',
        error?.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get trading calendar
   */
  @Get('calendar')
  async getCalendar(
    @Query('start') start?: string,
    @Query('end') end?: string,
  ) {
    try {
      const calendar = await this.alpacaService.getCalendar(start, end);
      return {
        success: true,
        data: calendar,
      };
    } catch (error: any) {
      this.logger.error(`Failed to get calendar: ${error?.message}`);
      throw new HttpException(
        error?.response?.data?.message || error?.message || 'Failed to get calendar',
        error?.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}

