import { Injectable, Logger, ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ExchangesService } from '../../exchanges/exchanges.service';
import { OptionsBinanceService } from './options-binance.service';
import { OptionsSignalService } from './options-signal.service';
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
  ) {}

  // ── Helpers ──────────────────────────────────────────────

  /**
   * Verify user has ELITE subscription.
   */
  async verifyEliteAccess(userId: string): Promise<void> {
    const user = await this.prisma.users.findUnique({
      where: { user_id: userId },
      select: { current_tier: true },
    });
    if (!user || user.current_tier !== 'ELITE') {
      throw new ForbiddenException('Options trading is available for ELITE subscribers only');
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
    return connection;
  }

  // ── Market Data ──────────────────────────────────────────

  /**
   * Get all available underlying assets for options trading.
   */
  async getAvailableUnderlyings(
    connectionId: string,
    userId: string,
  ): Promise<AvailableUnderlyingDto[]> {
    await this.verifyConnectionOwnership(connectionId, userId);
    const credentials = await this.getCredentials(connectionId);
    return this.optionsBinance.getAvailableUnderlyings(credentials, userId);
  }

  /**
   * Get options chain for an underlying.
   */
  async getOptionsChain(
    connectionId: string,
    userId: string,
    underlying: string,
  ): Promise<OptionsChainResponseDto> {
    await this.verifyConnectionOwnership(connectionId, userId);
    const credentials = await this.getCredentials(connectionId);
    return this.optionsBinance.fetchOptionsChain(credentials, underlying, userId);
  }

  /**
   * Get Greeks for a specific contract.
   */
  async getGreeks(
    connectionId: string,
    userId: string,
    contractSymbol: string,
  ): Promise<GreeksDto> {
    await this.verifyConnectionOwnership(connectionId, userId);
    const credentials = await this.getCredentials(connectionId);
    return this.optionsBinance.fetchGreeks(credentials, contractSymbol, userId);
  }

  /**
   * Get ticker for a contract.
   */
  async getTicker(
    connectionId: string,
    userId: string,
    contractSymbol: string,
  ) {
    await this.verifyConnectionOwnership(connectionId, userId);
    const credentials = await this.getCredentials(connectionId);
    return this.optionsBinance.fetchOptionTicker(credentials, contractSymbol, userId);
  }

  /**
   * Get order book depth.
   */
  async getDepth(
    connectionId: string,
    userId: string,
    contractSymbol: string,
    limit?: number,
  ) {
    await this.verifyConnectionOwnership(connectionId, userId);
    const credentials = await this.getCredentials(connectionId);
    return this.optionsBinance.fetchOptionDepth(credentials, contractSymbol, limit, userId);
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
      .catch((err) => this.logger.error(`Position sync failed for ${userId}: ${err.message}`));
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
              delta: pos.greeks.delta,
              gamma: pos.greeks.gamma,
              theta: pos.greeks.theta,
              vega: pos.greeks.vega,
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
              delta: pos.greeks.delta,
              gamma: pos.greeks.gamma,
              theta: pos.greeks.theta,
              vega: pos.greeks.vega,
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

    // 3. Risk checks
    await this.performRiskChecks(userId, dto, credentials);

    // 3. Calculate max loss (premium × qty for buy side)
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

    // 8. Update DB with exchange response
    const updatedOrder = await this.prisma.options_orders.update({
      where: { order_id: dbOrder.order_id },
      data: {
        binance_order_id: (binanceOrder.orderId || binanceOrder.id)?.toString() || null,
        status: this.mapOrderStatus(binanceOrder.status),
        filled_quantity: parseFloat(binanceOrder.executedQty || binanceOrder.filled || '0'),
        avg_fill_price: parseFloat(binanceOrder.avgPrice || binanceOrder.average || '0') || null,
        fee: parseFloat(binanceOrder.fee || '0') || null,
      },
    });

    this.logger.log(`Options order placed: ${dbOrder.order_id} binance=${binanceOrder.orderId || binanceOrder.id}`);

    return this.mapDbOrderToDto(updatedOrder);
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

    // 2. Max premium per trade (only for buy side)
    if (dto.side === 'BUY') {
      // Check the options margin wallet (eapi) — this is the wallet Binance debits for options orders.
      // If it is empty, skip our pre-check and let Binance return the real error, which now surfaces
      // as a 400 with a clear message (e.g. "insufficient balance in Options Account").
      try {
        const optionsBalance = await this.optionsBinance.fetchBalance(credentials, userId);
        const availableBalance = optionsBalance.availableBalance;
        if (availableBalance > 0) {
          const totalPremium = dto.price * dto.quantity;
          const maxAllowed = availableBalance * RISK_CONFIG.MAX_PREMIUM_PERCENT;
          if (totalPremium > maxAllowed) {
            throw new BadRequestException(
              `Premium $${totalPremium.toFixed(2)} exceeds ${RISK_CONFIG.MAX_PREMIUM_PERCENT * 100}% of Options account balance ($${availableBalance.toFixed(2)})`,
            );
          }
        } else {
          this.logger.warn(`Options margin account balance is 0 for user ${userId} — skipping 5% pre-check. Binance will validate funds.`);
        }
      } catch (err: any) {
        if (err instanceof BadRequestException) throw err;
        this.logger.warn(`Could not check options balance for risk check: ${err.message}`);
      }
    }

    // 3. Margin check for SELL orders (selling options requires margin)
    if (dto.side === 'SELL') {
      try {
        const optionsBalance = await this.optionsBinance.fetchBalance(credentials, userId);
        const availableBalance = optionsBalance.availableBalance;
        if (availableBalance > 0) {
          // Estimate margin as premium * quantity * 2 (conservative 2x margin heuristic)
          const estimatedMargin = dto.price * dto.quantity * 2;
          const maxMargin = availableBalance * RISK_CONFIG.MAX_SELL_MARGIN_PERCENT;
          if (estimatedMargin > maxMargin) {
            throw new BadRequestException(
              `Estimated margin $${estimatedMargin.toFixed(2)} exceeds ${(RISK_CONFIG.MAX_SELL_MARGIN_PERCENT * 100).toFixed(0)}% of available balance ($${availableBalance.toFixed(2)})`,
            );
          }
        }
      } catch (err: any) {
        if (err instanceof BadRequestException) throw err;
        this.logger.warn(`Could not check margin for SELL order: ${err.message}`);
      }
    }

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
}
