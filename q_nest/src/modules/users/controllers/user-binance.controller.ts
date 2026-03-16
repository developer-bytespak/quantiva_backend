import {
  Controller,
  Get,
  Query,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { UserBinanceService } from '../services/user-binance.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { TokenPayload } from '../../auth/services/token.service';

@Controller('users/binance')
export class UserBinanceController {
  constructor(
    private readonly userBinanceService: UserBinanceService,
  ) {}

  /**
   * Get user's Binance account balance and info
   * @route GET /users/binance/account
   */
  @Get('account')
  @UseGuards(JwtAuthGuard)
  async getAccountInfo(@CurrentUser() user: TokenPayload) {
    try {
      const accountInfo = await this.userBinanceService.getAccountInfo(user.sub);

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
   * Get user's Binance deposit history
   * @route GET /users/binance/deposits
   */
  @Get('deposits')
  @UseGuards(JwtAuthGuard)
  async getDepositHistory(
    @CurrentUser() user: TokenPayload,
    @Query('coin') coin?: string,
    @Query('status') status?: string,
    @Query('offset') offset: string = '0',
    @Query('limit') limit: string = '100',
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
  ) {
    try {
      const deposits = await this.userBinanceService.getDepositHistory(
        user.sub,
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
   * Get user's Binance withdrawal history
   * @route GET /users/binance/withdrawals
   */
  @Get('withdrawals')
  @UseGuards(JwtAuthGuard)
  async getWithdrawalHistory(
    @CurrentUser() user: TokenPayload,
    @Query('coin') coin?: string,
    @Query('status') status?: string,
    @Query('offset') offset: string = '0',
    @Query('limit') limit: string = '100',
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
  ) {
    try {
      const withdrawals = await this.userBinanceService.getWithdrawalHistory(
        user.sub,
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
   * Get user's Binance account summary
   * Returns deposits, withdrawals, account info, and aggregated stats
   * @route GET /users/binance/summary
   */
  @Get('summary')
  @UseGuards(JwtAuthGuard)
  async getBinanceSummary(
    @CurrentUser() user: TokenPayload,
    @Query('coin') coin?: string,
  ) {
    try {
      const summary = await this.userBinanceService.getBinanceSummary(user.sub, coin);

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
