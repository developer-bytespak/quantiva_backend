import { Injectable, Logger, ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { ExchangesService } from '../../exchanges/exchanges.service';
import { OptionsBinanceService } from './options-binance.service';
import { OptionsAlpacaService } from './options-alpaca.service';
import { IOptionsVenueService, OptionCredentials } from './options-venue.interface';
import { parseOccSymbol } from './alpaca/occ-symbol';
import { OptionsSignalService } from './options-signal.service';
import { TradeFeesService } from '../../trade-fees/trade-fees.service';
import {
  PlaceOptionOrderDto,
  PlaceMultiLegOrderDto,
  CancelOptionOrderDto,
  OptionsChainResponseDto,
  GreeksDto,
  OptionsAccountDto,
  OptionsPositionDto,
  OptionsOrderDto,
  OptionsRecommendationDto,
  AvailableUnderlyingDto,
  OptionTypeEnum,
} from '../dto/options.dto';
import axios from 'axios';
import { OPTIONS_RISK_CONFIG as RISK_CONFIG } from '../options.config';

// Use string literals that match the Prisma OptionType enum values
type OptionType = 'CALL' | 'PUT';
type OptionOrderStatus = 'submitting' | 'pending' | 'filled' | 'partially_filled' | 'cancelled' | 'rejected' | 'expired';
export type OptionsVenue = 'BINANCE' | 'ALPACA';

/**
 * Parse an OCC-21 option symbol into the DB-shape the mleg persistence
 * path needs (`strike`, `expiry` as Date, `optionType` as Prisma enum).
 * Wraps the stricter `parseOccSymbol` helper so we can surface a clean
 * BadRequestException at the edge rather than a generic Error.
 */
function parseLegOccForDb(
  occSymbol: string,
): { strike: number; expiry: Date; optionType: OptionType } {
  try {
    const parsed = parseOccSymbol(occSymbol);
    return {
      strike: parsed.strike,
      expiry: new Date(parsed.expiry),
      optionType: parsed.type === 'CALL' ? 'CALL' : 'PUT',
    };
  } catch (err: any) {
    throw new BadRequestException(
      `Invalid OCC option symbol for multi-leg order: ${occSymbol}`,
    );
  }
}

export interface ResolvedVenue {
  svc: IOptionsVenueService;
  venue: OptionsVenue;
  creds: OptionCredentials;
  isPaper: boolean;
  connection: any;
}

@Injectable()
export class OptionsService {
  private readonly logger = new Logger(OptionsService.name);
  private readonly pythonApiUrl =
    process.env.PYTHON_API_URL || 'http://localhost:8000';

  constructor(
    private readonly prisma: PrismaService,
    private readonly exchangesService: ExchangesService,
    private readonly optionsBinance: OptionsBinanceService,
    private readonly optionsAlpaca: OptionsAlpacaService,
    private readonly signalService: OptionsSignalService,
    private readonly tradeFeesService: TradeFeesService,
  ) {}

  // ── Helpers ──────────────────────────────────────────────

  // TTL cache for elite tier checks (30s) — avoids DB query on every request
  private eliteTierCache = new Map<string, { tier: string; expiresAt: number }>();

  /**
   * Verify user has ELITE_PLUS subscription (cached for 30s).
   */
  async verifyEliteAccess(userId: string): Promise<void> {
    const cached = this.eliteTierCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      if (cached.tier !== 'ELITE_PLUS') {
        throw new ForbiddenException('Options trading is available for ELITE Plus subscribers only');
      }
      return;
    }

    const user = await this.prisma.users.findUnique({
      where: { user_id: userId },
      select: { current_tier: true },
    });

    this.eliteTierCache.set(userId, {
      tier: user?.current_tier || '',
      expiresAt: Date.now() + 30_000,
    });

    if (!user || user.current_tier !== 'ELITE_PLUS') {
      throw new ForbiddenException('Options trading is available for ELITE Plus subscribers only');
    }
  }

  /**
   * Get decrypted credentials for a user's exchange connection.
   */
  private async getCredentials(connectionId: string) {
    return this.exchangesService.getDecryptedCredentials(connectionId);
  }

  /**
   * Verify connection belongs to user and points at a venue we support
   * for options trading (Binance crypto or Alpaca stocks).
   */
  private async verifyConnectionOwnership(connectionId: string, userId: string) {
    const connection = await this.exchangesService.getConnectionById(connectionId);
    if (!connection) {
      throw new NotFoundException('Exchange connection not found');
    }
    if (connection.user_id !== userId) {
      throw new ForbiddenException('You do not own this connection');
    }
    const exchangeName = (connection as any).exchange?.name?.toLowerCase() || '';
    const exchangeType = (connection as any).exchange?.type;
    const isBinanceCrypto = exchangeType === 'crypto' && exchangeName === 'binance';
    const isAlpacaStocks = exchangeType === 'stocks' && exchangeName === 'alpaca';
    if (!isBinanceCrypto && !isAlpacaStocks) {
      throw new ForbiddenException('Options trading is only supported on Binance (crypto) or Alpaca (stocks)');
    }
    return connection;
  }

  /**
   * Detect paper vs live from the Alpaca API key prefix.
   * Alpaca paper keys start with "PK", live keys start with "AK".
   * Mirrors the detection in AlpacaService so behavior is consistent.
   */
  private isAlpacaPaperKey(apiKey: string): boolean {
    return typeof apiKey === 'string' && apiKey.startsWith('PK');
  }

  /**
   * Resolve a connection id to a concrete venue adapter + decrypted credentials.
   * Used by every method that needs to hit a broker; branching lives here so
   * the rest of OptionsService stays venue-agnostic.
   */
  async resolveVenueService(
    connectionId: string,
    userId: string,
  ): Promise<ResolvedVenue> {
    const connection = await this.verifyConnectionOwnership(connectionId, userId);
    const creds = await this.exchangesService.getDecryptedCredentials(connectionId);
    const exchangeName = (connection as any).exchange?.name?.toLowerCase() || '';

    if (exchangeName === 'alpaca') {
      return {
        svc: this.optionsAlpaca,
        venue: 'ALPACA',
        creds,
        isPaper: this.isAlpacaPaperKey(creds.apiKey),
        connection,
      };
    }

    // default: binance
    return {
      svc: this.optionsBinance,
      venue: 'BINANCE',
      creds,
      isPaper: false,
      connection,
    };
  }

  // ── Market Data ──────────────────────────────────────────

  /**
   * Resolve the right venue service for a public-data call.
   *
   * Binance options market data is public (no creds). Alpaca options data
   * is gated behind APCA-* headers — we must pass a connection so we can
   * authenticate. When `connectionId` is provided we honor it and dispatch
   * via `resolveVenueService`; otherwise we fall back to Binance with null
   * credentials (preserves legacy behaviour for the unauthenticated
   * `/options/chain/:underlying` route).
   */
  private async resolveForMarketData(
    userId: string | undefined,
    connectionId: string | undefined,
  ): Promise<{ svc: IOptionsVenueService; creds: OptionCredentials | null }> {
    if (connectionId && userId) {
      const resolved = await this.resolveVenueService(connectionId, userId);
      return { svc: resolved.svc, creds: resolved.creds };
    }
    return { svc: this.optionsBinance, creds: null };
  }

  /**
   * Get all available underlying assets. If a connectionId+userId are
   * supplied we dispatch to the venue for that connection (Alpaca equities
   * vs Binance crypto); otherwise default to Binance.
   */
  async getAvailableUnderlyings(
    userId?: string,
    connectionId?: string,
  ): Promise<AvailableUnderlyingDto[]> {
    const { svc } = await this.resolveForMarketData(userId, connectionId);
    return svc.getAvailableUnderlyings();
  }

  async getOptionsChain(
    underlying: string,
    userId?: string,
    connectionId?: string,
  ): Promise<OptionsChainResponseDto> {
    const { svc, creds } = await this.resolveForMarketData(userId, connectionId);
    return svc.fetchOptionsChain(creds, underlying, userId);
  }

  async getGreeks(
    contractSymbol: string,
    userId?: string,
    connectionId?: string,
  ): Promise<GreeksDto> {
    const { svc, creds } = await this.resolveForMarketData(userId, connectionId);
    return svc.fetchGreeks(creds, contractSymbol, userId);
  }

  async getTicker(
    contractSymbol: string,
    userId?: string,
    connectionId?: string,
  ) {
    const { svc, creds } = await this.resolveForMarketData(userId, connectionId);
    return svc.fetchOptionTicker(creds, contractSymbol, userId);
  }

  async getDepth(
    contractSymbol: string,
    limit?: number,
    userId?: string,
    connectionId?: string,
  ) {
    const { svc, creds } = await this.resolveForMarketData(userId, connectionId);
    return svc.fetchOptionDepth(creds, contractSymbol, limit, userId);
  }

  // ── Account ──────────────────────────────────────────────

  async getBalance(
    connectionId: string,
    userId: string,
  ): Promise<OptionsAccountDto> {
    const resolved = await this.resolveVenueService(connectionId, userId);
    return resolved.svc.fetchBalance(resolved.creds, userId);
  }

  /** Options approval status (Alpaca Level 1–3; Binance returns Level 3). */
  async getApprovalStatus(
    connectionId: string,
    userId: string,
  ) {
    const resolved = await this.resolveVenueService(connectionId, userId);
    return {
      venue: resolved.venue,
      isPaper: resolved.isPaper,
      ...(await resolved.svc.getOptionsApprovalStatus(resolved.creds, userId)),
    };
  }

  // ── Positions ────────────────────────────────────────────

  async getPositions(
    connectionId: string,
    userId: string,
  ): Promise<OptionsPositionDto[]> {
    const resolved = await this.resolveVenueService(connectionId, userId);
    const positions = await resolved.svc.fetchPositions(resolved.creds, userId);

    this.syncPositionsToDb(userId, positions, resolved.venue).catch((err) =>
      this.logger.error(`Position sync failed: ${err.message}`),
    );

    return positions;
  }

  /**
   * Get positions from DB (for history / offline).
   * Maps raw snake_case Prisma rows to camelCase OptionsPositionDto shape
   * expected by the frontend.
   */
  async getPositionsFromDb(userId: string, venue?: string): Promise<OptionsPositionDto[]> {
    const rows = await this.prisma.options_positions.findMany({
      where: {
        user_id: userId,
        ...(venue ? { venue: venue as any } : {}),
      },
      orderBy: { opened_at: 'desc' },
    });

    return rows.map((p) => ({
      positionId: p.position_id,
      contractSymbol: p.contract_symbol,
      underlying: p.underlying,
      strike: Number(p.strike),
      expiry: p.expiry?.toISOString() ?? '',
      optionType: p.option_type as unknown as OptionTypeEnum,
      quantity: Number(p.quantity),
      avgPremium: Number(p.avg_premium),
      currentPremium: Number(p.current_premium) || 0,
      unrealizedPnl: Number(p.unrealized_pnl) || 0,
      realizedPnl: Number(p.realized_pnl) || 0,
      greeks: {
        delta: Number(p.delta) || 0,
        gamma: Number(p.gamma) || 0,
        theta: Number(p.theta) || 0,
        vega: Number(p.vega) || 0,
      },
      isOpen: p.is_open,
      venue: p.venue as string,
    }));
  }

  // Per-user mutex to prevent concurrent sync race conditions
  private syncLocks = new Map<string, Promise<void>>();

  private async syncPositionsToDb(userId: string, positions: OptionsPositionDto[], venue: string = 'BINANCE') {
    // Serialize sync calls per user to prevent race conditions
    const existing = this.syncLocks.get(userId) || Promise.resolve();
    const next = existing
      .then(() => this._doPositionSync(userId, positions, venue))
      .catch((err) => this.logger.error(`Position sync failed for ${userId}: ${err.message}`))
      .finally(() => {
        // Clean up lock if this is still the latest promise for this user
        if (this.syncLocks.get(userId) === next) {
          this.syncLocks.delete(userId);
        }
      });
    this.syncLocks.set(userId, next);
    return next;
  }

  private async _doPositionSync(userId: string, positions: OptionsPositionDto[], venue: string = 'BINANCE') {
    const activeSymbols = positions.map((p) => p.contractSymbol);

    await this.prisma.$transaction(async (tx) => {
      // Upsert each position (batch within single transaction)
      for (const pos of positions) {
        let optionType: OptionType;
        let expiryDate: Date;

        if (venue === 'ALPACA') {
          const parsed = parseOccSymbol(pos.contractSymbol);
          optionType = parsed.type === 'CALL' ? 'CALL' : 'PUT';
          expiryDate = this.parseExpiryToDate(parsed.expiry.replace(/-/g, ''));
        } else {
          const parts = pos.contractSymbol.split('-');
          optionType = parts[3] === 'C' ? 'CALL' : 'PUT';
          expiryDate = this.parseExpiryToDate(parts[1]);
        }

        // Find existing open position for this user+contract
        const existingPos = await tx.options_positions.findFirst({
          where: {
            user_id: userId,
            contract_symbol: pos.contractSymbol,
            is_open: true,
          },
        });

        if (existingPos) {
          await tx.options_positions.update({
            where: { position_id: existingPos.position_id },
            data: {
              current_premium: pos.currentPremium,
              unrealized_pnl: pos.unrealizedPnl,
              realized_pnl: pos.realizedPnl || 0,
              delta: pos.greeks?.delta ?? 0,
              gamma: pos.greeks?.gamma ?? 0,
              theta: pos.greeks?.theta ?? 0,
              vega: pos.greeks?.vega ?? 0,
              quantity: pos.quantity,
            },
          });
        } else {
          await tx.options_positions.create({
            data: {
              user_id: userId,
              contract_symbol: pos.contractSymbol,
              underlying: pos.underlying,
              strike: pos.strike,
              expiry: expiryDate,
              option_type: optionType,
              quantity: pos.quantity,
              avg_premium: pos.avgPremium,
              current_premium: pos.currentPremium,
              unrealized_pnl: pos.unrealizedPnl,
              realized_pnl: pos.realizedPnl || 0,
              delta: pos.greeks?.delta ?? 0,
              gamma: pos.greeks?.gamma ?? 0,
              theta: pos.greeks?.theta ?? 0,
              vega: pos.greeks?.vega ?? 0,
              is_open: true,
              venue: venue as any,
            },
          });
        }
      }

      // Mark positions as closed if no longer in live positions.
      // Scope to the same venue so Binance sync never closes Alpaca positions
      // and vice versa — a user may have both venues active simultaneously.
      const closingPositions = await tx.options_positions.findMany({
        where: {
          user_id: userId,
          is_open: true,
          venue: venue as any,
          ...(activeSymbols.length > 0 ? { contract_symbol: { notIn: activeSymbols } } : {}),
        },
        select: { position_id: true, unrealized_pnl: true, realized_pnl: true },
      });

      const closedAt = new Date();
      for (const pos of closingPositions) {
        await tx.options_positions.update({
          where: { position_id: pos.position_id },
          data: {
            is_open: false,
            closed_at: closedAt,
            realized_pnl: pos.realized_pnl ?? pos.unrealized_pnl ?? 0,
            unrealized_pnl: 0,
          },
        });
      }
    });

    // Check recently closed positions for performance fees (AI-driven profitable closes)
    this.recordPerformanceFeesForClosedPositions(userId).catch((err) =>
      this.logger.warn(`Performance fee recording failed: ${err.message}`),
    );
  }

  /**
   * Record performance fees for recently closed profitable AI-driven positions.
   * Only charges if: position is profitable AND was triggered by an AI signal.
   */
  private async recordPerformanceFeesForClosedPositions(userId: string): Promise<void> {
    const recentlyClosed = await this.prisma.options_positions.findMany({
      where: {
        user_id: userId,
        is_open: false,
        closed_at: { gte: new Date(Date.now() - 120_000) }, // closed in last 2 minutes
      },
      include: { originating_order: { select: { signal_id: true } } },
    });

    for (const pos of recentlyClosed) {
      const realizedPnl = Number(pos.realized_pnl);
      if (realizedPnl <= 0) continue; // No fee on loss/breakeven
      if (!pos.originating_order?.signal_id) continue; // Only AI-driven trades

      // Check if we already recorded a performance fee for this position
      const existing = await this.prisma.trade_fees.findFirst({
        where: {
          trade_reference_id: pos.position_id,
          source: 'options_performance',
        },
      });
      if (existing) continue;

      const feePercent = this.calculatePerformanceFeeRate(realizedPnl);
      await this.tradeFeesService.recordTradeFee({
        userId,
        tradeReferenceId: pos.position_id,
        assetSymbol: pos.underlying,
        tradeSide: 'CLOSE',
        tradeValueUsd: realizedPnl,
        feePercent,
        source: 'options_performance',
      });
      this.logger.log(
        `Performance fee recorded: ${pos.underlying} PnL=$${realizedPnl.toFixed(2)} fee=${(feePercent * 100).toFixed(1)}%`,
      );
    }
  }

  private calculatePerformanceFeeRate(profit: number): number {
    if (profit < 100) return 0.005;   // 0.5%
    if (profit < 1000) return 0.01;   // 1%
    if (profit < 10000) return 0.02;  // 2%
    return 0.03;                       // 3%
  }

  // ── Orders ───────────────────────────────────────────────

  /**
   * Throws BadRequestException if called outside Alpaca's Regular Trading Hours
   * (09:30–16:00 ET, Mon–Fri). Alpaca rejects off-hours option orders server-side
   * anyway, but we catch it here first to return a clean, user-friendly message.
   */
  private assertAlpacaMarketOpen(): void {
    const now = new Date();
    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const day = et.getDay(); // 0 = Sun, 6 = Sat
    if (day === 0 || day === 6) {
      throw new BadRequestException(
        'Alpaca options orders are not accepted on weekends. Markets resume Monday 09:30 ET.',
      );
    }
    const minutes = et.getHours() * 60 + et.getMinutes();
    const open = 9 * 60 + 30;  // 09:30
    const close = 16 * 60;     // 16:00
    if (minutes < open || minutes >= close) {
      throw new BadRequestException(
        'Alpaca options orders are only accepted during Regular Trading Hours (09:30–16:00 ET, Mon–Fri).',
      );
    }
  }

  /**
   * Place an option order with risk checks. Dispatches to the correct venue
   * adapter (Binance or Alpaca) based on the connection's exchange.
   */
  async placeOrder(
    userId: string,
    dto: PlaceOptionOrderDto,
  ): Promise<OptionsOrderDto> {
    // 1. Resolve the venue (also verifies ownership + decrypts creds)
    const resolved = await this.resolveVenueService(dto.connectionId, userId);

    // 1a. Alpaca options only trade during RTH — reject off-hours requests
    //     before touching the exchange so the user gets a clean error message.
    if (resolved.venue === 'ALPACA') {
      this.assertAlpacaMarketOpen();
    }

    // 2. Validate signal not expired (if order linked to a signal)
    if (dto.signalId) {
      try {
        await this.signalService.validateSignalNotExpired(dto.signalId);
      } catch (err: any) {
        throw new BadRequestException(err.message);
      }
    }

    // 3. Sell-to-close validation (no naked option writing).
    //    Matches on contract_symbol literally — works for both Binance's
    //    dash format and Alpaca's OCC format since we store whatever the
    //    caller sends.
    if (dto.side === 'SELL') {
      const openPosition = await this.prisma.options_positions.findFirst({
        where: {
          user_id: userId,
          contract_symbol: dto.contractSymbol,
          is_open: true,
        },
        select: { quantity: true },
      });

      if (!openPosition) {
        throw new BadRequestException(
          'Cannot sell — you have no open position for this contract. Only sell-to-close is allowed.',
        );
      }

      const positionQty = Number(openPosition.quantity);
      if (dto.quantity > positionQty) {
        throw new BadRequestException(
          `Cannot sell ${dto.quantity} contracts — you only hold ${positionQty}. Reduce quantity to close partially or fully.`,
        );
      }
    }

    // 4. Risk checks (Binance-only; Alpaca has its own server-side
    //    buying-power checks we rely on).
    if (resolved.venue === 'BINANCE') {
      await this.performRiskChecks(userId, dto, resolved.creds);
    }

    // 5. Max loss (premium × qty × multiplier for long side; short is more
    //    complex and left null for the venue/broker to enforce).
    const maxLoss =
      dto.side === 'BUY'
        ? dto.price * dto.quantity * resolved.svc.contractMultiplier
        : null;

    // 6. Greeks snapshot — best-effort.
    let greeksSnapshot = null;
    try {
      greeksSnapshot = await resolved.svc.fetchGreeks(
        resolved.creds,
        dto.contractSymbol,
        userId,
      );
    } catch {
      this.logger.warn('Could not fetch Greeks snapshot before order placement');
    }

    // 7. Resolve option type + expiry date without depending on Binance's
    //    dash format. Prefer the DTO values the client already provides.
    const optionType: OptionType = dto.optionType === OptionTypeEnum.CALL ? 'CALL' : 'PUT';
    const expiryDate = new Date(dto.expiry);

    // 8. Create DB record with 'submitting' status + venue tag.
    const dbOrder = await this.prisma.options_orders.create({
      data: {
        user_id: userId,
        signal_id: dto.signalId || null,
        contract_symbol: dto.contractSymbol,
        underlying: dto.underlying,
        strike: dto.strike,
        expiry: expiryDate,
        option_type: optionType,
        side: dto.side,
        quantity: dto.quantity,
        price: dto.price,
        filled_quantity: 0,
        avg_fill_price: null,
        fee: null,
        binance_order_id: null,
        broker_order_id: null,
        venue: resolved.venue,
        status: 'submitting',
        max_loss: maxLoss,
        greeks_at_entry: greeksSnapshot as any,
      },
    });

    // 9. Place on the venue.
    let venueOrder: any;
    try {
      venueOrder = await resolved.svc.placeOptionOrder(
        resolved.creds,
        dto.contractSymbol,
        dto.side.toLowerCase() as 'buy' | 'sell',
        dto.quantity,
        dto.price,
        userId,
      );
    } catch (exchangeError) {
      await this.prisma.options_orders.update({
        where: { order_id: dbOrder.order_id },
        data: { status: 'rejected' },
      });
      throw exchangeError;
    }

    const brokerId = (venueOrder?.orderId || venueOrder?.id)?.toString() || null;

    // 10. Update DB with exchange response.
    let updatedOrder: any;
    try {
      updatedOrder = await this.prisma.options_orders.update({
        where: { order_id: dbOrder.order_id },
        data: {
          // Keep binance_order_id populated for Binance for back-compat with
          // older queries; broker_order_id holds the ID for any venue.
          binance_order_id: resolved.venue === 'BINANCE' ? brokerId : null,
          broker_order_id: brokerId,
          status: this.mapOrderStatus(venueOrder.status),
          filled_quantity: parseFloat(venueOrder.executedQty || venueOrder.filled || '0'),
          avg_fill_price: parseFloat(venueOrder.avgPrice || venueOrder.average || '0') || null,
          fee: parseFloat(venueOrder.fee || '0') || null,
        },
      });
    } catch (dbErr: any) {
      this.logger.error(
        `DB update failed for order ${dbOrder.order_id}, venue=${resolved.venue} broker_id=${brokerId}. Manual reconciliation needed: ${dbErr.message}`,
      );
      const fallback = this.mapDbOrderToDto(dbOrder);
      fallback.binanceOrderId = brokerId || '';
      return fallback;
    }

    this.logger.log(
      `Options order placed (${resolved.venue}): ${dbOrder.order_id} broker=${brokerId}`,
    );

    // 11. Platform execution fee (0.03%) on filled orders. Both venues'
    //     fill notional is (filled_qty × avg_fill_price × multiplier).
    const orderStatus = updatedOrder?.status ?? dbOrder.status;
    if (['filled', 'partially_filled'].includes(orderStatus)) {
      const fillQty = Number(updatedOrder?.filled_quantity ?? 0);
      const fillPrice = Number(updatedOrder?.avg_fill_price ?? 0);
      const fillValue = fillQty * fillPrice * resolved.svc.contractMultiplier;
      if (fillValue > 0) {
        this.tradeFeesService.recordTradeFee({
          userId,
          tradeReferenceId: dbOrder.order_id,
          assetSymbol: dto.underlying,
          tradeSide: dto.side,
          tradeValueUsd: fillValue,
          feePercent: 0.0003,
          source: 'options_execution',
        }).catch((err) => this.logger.warn(`Failed to record execution fee: ${err.message}`));
      }
    }

    return this.mapDbOrderToDto(updatedOrder ?? dbOrder);
  }

  /**
   * Place a multi-leg (mleg) options order — Alpaca only for now.
   * Persists one `options_orders` row per leg sharing a `group_id`, all
   * tagged `venue=ALPACA`. The backend re-checks Level 3 approval before
   * forwarding to Alpaca so a missing-approval bypass returns 403 rather
   * than a cryptic Alpaca rejection.
   */
  async placeMultiLegOrder(
    userId: string,
    dto: PlaceMultiLegOrderDto,
  ): Promise<{ groupId: string; brokerOrderId: string; legs: any[]; status: string }> {
    const resolved = await this.resolveVenueService(dto.connectionId, userId);

    if (resolved.venue !== 'ALPACA') {
      throw new BadRequestException(
        'Multi-leg (mleg) orders are only supported on Alpaca. Binance users should place each leg individually.',
      );
    }

    // RTH guard — same as single-leg path.
    this.assertAlpacaMarketOpen();

    // Defense-in-depth: re-check approval level even though the UI already
    // gates this button — a hand-crafted request could try to bypass.
    const approval = await resolved.svc.getOptionsApprovalStatus(resolved.creds, userId);
    if (approval.level < 3) {
      throw new ForbiddenException(
        `Multi-leg strategies require Alpaca options Level 3 approval. Your account is currently at Level ${approval.level}.`,
      );
    }

    if (!Array.isArray(dto.legs) || dto.legs.length < 2 || dto.legs.length > 4) {
      throw new BadRequestException('Multi-leg orders require 2–4 legs');
    }

    if (dto.signalId) {
      try {
        await this.signalService.validateSignalNotExpired(dto.signalId);
      } catch (err: any) {
        throw new BadRequestException(err.message);
      }
    }

    // Persist one row per leg, pre-trade, sharing a group_id so the UI can
    // group them. Rows are marked `submitting`; after the broker response
    // we update with broker_order_id + status.
    const groupId = randomUUID();
    const legRows = await Promise.all(
      dto.legs.map((leg) => {
        const parsed = parseLegOccForDb(leg.contractSymbol);
        return this.prisma.options_orders.create({
          data: {
            user_id: userId,
            signal_id: dto.signalId || null,
            contract_symbol: leg.contractSymbol,
            underlying: dto.underlying,
            strike: parsed.strike,
            expiry: parsed.expiry,
            option_type: parsed.optionType,
            side: leg.side.toUpperCase(),
            quantity: dto.qty * leg.ratioQty,
            price: dto.limitPrice ?? null,
            venue: 'ALPACA',
            group_id: groupId,
            position_intent: leg.positionIntent,
            status: 'submitting',
          },
        });
      }),
    );

    try {
      const order = await resolved.svc.placeMultiLegOrder(
        resolved.creds,
        {
          underlying: dto.underlying,
          qty: dto.qty,
          type: dto.type,
          limitPrice: dto.limitPrice,
          timeInForce: dto.timeInForce,
          legs: dto.legs.map((l) => ({
            contractSymbol: l.contractSymbol,
            side: l.side,
            ratioQty: l.ratioQty,
            positionIntent: l.positionIntent,
          })),
        },
        userId,
      );

      const brokerId = (order?.orderId || order?.id)?.toString() || null;
      const mapped = this.mapOrderStatus(order?.status);

      await this.prisma.options_orders.updateMany({
        where: { group_id: groupId },
        data: {
          broker_order_id: brokerId,
          status: mapped,
        },
      });

      this.logger.log(`Multi-leg order placed (Alpaca): group=${groupId} broker=${brokerId}`);
      return {
        groupId,
        brokerOrderId: brokerId ?? '',
        legs: legRows.map((r) => r.order_id),
        status: mapped,
      };
    } catch (error) {
      await this.prisma.options_orders.updateMany({
        where: { group_id: groupId },
        data: { status: 'rejected' },
      });
      throw error;
    }
  }

  /**
   * Cancel an option order. Uses the stored venue on the DB row to route
   * to the right adapter so a single connectionId doesn't pin us to one
   * venue (e.g. user switches active connection between submit and cancel).
   */
  async cancelOrder(
    userId: string,
    dto: CancelOptionOrderDto,
  ): Promise<{ success: boolean; message: string }> {
    const resolved = await this.resolveVenueService(dto.connectionId, userId);

    // Match on any identifier the client might have handed us.
    const dbOrder = await this.prisma.options_orders.findFirst({
      where: {
        user_id: userId,
        OR: [
          { order_id: dto.orderId },
          { binance_order_id: dto.orderId },
          { broker_order_id: dto.orderId },
        ],
      },
    });

    if (!dbOrder) {
      throw new NotFoundException('Order not found');
    }

    const brokerId =
      dbOrder.broker_order_id || dbOrder.binance_order_id || dto.orderId;

    await resolved.svc.cancelOptionOrder(
      resolved.creds,
      dto.contractSymbol,
      brokerId,
      userId,
    );

    // Cancel every leg sharing a group_id so mleg orders update as a unit.
    if (dbOrder.group_id) {
      await this.prisma.options_orders.updateMany({
        where: { group_id: dbOrder.group_id },
        data: { status: 'cancelled' },
      });
    } else {
      await this.prisma.options_orders.update({
        where: { order_id: dbOrder.order_id },
        data: { status: 'cancelled' },
      });
    }

    return { success: true, message: `Order ${dbOrder.order_id} cancelled` };
  }

  /**
   * Exercise an option position (Alpaca only).
   * Alpaca's early-exercise endpoint: POST /v2/positions/{symbolOrId}/exercise
   */
  async exerciseOptionPosition(
    userId: string,
    connectionId: string,
    positionIdOrSymbol: string,
  ): Promise<any> {
    const resolved = await this.resolveVenueService(connectionId, userId);
    if (resolved.venue !== 'ALPACA') {
      throw new BadRequestException('Exercise is only supported for Alpaca positions');
    }
    if (!resolved.svc.exercisePosition) {
      throw new BadRequestException('Exercise not implemented for this venue');
    }
    return resolved.svc.exercisePosition(resolved.creds, positionIdOrSymbol, userId);
  }

  /**
   * Get user's option orders from DB, scoped to a venue when provided.
   */
  async getOrders(
    userId: string,
    status?: string,
    limit: number = 50,
    venue?: string,
  ) {
    const where: any = { user_id: userId };
    if (status) where.status = status;
    if (venue) where.venue = venue;

    const orders = await this.prisma.options_orders.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: limit,
    });

    return orders.map((o) => this.mapDbOrderToDto(o));
  }

  /**
   * Get open orders live from the venue behind the connection.
   */
  async getOpenOrdersLive(
    connectionId: string,
    userId: string,
    contractSymbol?: string,
  ) {
    const resolved = await this.resolveVenueService(connectionId, userId);
    return resolved.svc.fetchOpenOrders(resolved.creds, contractSymbol, userId);
  }

  // ── AI Recommendations ──────────────────────────────────

  /**
   * Get AI-generated options recommendations based on latest signals.
   * Calls the Python options engine.
   */
  async getRecommendations(
    connectionId: string,
    userId: string,
    underlying?: string,
  ): Promise<OptionsRecommendationDto[]> {
    await this.verifyConnectionOwnership(connectionId, userId);
    const credentials = await this.getCredentials(connectionId);

    // 1. Get user's latest signals (active strategies)
    const signals = await this.prisma.strategy_signals.findMany({
      where: {
        user_id: userId,
        action: { in: ['BUY', 'SELL'] },
      },
      orderBy: { timestamp: 'desc' },
      take: 10,
      include: { asset: true, strategy: true },
    });

    if (signals.length === 0) {
      return [];
    }

    // 2. For each signal with a matching underlying, get options chain + call Python engine
    const recommendations: OptionsRecommendationDto[] = [];

    for (const signal of signals) {
      const assetSymbol = signal.asset?.symbol || '';
      // Extract base symbol (e.g. BTCUSDT → BTC)
      const baseSymbol = assetSymbol.replace(/USDT?$/, '').toUpperCase();

      if (underlying && baseSymbol !== underlying.toUpperCase()) continue;

      try {
        // Fetch options chain for this underlying
        const chain = await this.optionsBinance.fetchOptionsChain(
          credentials,
          baseSymbol,
          userId,
        );

        if (chain.contracts.length === 0) continue;

        // Call Python options engine
        const response = await axios.post(
          `${this.pythonApiUrl}/api/v1/options/recommend`,
          {
            signal: {
              signal_id: signal.signal_id,
              asset_symbol: assetSymbol,
              action: signal.action,
              final_score: signal.final_score ? Number(signal.final_score) : 0,
              confidence: signal.confidence ? Number(signal.confidence) : 0,
              sentiment_score: signal.sentiment_score ? Number(signal.sentiment_score) : 0,
              trend_score: signal.trend_score ? Number(signal.trend_score) : 0,
              risk_level: signal.strategy?.risk_level || 'medium',
              timeframe: signal.strategy?.timeframe || '1d',
            },
            options_chain: {
              underlying: baseSymbol,
              underlying_price: chain.underlyingPrice,
              contracts: chain.contracts.map((c) => ({
                symbol: c.symbol,
                strike: c.strike,
                expiry: c.expiry,
                type: c.type,
                bid_price: c.bidPrice,
                ask_price: c.askPrice,
                mark_price: c.markPrice,
                volume: c.volume,
                open_interest: c.openInterest,
                greeks: c.greeks,
                contract_size: c.contractSize,
              })),
            },
            portfolio_value: null, // Will be set by Python engine if needed
          },
          {
            timeout: 15000,
            headers: { 'X-Internal-Api-Key': process.env.INTERNAL_API_KEY },
          },
        );

        if (response.data?.recommendation) {
          const rec = response.data.recommendation;
          recommendations.push({
            signalId: signal.signal_id,
            assetSymbol,
            signalAction: signal.action,
            signalConfidence: signal.confidence ? Number(signal.confidence) : 0,
            finalScore: signal.final_score ? Number(signal.final_score) : 0,
            recommendedType: rec.option_type === 'CALL' ? OptionTypeEnum.CALL : OptionTypeEnum.PUT,
            recommendedStrike: rec.strike,
            recommendedExpiry: rec.expiry,
            estimatedPremium: rec.estimated_premium,
            maxLoss: rec.max_loss,
            recommendedQuantity: rec.quantity,
            ivRank: rec.iv_rank,
            ivValue: rec.iv_value,
            greeks: rec.greeks,
            liquidityOk: rec.liquidity_ok,
            reasoning: rec.reasoning,
            confidenceAdjustment: rec.confidence_adjustment,
          });

          // Save to DB
          await this.prisma.options_signals.create({
            data: {
              signal_id: signal.signal_id,
              recommended_type: rec.option_type === 'CALL' ? 'CALL' as OptionType : 'PUT' as OptionType,
              recommended_strike: rec.strike,
              recommended_expiry: new Date(rec.expiry),
              iv_rank: rec.iv_rank,
              iv_value: rec.iv_value,
              estimated_premium: rec.estimated_premium,
              max_loss: rec.max_loss,
              recommended_qty: rec.quantity,
              greeks_snapshot: rec.greeks,
              liquidity_ok: rec.liquidity_ok,
              reasoning: rec.reasoning,
              confidence_adjustment: rec.confidence_adjustment,
            },
          });
        }
      } catch (error: any) {
        this.logger.warn(
          `Options recommendation failed for ${assetSymbol}: ${error.message}`,
        );
      }
    }

    return recommendations;
  }

  // ── Risk Checks ──────────────────────────────────────────

  private async performRiskChecks(
    userId: string,
    dto: PlaceOptionOrderDto,
    credentials: { apiKey: string; apiSecret: string },
  ): Promise<void> {
    // 1. Max open positions check — scoped to Binance so Alpaca positions
    //    don't consume the Binance user's position budget.
    const openPositionCount = await this.prisma.options_positions.count({
      where: { user_id: userId, is_open: true, venue: 'BINANCE' },
    });

    if (openPositionCount >= RISK_CONFIG.MAX_OPEN_POSITIONS) {
      throw new BadRequestException(
        `Maximum ${RISK_CONFIG.MAX_OPEN_POSITIONS} open options positions reached`,
      );
    }

    // Note: 5% premium cap removed — Binance will reject if insufficient balance
    // Note: SELL margin check removed — sell-to-close only enforced in placeOrder() + Binance reduceOnly

    // 4. IV rank check for buy orders — warn at threshold, hard block at higher threshold
    if (dto.side === 'BUY') {
      try {
        const greeks = await this.optionsBinance.fetchGreeks(
          credentials,
          dto.contractSymbol,
          userId,
        );
        if (greeks.impliedVolatility) {
          if (greeks.impliedVolatility > RISK_CONFIG.IV_RANK_HARD_BLOCK) {
            throw new BadRequestException(
              `IV too high (${(greeks.impliedVolatility * 100).toFixed(1)}%) — buying options when IV rank > ${(RISK_CONFIG.IV_RANK_HARD_BLOCK * 100).toFixed(0)}% is blocked. Consider selling premium instead.`,
            );
          }
          if (greeks.impliedVolatility > RISK_CONFIG.MAX_IV_RANK_FOR_BUY) {
            this.logger.warn(
              `High IV warning for ${dto.contractSymbol}: IV=${greeks.impliedVolatility}`,
            );
          }
        }
      } catch (err: any) {
        if (err instanceof BadRequestException) throw err;
        this.logger.warn('Could not check IV rank for risk validation');
      }
    }

    // 4. Expiry proximity warning
    const parts = dto.contractSymbol.split('-');
    const expiryDate = this.parseExpiryToDate(parts[1]);
    const hoursToExpiry = (expiryDate.getTime() - Date.now()) / (1000 * 60 * 60);
    if (hoursToExpiry < RISK_CONFIG.EXPIRY_WARNING_HOURS) {
      this.logger.warn(
        `Contract ${dto.contractSymbol} expires in ${hoursToExpiry.toFixed(1)} hours`,
      );
    }
  }

  // ── Utility ──────────────────────────────────────────────

  /**
   * Parse YYMMDD format to Date.
   */
  private parseExpiryToDate(yymmdd: string): Date {
    const yy = parseInt(yymmdd.substring(0, 2), 10);
    const mm = parseInt(yymmdd.substring(2, 4), 10);
    const dd = parseInt(yymmdd.substring(4, 6), 10);
    return new Date(2000 + yy, mm - 1, dd, 8, 0, 0); // 08:00 UTC is typical Binance expiry
  }

  private mapOrderStatus(binanceStatus: string): any {
    const statusMap: Record<string, string> = {
      // ccxt unified statuses
      open: 'pending',
      closed: 'filled',
      // Binance eapi native statuses
      accepted: 'pending',
      partially_filled: 'partially_filled',
      filled: 'filled',
      canceled: 'cancelled',
      cancelled: 'cancelled',
      rejected: 'rejected',
      expired: 'expired',
    };
    return statusMap[binanceStatus?.toLowerCase()] || 'pending';
  }

  private mapDbOrderToDto(order: any): OptionsOrderDto {
    return {
      orderId: order.order_id,
      contractSymbol: order.contract_symbol,
      underlying: order.underlying,
      strike: Number(order.strike),
      expiry: order.expiry?.toISOString() || '',
      optionType: order.option_type === 'CALL' ? OptionTypeEnum.CALL : OptionTypeEnum.PUT,
      side: order.side,
      quantity: Number(order.quantity),
      price: Number(order.price || 0),
      filledQuantity: Number(order.filled_quantity || 0),
      avgFillPrice: Number(order.avg_fill_price || 0),
      fee: Number(order.fee || 0),
      status: order.status,
      binanceOrderId: order.binance_order_id || '',
      maxLoss: Number(order.max_loss || 0),
      createdAt: order.created_at?.toISOString() || '',
    };
  }

  // ── Sync pending order statuses from Binance (runs every 10 min) ──

  @Cron(CronExpression.EVERY_10_MINUTES)
  async syncPendingOrderStatuses(): Promise<void> {
    const pendingStatuses: OptionOrderStatus[] = ['submitting', 'pending', 'partially_filled'];
    const pendingOrders = await this.prisma.options_orders.findMany({
      where: { status: { in: pendingStatuses } },
      select: {
        order_id: true,
        user_id: true,
        contract_symbol: true,
        binance_order_id: true,
        expiry: true,
      },
    });

    if (pendingOrders.length === 0) return;

    const now = new Date();
    let expiredCount = 0;
    let syncedCount = 0;

    for (const order of pendingOrders) {
      // 1. If the contract has already expired, mark order expired (Binance auto-cancels at settlement)
      if (order.expiry && order.expiry < now) {
        await this.prisma.options_orders.update({
          where: { order_id: order.order_id },
          data: { status: 'expired' },
        });
        expiredCount++;
        continue;
      }

      // 2. Live sync status from Binance — requires a valid binance_order_id + active connection
      if (!order.binance_order_id) continue;
      try {
        const connection = await this.prisma.user_exchange_connections.findFirst({
          where: { user_id: order.user_id, status: 'active' },
          include: { exchange: true },
        });
        if (!connection || connection.exchange?.name?.toLowerCase() !== 'binance') continue;

        const credentials = await this.exchangesService.getDecryptedCredentials(connection.connection_id);
        const binanceOrder = await this.optionsBinance.fetchOrder(
          credentials,
          order.contract_symbol,
          order.binance_order_id,
          order.user_id,
        );

        const newStatus = this.mapOrderStatus(binanceOrder.status);
        if (newStatus !== 'pending' && newStatus !== 'submitting') {
          await this.prisma.options_orders.update({
            where: { order_id: order.order_id },
            data: {
              status: newStatus,
              filled_quantity: parseFloat(binanceOrder.executedQty || binanceOrder.filled || '0'),
              avg_fill_price: parseFloat(binanceOrder.avgPrice || binanceOrder.average || '0') || null,
            },
          });
          syncedCount++;
        }
      } catch (err: any) {
        this.logger.warn(`Order status sync failed for ${order.order_id}: ${err.message}`);
      }
    }

    if (expiredCount + syncedCount > 0) {
      this.logger.log(`Order sync: ${expiredCount} expired, ${syncedCount} status-synced`);
    }
  }

  // ── Cleanup: remove closed positions older than 90 days ──

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async cleanupOldClosedPositions() {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

    const result = await this.prisma.options_positions.deleteMany({
      where: {
        is_open: false,
        closed_at: { lt: ninetyDaysAgo },
      },
    });
    if (result.count > 0) {
      this.logger.log(`Cleaned up ${result.count} closed positions older than 90 days`);
    }
  }
}
