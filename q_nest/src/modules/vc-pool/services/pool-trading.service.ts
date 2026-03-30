import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ManualTradeDto } from '../dto/manual-trade.dto';
import { CloseTradeDto } from '../dto/close-trade.dto';
import { PlacePoolOrderDto } from '../dto/place-pool-order.dto';
import { BinanceService } from '../../exchanges/integrations/binance.service';
import { EncryptionUtil } from '../../../common/utils/encryption.util';

const POOL_STATUS = { active: 'active' } as const;

@Injectable()
export class PoolTradingService {
  private readonly logger = new Logger(PoolTradingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly binanceService: BinanceService,
  ) {}

  async openTrade(adminId: string, poolId: string, dto: ManualTradeDto) {
    try {
      const pool = await this.validateActivePool(adminId, poolId);

      await this.validateCapital(poolId, pool, dto.quantity * dto.entry_price_usdt);

      // Place real order on Binance
      const { apiKey, apiSecret } = await this.getAdminBinanceKeys(adminId);
      const symbol = dto.asset_pair.toUpperCase();
      const side = dto.action.toUpperCase() as 'BUY' | 'SELL';

      const binanceOrder = await this.binanceService.placeOrder(
        apiKey, apiSecret, symbol, side, 'MARKET', dto.quantity,
      );

      const actualPrice = binanceOrder.price || dto.entry_price_usdt;
      const actualQty = binanceOrder.quantity || dto.quantity;

      const trade = await this.prisma.vc_pool_trades.create({
        data: {
          pool_id: poolId,
          admin_id: adminId,
          asset_pair: symbol,
          action: dto.action as any,
          quantity: actualQty,
          entry_price_usdt: actualPrice,
          strategy_id: dto.strategy_id || null,
          notes: dto.notes || null,
          binance_order_id: binanceOrder.orderId || null,
          is_open: true,
          traded_at: new Date(),
        },
      });

      this.logger.log(
        `Trade ${trade.trade_id} opened on Binance: ${side} ${actualQty} ${symbol} @ ${actualPrice} (order: ${binanceOrder.orderId})`,
      );

      return trade;
    } catch (error: any) {
      this.logger.error(`openTrade failed: ${error?.message ?? error}`, error?.stack);
      throw error;
    }
  }

  /**
   * Create a pool trade from a strategy signal (Top Trades–style apply to pool).
   * Only crypto signals are supported (VC pool value uses Binance).
   */
  async openTradeFromSignal(
    adminId: string,
    poolId: string,
    signalId: string,
  ) {
    await this.validateActivePool(adminId, poolId);

    const signal = await this.prisma.strategy_signals.findUnique({
      where: { signal_id: signalId },
      include: {
        asset: true,
        details: {
          orderBy: { created_at: 'desc' },
          take: 1,
        },
      },
    });

    if (!signal) {
      throw new NotFoundException('Signal not found');
    }

    if (signal.action === 'HOLD') {
      throw new BadRequestException(
        'Cannot apply HOLD signal as a trade. Only BUY or SELL signals can be applied.',
      );
    }

    if (!signal.asset?.symbol) {
      throw new BadRequestException('Signal has no asset or symbol');
    }

    const assetType = (signal.asset?.asset_type || '').toLowerCase();
    if (assetType === 'stock') {
      throw new BadRequestException(
        'Only crypto signals can be applied to VC pools. Stock signals are not supported.',
      );
    }

    const detail = signal.details?.[0];
    if (!detail?.entry_price || detail.entry_price == null) {
      throw new BadRequestException(
        'Signal has no entry price. Apply a signal that includes trade details.',
      );
    }
    if (!detail?.position_size || Number(detail.position_size) <= 0) {
      throw new BadRequestException(
        'Signal has no valid position size. Apply a signal that includes trade details.',
      );
    }

    const symbol = signal.asset.symbol.trim().toUpperCase();
    const assetPair = symbol.endsWith('USDT') ? symbol : `${symbol}USDT`;
    const quantity = Number(detail.position_size);
    const entryPrice = Number(detail.entry_price);

    const pool = await this.prisma.vc_pools.findUnique({ where: { pool_id: poolId } });
    await this.validateCapital(poolId, pool, quantity * entryPrice);

    // Place real order on Binance
    const { apiKey, apiSecret } = await this.getAdminBinanceKeys(adminId);
    const side = signal.action.toUpperCase() as 'BUY' | 'SELL';

    const binanceOrder = await this.binanceService.placeOrder(
      apiKey, apiSecret, assetPair, side, 'MARKET', quantity,
    );

    const actualPrice = binanceOrder.price || entryPrice;
    const actualQty = binanceOrder.quantity || quantity;

    const trade = await this.prisma.vc_pool_trades.create({
      data: {
        pool_id: poolId,
        admin_id: adminId,
        strategy_id: signal.strategy_id || null,
        asset_pair: assetPair,
        action: signal.action as any,
        quantity: actualQty,
        entry_price_usdt: actualPrice,
        binance_order_id: binanceOrder.orderId || null,
        notes: `Applied from signal ${signalId}`,
        is_open: true,
        traded_at: new Date(),
      },
    });

    this.logger.log(
      `Trade ${trade.trade_id} opened from signal ${signalId} on Binance: ${side} ${actualQty} ${assetPair} @ ${actualPrice} (order: ${binanceOrder.orderId})`,
    );

    return trade;
  }

  async closeTrade(
    adminId: string,
    poolId: string,
    tradeId: string,
    dto: CloseTradeDto,
  ) {
    await this.validateActivePool(adminId, poolId);

    const trade = await this.prisma.vc_pool_trades.findUnique({
      where: { trade_id: tradeId },
    });

    if (!trade || trade.pool_id !== poolId) {
      throw new NotFoundException('Trade not found');
    }

    if (!trade.is_open) {
      throw new BadRequestException('Trade is already closed');
    }

    const quantity = Number(trade.quantity);
    const symbol = trade.asset_pair;
    // Close = opposite side (BUY→SELL, SELL→BUY)
    const closeSide = trade.action === 'BUY' ? 'SELL' : 'BUY';

    // Place closing order on Binance
    const { apiKey, apiSecret } = await this.getAdminBinanceKeys(adminId);
    const binanceOrder = await this.binanceService.placeOrder(
      apiKey, apiSecret, symbol, closeSide as 'BUY' | 'SELL', 'MARKET', quantity,
    );

    const exitPrice = binanceOrder.price || dto.exit_price_usdt;
    const entryPrice = Number(trade.entry_price_usdt);

    let pnl: number;
    if (trade.action === 'BUY') {
      pnl = (exitPrice - entryPrice) * quantity;
    } else {
      pnl = (entryPrice - exitPrice) * quantity;
    }

    const updatedTrade = await this.prisma.vc_pool_trades.update({
      where: { trade_id: tradeId },
      data: {
        exit_price_usdt: exitPrice,
        pnl_usdt: pnl,
        is_open: false,
        closed_at: new Date(),
      },
    });

    // Recalculate pool value after closing trade
    await this.recalculatePoolValue(poolId);

    this.logger.log(
      `Trade ${tradeId} closed on Binance: ${closeSide} ${quantity} ${symbol} @ ${exitPrice}, PnL=${pnl.toFixed(8)} (order: ${binanceOrder.orderId})`,
    );

    return updatedTrade;
  }

  async listTrades(
    adminId: string,
    poolId: string,
    filters: { status?: string; page?: number; limit?: number },
  ) {
    await this.validatePoolOwnership(adminId, poolId);

    const page = filters.page && filters.page > 0 ? filters.page : 1;
    const limit = filters.limit && filters.limit > 0 ? Math.min(filters.limit, 50) : 20;
    const skip = (page - 1) * limit;

    const where: Record<string, any> = { pool_id: poolId };
    if (filters.status === 'open') where.is_open = true;
    if (filters.status === 'closed') where.is_open = false;

    const [trades, total] = await this.prisma.$transaction([
      this.prisma.vc_pool_trades.findMany({
        where,
        orderBy: { traded_at: 'desc' },
        skip,
        take: limit,
        include: {
          strategy: { select: { strategy_id: true, name: true } },
        },
      }),
      this.prisma.vc_pool_trades.count({ where }),
    ]);

    // Calculate summary
    const allTrades = await this.prisma.vc_pool_trades.findMany({
      where: { pool_id: poolId },
      select: { is_open: true, pnl_usdt: true, quantity: true, entry_price_usdt: true },
    });

    const openCount = allTrades.filter((t) => t.is_open).length;
    const closedCount = allTrades.filter((t) => !t.is_open).length;
    const realizedPnl = allTrades
      .filter((t) => !t.is_open && t.pnl_usdt)
      .reduce((sum, t) => sum + Number(t.pnl_usdt), 0);

    // Capital allocation from open trades
    const totalAllocated = allTrades
      .filter((t) => t.is_open)
      .reduce((sum, t) => sum + Number(t.quantity) * Number(t.entry_price_usdt), 0);

    const pool = await this.prisma.vc_pools.findUnique({
      where: { pool_id: poolId },
      select: { current_pool_value_usdt: true, total_invested_usdt: true },
    });
    const poolCapital = Number(pool?.current_pool_value_usdt ?? pool?.total_invested_usdt ?? 0);
    const availableCapital = Math.max(poolCapital - totalAllocated, 0);
    const utilizationPct = poolCapital > 0
      ? Math.round((totalAllocated / poolCapital) * 10000) / 100
      : 0;

    return {
      trades,
      summary: {
        open_trades: openCount,
        closed_trades: closedCount,
        realized_pnl: realizedPnl,
        total_allocated_usdt: totalAllocated,
        available_capital_usdt: availableCapital,
      },
      pool_capital: {
        total_usdt: poolCapital,
        allocated_usdt: totalAllocated,
        available_usdt: availableCapital,
        utilization_pct: utilizationPct,
      },
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async listExchangeOrders(adminId: string, poolId: string, filters?: { status?: string; page?: number; limit?: number }) {
    await this.validatePoolOwnership(adminId, poolId);

    const page = filters?.page && filters.page > 0 ? filters.page : 1;
    const limit = filters?.limit && filters.limit > 0 ? Math.min(filters.limit, 50) : 20;
    const skip = (page - 1) * limit;

    const where: Record<string, any> = { pool_id: poolId };
    if (filters?.status === 'open') where.is_open = true;
    if (filters?.status === 'closed') where.is_open = false;

    const [orders, total] = await this.prisma.$transaction([
      this.prisma.vc_pool_exchange_orders.findMany({
        where,
        orderBy: { opened_at: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.vc_pool_exchange_orders.count({ where }),
    ]);

    const allOrders = await this.prisma.vc_pool_exchange_orders.findMany({
      where: { pool_id: poolId },
      select: { is_open: true, realized_pnl_usdt: true },
    });
    const openCount = allOrders.filter((o) => o.is_open).length;
    const closedCount = allOrders.filter((o) => !o.is_open).length;
    const realizedPnl = allOrders
      .filter((o) => !o.is_open && o.realized_pnl_usdt)
      .reduce((sum, o) => sum + Number(o.realized_pnl_usdt), 0);

    return {
      orders: orders.map((o) => ({
        order_id: o.order_id,
        pool_id: o.pool_id,
        admin_id: o.admin_id,
        symbol: o.symbol,
        side: o.side,
        order_type: o.order_type,
        quantity: Number(o.quantity),
        entry_price_usdt: Number(o.entry_price_usdt),
        exchange_order_id: o.exchange_order_id,
        is_open: o.is_open,
        exit_price_usdt: o.exit_price_usdt ? Number(o.exit_price_usdt) : null,
        realized_pnl_usdt: o.realized_pnl_usdt ? Number(o.realized_pnl_usdt) : null,
        opened_at: o.opened_at,
        closed_at: o.closed_at,
        created_at: o.created_at,
      })),
      summary: { open_positions: openCount, closed_positions: closedCount, realized_pnl_usdt: realizedPnl },
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async closeExchangeOrder(
    adminId: string,
    poolId: string,
    orderId: string,
    exitPriceUsdt: number,
  ) {
    await this.validateActivePool(adminId, poolId);

    const order = await this.prisma.vc_pool_exchange_orders.findFirst({
      where: { order_id: orderId, pool_id: poolId },
    });
    if (!order) throw new NotFoundException('Pool exchange order not found');
    if (!order.is_open) throw new BadRequestException('Order is already closed');

    const entry = Number(order.entry_price_usdt);
    const qty = Number(order.quantity);
    const side = (order.side || '').toUpperCase();
    const realizedPnl =
      side === 'BUY' ? (exitPriceUsdt - entry) * qty : (entry - exitPriceUsdt) * qty;

    const updated = await this.prisma.vc_pool_exchange_orders.update({
      where: { order_id: orderId },
      data: {
        is_open: false,
        exit_price_usdt: exitPriceUsdt,
        realized_pnl_usdt: realizedPnl,
        closed_at: new Date(),
      },
    });

    // Recalculate pool value after closing exchange order
    await this.recalculatePoolValue(poolId);

    this.logger.log(
      `Pool exchange order ${orderId} closed: exit=${exitPriceUsdt}, PnL=${realizedPnl.toFixed(8)}`,
    );
    return updated;
  }

  /**
   * Place a real exchange order for a VC pool using the admin's Binance API keys.
   * Same exchange flow as user place-order, but uses admin credentials and records to vc_pool_exchange_orders.
   */
  async placePoolOrder(adminId: string, poolId: string, dto: PlacePoolOrderDto) {
    const pool = await this.validateActivePool(adminId, poolId);

    const { apiKey, apiSecret } = await this.getAdminBinanceKeys(adminId);

    const symbol = dto.symbol.toUpperCase();
    if (dto.type === 'LIMIT' && (dto.price == null || dto.price <= 0)) {
      throw new BadRequestException('Price is required for LIMIT orders');
    }

    const order = await this.binanceService.placeOrder(
      apiKey,
      apiSecret,
      symbol,
      dto.side,
      dto.type,
      dto.quantity,
      dto.price,
    );

    const entryPrice = order?.price ?? dto.price ?? 0;

    const record = await this.prisma.vc_pool_exchange_orders.create({
      data: {
        pool_id: poolId,
        admin_id: adminId,
        symbol,
        side: order?.side ?? dto.side,
        order_type: order?.type ?? dto.type,
        quantity: dto.quantity,
        entry_price_usdt: entryPrice,
        exchange_order_id: order?.orderId ?? null,
        is_open: true,
      },
    });

    this.logger.log(
      `Pool exchange order placed: ${record.order_id} ${dto.side} ${dto.quantity} ${symbol} @ ${entryPrice}`,
    );
    return { order: record, exchangeResponse: order };
  }

  async recalculatePoolValue(poolId: string) {
    const pool = await this.prisma.vc_pools.findUnique({
      where: { pool_id: poolId },
      select: { total_invested_usdt: true },
    });

    if (!pool || !pool.total_invested_usdt) return;

    // Realized PnL from closed manual trades
    const closedTrades = await this.prisma.vc_pool_trades.findMany({
      where: { pool_id: poolId, is_open: false },
      select: { pnl_usdt: true },
    });
    let closedPnl = closedTrades.reduce(
      (sum, t) => sum + (t.pnl_usdt ? Number(t.pnl_usdt) : 0),
      0,
    );

    // Realized PnL from closed exchange orders
    const closedExchangeOrders = await this.prisma.vc_pool_exchange_orders.findMany({
      where: { pool_id: poolId, is_open: false },
      select: { realized_pnl_usdt: true },
    });
    closedPnl += closedExchangeOrders.reduce(
      (sum, o) => sum + (o.realized_pnl_usdt ? Number(o.realized_pnl_usdt) : 0),
      0,
    );

    // Unrealized PnL from open manual trades
    const openTrades = await this.prisma.vc_pool_trades.findMany({
      where: { pool_id: poolId, is_open: true },
      select: { asset_pair: true, action: true, quantity: true, entry_price_usdt: true },
    });

    // Unrealized PnL from open exchange orders
    const openExchangeOrders = await this.prisma.vc_pool_exchange_orders.findMany({
      where: { pool_id: poolId, is_open: true },
      select: { symbol: true, side: true, quantity: true, entry_price_usdt: true },
    });

    let unrealizedPnl = 0;
    const allOpenPositions = [
      ...openTrades.map((t) => ({ symbol: t.asset_pair, side: t.action, qty: Number(t.quantity), entry: Number(t.entry_price_usdt) })),
      ...openExchangeOrders.map((o) => ({ symbol: o.symbol.includes('USDT') ? o.symbol : `${o.symbol}USDT`, side: (o.side || '').toUpperCase(), qty: Number(o.quantity), entry: Number(o.entry_price_usdt) })),
    ];

    if (allOpenPositions.length > 0) {
      const symbols = [...new Set(allOpenPositions.map((p) => p.symbol))];
      const tickers = await this.binanceService.getTickerPrices(symbols);
      const priceMap = new Map(tickers.map((t) => [t.symbol, t.price]));

      for (const pos of allOpenPositions) {
        const currentPrice = priceMap.get(pos.symbol);
        if (currentPrice === undefined) continue;
        if (pos.side === 'BUY') {
          unrealizedPnl += (currentPrice - pos.entry) * pos.qty;
        } else {
          unrealizedPnl += (pos.entry - currentPrice) * pos.qty;
        }
      }
    }

    const totalInvested = Number(pool.total_invested_usdt);
    const currentValue = totalInvested + closedPnl + unrealizedPnl;
    const totalProfit = currentValue - totalInvested;

    await this.prisma.vc_pools.update({
      where: { pool_id: poolId },
      data: {
        current_pool_value_usdt: currentValue,
        total_profit_usdt: totalProfit,
      },
    });

    return { currentValue, totalProfit, closedPnl, unrealizedPnl };
  }

  // ── Helpers ──

  private async getAdminBinanceKeys(adminId: string) {
    // Use the admin's payment/trading Binance key stored directly on the admins table.
    // This is the account that holds the VC pool trading capital.
    const admin = await this.prisma.admins.findUnique({
      where: { admin_id: adminId },
      select: {
        binance_api_key_encrypted: true,
        binance_api_secret_encrypted: true,
      },
    });

    if (!admin) throw new NotFoundException('Admin not found');

    if (!admin.binance_api_key_encrypted || !admin.binance_api_secret_encrypted) {
      throw new BadRequestException(
        'Admin has no Binance API key configured. Set it via the admin Binance settings.',
      );
    }

    const encryptionKey = process.env.ENCRYPTION_KEY!;
    return {
      apiKey: EncryptionUtil.decrypt(admin.binance_api_key_encrypted, encryptionKey),
      apiSecret: EncryptionUtil.decrypt(admin.binance_api_secret_encrypted, encryptionKey),
    };
  }

  private async validateCapital(
    poolId: string,
    pool: any,
    tradeValue: number,
  ) {
    const poolCapital = Number(
      pool?.current_pool_value_usdt ?? pool?.total_invested_usdt ?? 0,
    );

    // Include both manual trades and exchange orders in allocated capital
    const openTrades = await this.prisma.vc_pool_trades.findMany({
      where: { pool_id: poolId, is_open: true },
      select: { quantity: true, entry_price_usdt: true },
    });
    const openExchangeOrders = await this.prisma.vc_pool_exchange_orders.findMany({
      where: { pool_id: poolId, is_open: true },
      select: { quantity: true, entry_price_usdt: true },
    });

    const allocatedTrades = openTrades.reduce(
      (sum, t) => sum + Number(t.quantity) * Number(t.entry_price_usdt),
      0,
    );
    const allocatedOrders = openExchangeOrders.reduce(
      (sum, o) => sum + Number(o.quantity) * Number(o.entry_price_usdt),
      0,
    );
    const allocated = allocatedTrades + allocatedOrders;
    const available = poolCapital - allocated;

    if (tradeValue > available) {
      throw new BadRequestException(
        `Insufficient pool capital. Trade value $${tradeValue.toFixed(2)} exceeds available capital $${available.toFixed(2)}.`,
      );
    }
  }

  private async validateActivePool(adminId: string, poolId: string) {
    const pool = await this.prisma.vc_pools.findUnique({
      where: { pool_id: poolId },
    });

    if (!pool) throw new NotFoundException('Pool not found');
    if (pool.admin_id !== adminId) {
      throw new ForbiddenException('You do not own this pool');
    }
    if (pool.status !== POOL_STATUS.active) {
      throw new BadRequestException('Pool is not active');
    }

    return pool;
  }

  private async validatePoolOwnership(adminId: string, poolId: string) {
    const pool = await this.prisma.vc_pools.findUnique({
      where: { pool_id: poolId },
    });

    if (!pool) throw new NotFoundException('Pool not found');
    if (pool.admin_id !== adminId) {
      throw new ForbiddenException('You do not own this pool');
    }

    return pool;
  }
}
