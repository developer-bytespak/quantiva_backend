import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { TokenPayload } from '../auth/services/token.service';
import { OptionsService } from './services/options.service';
import { PlaceOptionOrderDto, CancelOptionOrderDto } from './dto/options.dto';

@Controller('options')
@UseGuards(JwtAuthGuard)
export class OptionsController {
  constructor(private readonly optionsService: OptionsService) {}

  // ── Market Data ──────────────────────────────────────────

  /**
   * GET /options/underlyings?connectionId=xxx
   * Get all available underlying assets for options (dynamic, not hardcoded).
   */
  @Get('underlyings')
  async getAvailableUnderlyings(
    @CurrentUser() user: TokenPayload,
    @Query('connectionId') connectionId: string,
  ) {
    await this.optionsService.verifyEliteAccess(user.sub);
    return this.optionsService.getAvailableUnderlyings(connectionId, user.sub);
  }

  /**
   * GET /options/chain/:underlying?connectionId=xxx
   * Fetch full options chain for an underlying (BTC, ETH, SOL, etc.)
   */
  @Get('chain/:underlying')
  async getOptionsChain(
    @CurrentUser() user: TokenPayload,
    @Param('underlying') underlying: string,
    @Query('connectionId') connectionId: string,
  ) {
    await this.optionsService.verifyEliteAccess(user.sub);
    return this.optionsService.getOptionsChain(connectionId, user.sub, underlying.toUpperCase());
  }

  /**
   * GET /options/greeks/:contractSymbol?connectionId=xxx
   * Fetch Greeks for a specific option contract.
   */
  @Get('greeks/:contractSymbol')
  async getGreeks(
    @CurrentUser() user: TokenPayload,
    @Param('contractSymbol') contractSymbol: string,
    @Query('connectionId') connectionId: string,
  ) {
    await this.optionsService.verifyEliteAccess(user.sub);
    return this.optionsService.getGreeks(connectionId, user.sub, contractSymbol);
  }

  /**
   * GET /options/ticker/:contractSymbol?connectionId=xxx
   * Fetch 24hr ticker for a specific option contract.
   */
  @Get('ticker/:contractSymbol')
  async getTicker(
    @CurrentUser() user: TokenPayload,
    @Param('contractSymbol') contractSymbol: string,
    @Query('connectionId') connectionId: string,
  ) {
    await this.optionsService.verifyEliteAccess(user.sub);
    return this.optionsService.getTicker(connectionId, user.sub, contractSymbol);
  }

  /**
   * GET /options/depth/:contractSymbol?connectionId=xxx&limit=20
   * Fetch order book for an option contract.
   */
  @Get('depth/:contractSymbol')
  async getDepth(
    @CurrentUser() user: TokenPayload,
    @Param('contractSymbol') contractSymbol: string,
    @Query('connectionId') connectionId: string,
    @Query('limit') limit?: string,
  ) {
    await this.optionsService.verifyEliteAccess(user.sub);
    return this.optionsService.getDepth(
      connectionId,
      user.sub,
      contractSymbol,
      limit ? parseInt(limit, 10) : undefined,
    );
  }

  // ── Account ──────────────────────────────────────────────

  /**
   * GET /options/account?connectionId=xxx
   * Get options account balance.
   */
  @Get('account')
  async getBalance(
    @CurrentUser() user: TokenPayload,
    @Query('connectionId') connectionId: string,
  ) {
    await this.optionsService.verifyEliteAccess(user.sub);
    return this.optionsService.getBalance(connectionId, user.sub);
  }

  // ── Positions ────────────────────────────────────────────

  /**
   * GET /options/positions?connectionId=xxx
   * Get open options positions (live from Binance + synced to DB).
   */
  @Get('positions')
  async getPositions(
    @CurrentUser() user: TokenPayload,
    @Query('connectionId') connectionId: string,
  ) {
    await this.optionsService.verifyEliteAccess(user.sub);
    return this.optionsService.getPositions(connectionId, user.sub);
  }

  /**
   * GET /options/positions/history
   * Get historical positions from DB.
   */
  @Get('positions/history')
  async getPositionHistory(@CurrentUser() user: TokenPayload) {
    await this.optionsService.verifyEliteAccess(user.sub);
    return this.optionsService.getPositionsFromDb(user.sub);
  }

  // ── Orders ───────────────────────────────────────────────

  /**
   * POST /options/order
   * Place a new option order (manual — user confirmed).
   */
  @Post('order')
  @HttpCode(HttpStatus.CREATED)
  async placeOrder(
    @CurrentUser() user: TokenPayload,
    @Body() dto: PlaceOptionOrderDto,
  ) {
    await this.optionsService.verifyEliteAccess(user.sub);
    return this.optionsService.placeOrder(user.sub, dto);
  }

  /**
   * DELETE /options/order
   * Cancel an open option order.
   */
  @Delete('order')
  async cancelOrder(
    @CurrentUser() user: TokenPayload,
    @Body() dto: CancelOptionOrderDto,
  ) {
    await this.optionsService.verifyEliteAccess(user.sub);
    return this.optionsService.cancelOrder(user.sub, dto);
  }

  /**
   * GET /options/orders?status=pending&limit=50
   * Get user's option orders from DB.
   */
  @Get('orders')
  async getOrders(
    @CurrentUser() user: TokenPayload,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    await this.optionsService.verifyEliteAccess(user.sub);
    return this.optionsService.getOrders(
      user.sub,
      status,
      limit ? parseInt(limit, 10) : undefined,
    );
  }

  /**
   * GET /options/orders/live?connectionId=xxx&contractSymbol=BTC-260327-100000-C
   * Get open orders live from Binance.
   */
  @Get('orders/live')
  async getOpenOrdersLive(
    @CurrentUser() user: TokenPayload,
    @Query('connectionId') connectionId: string,
    @Query('contractSymbol') contractSymbol?: string,
  ) {
    await this.optionsService.verifyEliteAccess(user.sub);
    return this.optionsService.getOpenOrdersLive(connectionId, user.sub, contractSymbol);
  }

  // ── AI Recommendations ──────────────────────────────────

  /**
   * GET /options/recommendations?connectionId=xxx&underlying=BTC
   * Get AI-generated options recommendations based on latest signals.
   */
  @Get('recommendations')
  async getRecommendations(
    @CurrentUser() user: TokenPayload,
    @Query('connectionId') connectionId: string,
    @Query('underlying') underlying?: string,
  ) {
    await this.optionsService.verifyEliteAccess(user.sub);
    return this.optionsService.getRecommendations(connectionId, user.sub, underlying);
  }
}
