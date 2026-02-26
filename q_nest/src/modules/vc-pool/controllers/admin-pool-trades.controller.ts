import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Query,
  Body,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { PoolTradingService } from '../services/pool-trading.service';
import { AdminJwtAuthGuard } from '../../admin-auth/guards/admin-jwt-auth.guard';
import { CurrentAdmin } from '../../admin-auth/decorators/current-admin.decorator';
import { AdminTokenPayload } from '../../admin-auth/services/admin-token.service';
import { ManualTradeDto } from '../dto/manual-trade.dto';
import { CloseTradeDto } from '../dto/close-trade.dto';

@Controller('admin/pools')
@UseGuards(AdminJwtAuthGuard)
export class AdminPoolTradesController {
  constructor(private readonly tradingService: PoolTradingService) {}

  @Post(':poolId/trades')
  async openTrade(
    @CurrentAdmin() admin: AdminTokenPayload,
    @Param('poolId', ParseUUIDPipe) poolId: string,
    @Body() dto: ManualTradeDto,
  ) {
    return this.tradingService.openTrade(admin.sub, poolId, dto);
  }

  @Get(':poolId/trades')
  async listTrades(
    @CurrentAdmin() admin: AdminTokenPayload,
    @Param('poolId', ParseUUIDPipe) poolId: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.tradingService.listTrades(admin.sub, poolId, {
      status,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Put(':poolId/trades/:tradeId/close')
  async closeTrade(
    @CurrentAdmin() admin: AdminTokenPayload,
    @Param('poolId', ParseUUIDPipe) poolId: string,
    @Param('tradeId', ParseUUIDPipe) tradeId: string,
    @Body() dto: CloseTradeDto,
  ) {
    return this.tradingService.closeTrade(admin.sub, poolId, tradeId, dto);
  }
}
