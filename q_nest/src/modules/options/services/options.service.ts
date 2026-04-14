import { Injectable, Logger, ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';
import { ExchangesService } from '../../exchanges/exchanges.service';
import { OptionsBinanceService } from './options-binance.service';
import { OptionsSignalService } from './options-signal.service';
import { TradeFeesService } from '../../trade-fees/trade-fees.service';
import {
  PlaceOptionOrderDto,
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

@Injectable()
export class OptionsService {
  private readonly logger = new Logger(OptionsService.name);
  private readonly pythonApiUrl =
    process.env.PYTHON_API_URL || 'http://localhost:8000';

  constructor(
    private readonly prisma: PrismaService,
    private readonly exchangesService: ExchangesService,
    private readonly optionsBinance: OptionsBinanceService,
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
   * Verify connection belongs to user.
   */
  private async verifyConnectionOwnership(connectionId: string, userId: string) {
    const connection = await this.exchangesService.getConnectionById(connectionId);
    if (!connection) {
      throw new NotFoundException('Exchange connection not found');
    }
    if (connection.user_id !== userId) {
      throw new ForbiddenException('You do not own this connection');
    }
    // Options trading restricted to Binance crypto connections only
    if ((connection as any).exchange?.type !== 'crypto') {
      throw new ForbiddenException('Options trading is only available for crypto exchanges');
    }
    if ((connection as any).exchange?.name?.toLowerCase() !== 'binance') {
      throw new ForbiddenException('Options trading is only supported on Binance');
    }
    return connection;
  }

  // ── Market Data ──────────────────────────────────────────

  /**
   * Get all available underlying assets (public data, no credentials needed).
   */
  async getAvailableUnderlyings(): Promise<AvailableUnderlyingDto[]> {
    return this.optionsBinance.getAvailableUnderlyings();
  }

  /**
   * Get options chain for an underlying (public data).
   */
  async getOptionsChain(underlying: string): Promise<OptionsChainResponseDto> {
    return this.optionsBinance.fetchOptionsChain(null, underlying);
  }

  /**
   * Get Greeks for a specific contract (public data).
   */
  async getGreeks(contractSymbol: string): Promise<GreeksDto> {
    return this.optionsBinance.fetchGreeks(null, contractSymbol);
  }

  /**
   * Get ticker for a contract (public data).
   */
  async getTicker(contractSymbol: string) {
    return this.optionsBinance.fetchOptionTicker(null, contractSymbol);
  }

  /**
   * Get order book depth (public data).
   */
  async getDepth(contractSymbol: string, limit?: number) {
    return this.optionsBinance.fetchOptionDepth(null, contractSymbol, limit);
  }

  // ── Account ──────────────────────────────────────────────

  /**
   * Get options account balance.
   */
  async getBalance(
    connectionId: string,
    userId: string,
  ): Promise<OptionsAccountDto> {
    await this.verifyConnectionOwnership(connectionId, userId);
    // Use spot wallet (same source as exchanges service / top trades)
    const balanceData = await this.exchangesService.getConnectionData(connectionId, 'balance') as any;
    const assets: any[] = balanceData?.assets ?? [];
    const usdtAsset = assets.find((a: any) => a.symbol === 'USDT');
    return {
      availableBalance: usdtAsset ? parseFloat(usdtAsset.free || '0') : 0,
      totalBalance: usdtAsset ? parseFloat(usdtAsset.total || usdtAsset.free || '0') : 0,
      unrealizedPnl: 0,
      marginBalance: 0,
    };
  }

  // ── Positions ────────────────────────────────────────────

  /**
   * Get open positions from Binance & sync to DB.
   */
  async getPositions(
    connectionId: string,
    userId: string,
  ): Promise<OptionsPositionDto[]> {
    await this.verifyConnectionOwnership(connectionId, userId);
    const credentials = await this.getCredentials(connectionId);
    const positions = await this.optionsBinance.fetchPositions(credentials, userId);

    // Sync positions to DB in background
    this.syncPositionsToDb(userId, positions).catch((err) =>
      this.logger.error(`Position sync failed: ${err.message}`),
    );

    return positions;
  }

  /**
   * Get positions from DB (for history / offline).
   */
  async getPositionsFromDb(userId: string) {
    return this.prisma.options_positions.findMany({
      where: { user_id: userId },
      orderBy: { opened_at: 'desc' },
    });
  }

  // Per-user mutex to prevent concurrent sync race conditions
  private syncLocks = new Map<string, Promise<void>>();

  private async syncPositionsToDb(userId: string, positions: OptionsPositionDto[]) {
    // Serialize sync calls per user to prevent race conditions
    const existing = this.syncLocks.get(userId) || Promise.resolve();
    const next = existing
      .then(() => this._doPositionSync(userId, positions))
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

  private async _doPositionSync(userId: string, positions: OptionsPositionDto[]) {
    const activeSymbols = positions.map((p) => p.contractSymbol);

    await this.prisma.$transaction(async (tx) => {
      // Upsert each position (batch within single transaction)
      for (const pos of positions) {
        const parts = pos.contractSymbol.split('-');
        const optionType: OptionType = parts[3] === 'C' ? 'CALL' : 'PUT';
        const expiryDate = this.parseExpiryToDate(parts[1]);

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
            },
          });
        }
      }

      // Mark positions as closed if no longer on Binance
      // Works even when activeSymbols is empty (closes ALL open positions)
      await tx.options_positions.updateMany({
        where: {
          user_id: userId,
          is_open: true,
          ...(activeSymbols.length > 0 ? { contract_symbol: { notIn: activeSymbols } } : {}),
        },
        data: {
          is_open: false,
          closed_at: new Date(),
        },
      });
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
   * Place an option order with risk checks.
   */
  async placeOrder(
    userId: string,
    dto: PlaceOptionOrderDto,
  ): Promise<OptionsOrderDto> {
    // 1. Verify connection ownership
    await this.verifyConnectionOwnership(dto.connectionId, userId);
    const credentials = await this.getCredentials(dto.connectionId);

    // 2. Validate signal not expired (if order linked to a signal)
    if (dto.signalId) {
      try {
        await this.signalService.validateSignalNotExpired(dto.signalId);
      } catch (err: any) {
        throw new BadRequestException(err.message);
      }
    }

    // 3. Sell-to-close validation (no naked option writing)
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

    // 4. Risk checks
    await this.performRiskChecks(userId, dto, credentials);

    // 5. Calculate max loss (premium × qty for buy side)
    const maxLoss = dto.side === 'BUY' ? dto.price * dto.quantity : null;

    // 4. Get current Greeks for snapshot
    let greeksSnapshot = null;
    try {
      greeksSnapshot = await this.optionsBinance.fetchGreeks(
        credentials,
        dto.contractSymbol,
        userId,
      );
    } catch {
      this.logger.warn('Could not fetch Greeks snapshot before order placement');
    }

    // 5. Parse contract symbol parts
    const parts = dto.contractSymbol.split('-');
    const optionType: OptionType = parts[3] === 'C' ? 'CALL' : 'PUT';
    const expiryDate = this.parseExpiryToDate(parts[1]);

    // 6. Create DB record FIRST with 'submitting' status (ensures no orphaned exchange orders)
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
        status: 'submitting',
        max_loss: maxLoss,
        greeks_at_entry: greeksSnapshot,
      },
    });

    // 7. Place on Binance — update DB regardless of outcome
    let binanceOrder: any;
    try {
      binanceOrder = await this.optionsBinance.placeOptionOrder(
        credentials,
        dto.contractSymbol,
        dto.side.toLowerCase() as 'buy' | 'sell',
        dto.quantity,
        dto.price,
        userId,
      );
    } catch (exchangeError) {
      // Exchange rejected — mark DB record as 'rejected' so it's tracked
      await this.prisma.options_orders.update({
        where: { order_id: dbOrder.order_id },
        data: { status: 'rejected' },
      });
      throw exchangeError;
    }

    // 8. Update DB with exchange response — handle DB failure gracefully
    let updatedOrder: any;
    try {
      updatedOrder = await this.prisma.options_orders.update({
        where: { order_id: dbOrder.order_id },
        data: {
          binance_order_id: (binanceOrder.orderId || binanceOrder.id)?.toString() || null,
          status: this.mapOrderStatus(binanceOrder.status),
          filled_quantity: parseFloat(binanceOrder.executedQty || binanceOrder.filled || '0'),
          avg_fill_price: parseFloat(binanceOrder.avgPrice || binanceOrder.average || '0') || null,
          fee: parseFloat(binanceOrder.fee || '0') || null,
        },
      });
    } catch (dbErr: any) {
      this.logger.error(
        `DB update failed for order ${dbOrder.order_id}, Binance ID: ${binanceOrder.orderId || binanceOrder.id}. Manual reconciliation needed: ${dbErr.message}`,
      );
      // Return the original DB order so the client knows the order was placed on Binance
      const fallback = this.mapDbOrderToDto(dbOrder);
      fallback.binanceOrderId = (binanceOrder.orderId || binanceOrder.id)?.toString() || '';
      return fallback;
    }

    this.logger.log(`Options order placed: ${dbOrder.order_id} binance=${binanceOrder.orderId || binanceOrder.id}`);

    // 9. Record platform execution fee (0.03%) on filled orders
    const orderStatus = updatedOrder?.status ?? dbOrder.status;
    if (['filled', 'partially_filled'].includes(orderStatus)) {
      const fillQty = Number(updatedOrder?.filled_quantity ?? 0);
      const fillPrice = Number(updatedOrder?.avg_fill_price ?? 0);
      const fillValue = fillQty * fillPrice;
      if (fillValue > 0) {
        this.tradeFeesService.recordTradeFee({
          userId,
          tradeReferenceId: dbOrder.order_id,
          assetSymbol: dto.underlying,
          tradeSide: dto.side,
          tradeValueUsd: fillValue,
          feePercent: 0.0003, // 0.03%
          source: 'options_execution',
        }).catch((err) => this.logger.warn(`Failed to record execution fee: ${err.message}`));
      }
    }

    return this.mapDbOrderToDto(updatedOrder ?? dbOrder);
  }

  /**
   * Cancel an option order.
   */
  async cancelOrder(
    userId: string,
    dto: CancelOptionOrderDto,
  ): Promise<{ success: boolean; message: string }> {
    await this.verifyConnectionOwnership(dto.connectionId, userId);
    const credentials = await this.getCredentials(dto.connectionId);

    // Find order in DB
    const dbOrder = await this.prisma.options_orders.findFirst({
      where: {
        user_id: userId,
        OR: [
          { order_id: dto.orderId },
          { binance_order_id: dto.orderId },
        ],
      },
    });

    if (!dbOrder) {
      throw new NotFoundException('Order not found');
    }

    const binanceOrderId = dbOrder.binance_order_id || dto.orderId;

    // Cancel on Binance
    await this.optionsBinance.cancelOptionOrder(
      credentials,
      dto.contractSymbol,
      binanceOrderId,
      userId,
    );

    // Update DB
    await this.prisma.options_orders.update({
      where: { order_id: dbOrder.order_id },
      data: { status: 'cancelled' },
    });

    return { success: true, message: `Order ${dbOrder.order_id} cancelled` };
  }

  /**
   * Get user's option orders from DB.
   */
  async getOrders(
    userId: string,
    status?: string,
    limit: number = 50,
  ) {
    const where: any = { user_id: userId };
    if (status) where.status = status;

    const orders = await this.prisma.options_orders.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: limit,
    });

    return orders.map((o) => this.mapDbOrderToDto(o));
  }

  /**
   * Get open orders live from Binance.
   */
  async getOpenOrdersLive(
    connectionId: string,
    userId: string,
    contractSymbol?: string,
  ) {
    await this.verifyConnectionOwnership(connectionId, userId);
    const credentials = await this.getCredentials(connectionId);
    return this.optionsBinance.fetchOpenOrders(credentials, contractSymbol, userId);
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
    // 1. Max open positions check
    const openPositionCount = await this.prisma.options_positions.count({
      where: { user_id: userId, is_open: true },
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
