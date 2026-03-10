import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { AdminBinanceService } from '../services/admin-binance.service';
import { AdminJwtAuthGuard } from '../guards/admin-jwt-auth.guard';
import { CurrentAdmin } from '../decorators/current-admin.decorator';
import { AdminTokenPayload } from '../services/admin-token.service';
import { BinanceMarketStreamService } from '../../binance/binance-market-stream.service';
import { BinanceUserWsService } from '../../exchanges/services/binance-user-ws.service';

@Controller('admin/binance')
export class AdminBinanceController {
  constructor(
    private readonly adminBinanceService: AdminBinanceService,
    private readonly marketStream: BinanceMarketStreamService,
    private readonly userWsService: BinanceUserWsService,
  ) {}

  /**
   * Public stream health check — no auth required.
   * Returns only non-sensitive status (connected yes/no, symbol count, 3 sample prices).
   * @route GET /admin/binance/health
   */
  @Get('health')
  getStreamHealth() {
    const allPrices = this.marketStream.getAllPrices();
    const userWsStats = this.userWsService.getStats();

    return {
      marketStream: {
        connected: this.marketStream.isConnected(),
        symbolsTracked: allPrices.size,
        samplePrices: {
          BTCUSDT: allPrices.get('BTCUSDT') ?? null,
          ETHUSDT: allPrices.get('ETHUSDT') ?? null,
          BNBUSDT: allPrices.get('BNBUSDT') ?? null,
        },
      },
      userDataStream: {
        activeConnections: userWsStats.totalConnections,
      },
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Get Binance WebSocket stream health status (full detail, admin only)
   * @route GET /admin/binance/stream-status
   */
  @Get('stream-status')
  @UseGuards(AdminJwtAuthGuard)
  getStreamStatus() {
    const allPrices = this.marketStream.getAllPrices();
    const userWsStats = this.userWsService.getStats();

    return {
      success: true,
      data: {
        marketStream: {
          connected: this.marketStream.isConnected(),
          symbolsTracked: allPrices.size,
          samplePrices: {
            BTCUSDT: allPrices.get('BTCUSDT') ?? null,
            ETHUSDT: allPrices.get('ETHUSDT') ?? null,
            BNBUSDT: allPrices.get('BNBUSDT') ?? null,
          },
        },
        userDataStream: {
          activeConnections: userWsStats.totalConnections,
          connections: userWsStats.connections,
        },
        timestamp: new Date().toISOString(),
      },
    };
  }

  /**
   * Get admin's account balance and info
   * @route GET /admin/binance/account
   */
  @Get('account')
  async getAccountInfo(@CurrentAdmin() admin: AdminTokenPayload) {
    try {
      const accountInfo = await this.adminBinanceService.getAdminAccountInfo(admin.sub);

      return {
        success: true,
        data: accountInfo,
        last_updated: new Date().toISOString(),
      };
    } catch (error: any) {
      throw new BadRequestException(error.message);
    }
  }

  /**
   * Get admin's deposit history
   * @route GET /admin/binance/deposits
   */
  @Get('deposits')
  async getDepositHistory(
    @CurrentAdmin() admin: AdminTokenPayload,
    @Query('coin') coin?: string,
    @Query('status') status?: string,
    @Query('offset') offset: string = '0',
    @Query('limit') limit: string = '100',
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
  ) {
    try {
      const deposits = await this.adminBinanceService.getAdminDepositHistory(
        admin.sub,
        coin,
        status ? parseInt(status, 10) : undefined,
        parseInt(offset, 10),
        Math.min(parseInt(limit, 10), 1000),
        startTime ? parseInt(startTime, 10) : undefined,
        endTime ? parseInt(endTime, 10) : undefined,
      );

      return {
        success: true,
        data: deposits,
        count: deposits.length,
        last_updated: new Date().toISOString(),
      };
    } catch (error: any) {
      throw new BadRequestException(error.message);
    }
  }

  /**
   * Get admin's withdrawal history
   * @route GET /admin/binance/withdrawals
   */
  @Get('withdrawals')
  async getWithdrawalHistory(
    @CurrentAdmin() admin: AdminTokenPayload,
    @Query('coin') coin?: string,
    @Query('status') status?: string,
    @Query('offset') offset: string = '0',
    @Query('limit') limit: string = '100',
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
  ) {
    try {
      const withdrawals = await this.adminBinanceService.getAdminWithdrawalHistory(
        admin.sub,
        coin,
        status ? parseInt(status, 10) : undefined,
        parseInt(offset, 10),
        Math.min(parseInt(limit, 10), 1000),
        startTime ? parseInt(startTime, 10) : undefined,
        endTime ? parseInt(endTime, 10) : undefined,
      );

      return {
        success: true,
        data: withdrawals,
        count: withdrawals.length,
        last_updated: new Date().toISOString(),
      };
    } catch (error: any) {
      throw new BadRequestException(error.message);
    }
  }

  /**
   * Get admin's trade history for a symbol
   * @route GET /admin/binance/trades/:symbol
   */
  @Get('trades/:symbol')
  async getTradeHistory(
    @CurrentAdmin() admin: AdminTokenPayload,
    @Param('symbol') symbol: string,
    @Query('limit') limit: string = '50',
  ) {
    try {
      if (!symbol || symbol.length === 0) {
        throw new BadRequestException('Symbol is required');
      }

      const trades = await this.adminBinanceService.getAdminTradeHistory(
        admin.sub,
        symbol.toUpperCase(),
        Math.min(parseInt(limit, 10), 1000),
      );

      return {
        success: true,
        data: trades,
        count: trades.length,
        symbol: symbol.toUpperCase(),
        last_updated: new Date().toISOString(),
      };
    } catch (error: any) {
      throw new BadRequestException(error.message);
    }
  }

  /**
   * Get admin's Binance account summary
   * Returns deposits, withdrawals, account info, and aggregated stats
   * @route GET /admin/binance/summary
   */
  @Get('summary')
  async getBinanceSummary(
    @CurrentAdmin() admin: AdminTokenPayload,
    @Query('coin') coin?: string,
  ) {
    try {
      const summary = await this.adminBinanceService.getAdminBinanceSummary(admin.sub, coin);

      return {
        success: true,
        data: summary,
        last_updated: new Date().toISOString(),
      };
    } catch (error: any) {
      throw new BadRequestException(error.message);
    }
  }
}
