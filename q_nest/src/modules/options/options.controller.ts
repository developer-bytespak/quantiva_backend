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
import { OptionsIvService } from './services/options-iv.service';
import { OptionsSignalService } from './services/options-signal.service';
import { OptionsRiskService } from './services/options-risk.service';
import { PlaceOptionOrderDto, CancelOptionOrderDto, PlaceMultiLegOrderDto } from './dto/options.dto';

@Controller('options')
@UseGuards(JwtAuthGuard)
export class OptionsController {
  constructor(
    private readonly optionsService: OptionsService,
    private readonly ivService: OptionsIvService,
    private readonly signalService: OptionsSignalService,
    private readonly riskService: OptionsRiskService,
  ) {}

  // ── Market Data ──────────────────────────────────────────

  /**
   * GET /options/underlyings?connectionId=xxx
   * When a connectionId is supplied the underlying list is venue-scoped
   * (Binance crypto vs Alpaca equities). Without it, defaults to Binance
   * (backward-compat with the original unauthenticated public-data route).
   */
  @Get('underlyings')
  async getAvailableUnderlyings(
    @CurrentUser() user: TokenPayload,
    @Query('connectionId') connectionId?: string,
  ) {
    await this.optionsService.verifyEliteAccess(user.sub);
    return this.optionsService.getAvailableUnderlyings(user.sub, connectionId);
  }

  @Get('chain/:underlying')
  async getOptionsChain(
    @CurrentUser() user: TokenPayload,
    @Param('underlying') underlying: string,
    @Query('connectionId') connectionId?: string,
  ) {
    await this.optionsService.verifyEliteAccess(user.sub);
    return this.optionsService.getOptionsChain(
      underlying.toUpperCase(),
      user.sub,
      connectionId,
    );
  }

  @Get('greeks/:contractSymbol')
  async getGreeks(
    @CurrentUser() user: TokenPayload,
    @Param('contractSymbol') contractSymbol: string,
    @Query('connectionId') connectionId?: string,
  ) {
    await this.optionsService.verifyEliteAccess(user.sub);
    return this.optionsService.getGreeks(contractSymbol, user.sub, connectionId);
  }

  @Get('ticker/:contractSymbol')
  async getTicker(
    @CurrentUser() user: TokenPayload,
    @Param('contractSymbol') contractSymbol: string,
    @Query('connectionId') connectionId?: string,
  ) {
    await this.optionsService.verifyEliteAccess(user.sub);
    return this.optionsService.getTicker(contractSymbol, user.sub, connectionId);
  }

  @Get('depth/:contractSymbol')
  async getDepth(
    @CurrentUser() user: TokenPayload,
    @Param('contractSymbol') contractSymbol: string,
    @Query('limit') limit?: string,
    @Query('connectionId') connectionId?: string,
  ) {
    await this.optionsService.verifyEliteAccess(user.sub);
    return this.optionsService.getDepth(
      contractSymbol,
      limit ? parseInt(limit, 10) : undefined,
      user.sub,
      connectionId,
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

  /**
   * GET /options/approval-status?connectionId=xxx
   * Returns the user's options approval level for the venue. Binance always
   * reports Level 3 (no approval flow); Alpaca reports 0–3 depending on the
   * user's application status. Frontend uses this to gate multi-leg UI.
   */
  @Get('approval-status')
  async getApprovalStatus(
    @CurrentUser() user: TokenPayload,
    @Query('connectionId') connectionId: string,
  ) {
    await this.optionsService.verifyEliteAccess(user.sub);
    return this.optionsService.getApprovalStatus(connectionId, user.sub);
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
  async getPositionHistory(
    @CurrentUser() user: TokenPayload,
    @Query('venue') venue?: string,
  ) {
    await this.optionsService.verifyEliteAccess(user.sub);
    return this.optionsService.getPositionsFromDb(user.sub, venue);
  }

  /**
   * POST /options/positions/:positionId/exercise?connectionId=xxx
   * Early-exercise an option position (Alpaca only).
   */
  @Post('positions/:positionId/exercise')
  @HttpCode(HttpStatus.OK)
  async exercisePosition(
    @CurrentUser() user: TokenPayload,
    @Param('positionId') positionId: string,
    @Query('connectionId') connectionId: string,
  ) {
    await this.optionsService.verifyEliteAccess(user.sub);
    return this.optionsService.exerciseOptionPosition(user.sub, connectionId, positionId);
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
   * POST /options/orders/multi-leg
   * Place a multi-leg (mleg) Alpaca options order — up to 4 legs fill
   * atomically or not at all. Backend re-checks Level 3 approval and
   * returns 403 if the user's Alpaca account isn't approved for mleg,
   * regardless of what the frontend UI shows.
   */
  @Post('orders/multi-leg')
  @HttpCode(HttpStatus.CREATED)
  async placeMultiLegOrder(
    @CurrentUser() user: TokenPayload,
    @Body() dto: PlaceMultiLegOrderDto,
  ) {
    await this.optionsService.verifyEliteAccess(user.sub);
    return this.optionsService.placeMultiLegOrder(user.sub, dto);
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

  // ── IV Data ──────────────────────────────────────────────

  @Get('iv/rank/:underlying')
  async getIvRank(
    @CurrentUser() user: TokenPayload,
    @Param('underlying') underlying: string,
    @Query('venue') venue?: string,
  ) {
    await this.optionsService.verifyEliteAccess(user.sub);
    const v = venue?.toUpperCase() === 'ALPACA' ? 'ALPACA' : 'BINANCE';
    return this.ivService.getIvRankData(underlying.toUpperCase(), v);
  }

  @Get('iv/history/:underlying')
  async getIvHistory(
    @CurrentUser() user: TokenPayload,
    @Param('underlying') underlying: string,
    @Query('days') days?: string,
    @Query('venue') venue?: string,
  ) {
    await this.optionsService.verifyEliteAccess(user.sub);
    const v = venue?.toUpperCase() === 'ALPACA' ? 'ALPACA' : 'BINANCE';
    return this.ivService.getIvHistory(
      underlying.toUpperCase(),
      days ? parseInt(days, 10) : 90,
      v,
    );
  }

  // ── Risk / Portfolio ─────────────────────────────────────

  /**
   * GET /options/portfolio-greeks
   * Get aggregated Greeks across all open options positions.
   */
  @Get('portfolio-greeks')
  async getPortfolioGreeks(@CurrentUser() user: TokenPayload) {
    await this.optionsService.verifyEliteAccess(user.sub);
    return this.riskService.getPortfolioGreeks(user.sub);
  }

  // ── AI Signals ──────────────────────────────────────────

  @Get('ai-signals')
  async getAiSignals(
    @CurrentUser() user: TokenPayload,
    @Query('underlying') underlying?: string,
    @Query('limit') limit?: string,
    @Query('venue') venue?: string,
  ) {
    await this.optionsService.verifyEliteAccess(user.sub);
    const v =
      venue?.toUpperCase() === 'ALPACA'
        ? 'ALPACA'
        : venue?.toUpperCase() === 'BINANCE'
        ? 'BINANCE'
        : undefined;
    return this.signalService.getActiveSignals(
      underlying?.toUpperCase(),
      limit ? parseInt(limit, 10) : 20,
      v,
    );
  }

  @Get('ai-signals/:id')
  async getAiSignalById(
    @CurrentUser() user: TokenPayload,
    @Param('id') id: string,
  ) {
    await this.optionsService.verifyEliteAccess(user.sub);
    return this.signalService.getSignalById(id);
  }

  /**
   * POST /options/ai-signals/trigger
   * Manually fire the 6-hour signal generation cron (for testing).
   */
  @Post('ai-signals/trigger')
  @HttpCode(HttpStatus.OK)
  async triggerSignalGeneration(@CurrentUser() user: TokenPayload) {
    await this.optionsService.verifyEliteAccess(user.sub);
    await this.signalService.generateSignals();
    return { triggered: true };
  }
}
