import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { TradeFeesService } from './trade-fees.service';
import { AdminOrUserJwtGuard } from '../admin-auth/guards/admin-or-user-jwt.guard';

@Controller('trade-fees')
@UseGuards(AdminOrUserJwtGuard)
export class TradeFeesController {
  constructor(private readonly tradeFeesService: TradeFeesService) {}

  /** Current month fees for the authenticated user */
  @Get('my-fees')
  async getMyFees(@Req() req: any, @Query('month') month?: string) {
    const userId = req.user?.sub ?? req.subscriptionUser?.user_id;
    return this.tradeFeesService.getUserMonthlyFees(userId, month);
  }

  /** Monthly fee history */
  @Get('history')
  async getFeeHistory(@Req() req: any, @Query('limit') limit?: string) {
    const userId = req.user?.sub ?? req.subscriptionUser?.user_id;
    return this.tradeFeesService.getUserFeeHistory(userId, limit ? parseInt(limit, 10) : 6);
  }

  /** Outstanding fees check (used before cancellation) */
  @Get('outstanding')
  async getOutstanding(@Req() req: any) {
    const userId = req.user?.sub ?? req.subscriptionUser?.user_id;
    return this.tradeFeesService.getOutstandingFees(userId);
  }

  /** Fee preview calculator */
  @Get('preview')
  getPreview(@Query('trade_value') tradeValue: string) {
    return this.tradeFeesService.calculateFeePreview(parseFloat(tradeValue) || 0);
  }
}
