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
import { EncryptionService } from '../../exchanges/services/encryption.service';

const POOL_STATUS = { active: 'active' } as const;

@Injectable()
export class PoolTradingService {
  private readonly logger = new Logger(PoolTradingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly binanceService: BinanceService,
    private readonly encryptionService: EncryptionService,
  ) {}

  async openTrade(adminId: string, poolId: string, dto: ManualTradeDto) {
    const pool = await this.validateActivePool(adminId, poolId);

    const trade = await this.prisma.vc_pool_trades.create({
      data: {
        pool_id: poolId,
        admin_id: adminId,
        asset_pair: dto.asset_pair.toUpperCase(),
        action: dto.action as any,
        quantity: dto.quantity,
        entry_price_usdt: dto.entry_price_usdt,
        strategy_id: dto.strategy_id || null,
        notes: dto.notes || null,
        is_open: true,
        traded_at: new Date(),
      },
    });

    this.logger.log(
      `Trade ${trade.trade_id} opened: ${dto.action} ${dto.quantity} ${dto.asset_pair} @ ${dto.entry_price_usdt}`,
    );

    return trade;
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

    const trade = await this.prisma.vc_pool_trades.create({
      data: {
        pool_id: poolId,
        admin_id: adminId,
        strategy_id: signal.strategy_id || null,
        asset_pair: assetPair,
        action: signal.action as any,
        quantity,
        entry_price_usdt: entryPrice,
        notes: `Applied from signal ${signalId}`,
        is_open: true,
        traded_at: new Date(),
      },
    });

    this.logger.log(
      `Trade ${trade.trade_id} opened from signal ${signalId}: ${signal.action} ${quantity} ${assetPair} @ ${entryPrice}`,
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

    const entryPrice = Number(trade.entry_price_usdt);
    const exitPrice = dto.exit_price_usdt;
    const quantity = Number(trade.quantity);

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
      `Trade ${tradeId} closed: exit=${exitPrice}, PnL=${pnl.toFixed(8)}`,
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
      select: { is_open: true, pnl_usdt: true },
    });

    const openCount = allTrades.filter((t) => t.is_open).length;
    const closedCount = allTrades.filter((t) => !t.is_open).length;
    const realizedPnl = allTrades
      .filter((t) => !t.is_open && t.pnl_usdt)
      .reduce((sum, t) => sum + Number(t.pnl_usdt), 0);

    return {
      trades,
      summary: { open_trades: openCount, closed_trades: closedCount, realized_pnl: realizedPnl },
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

    const admin = await this.prisma.admins.findUnique({
      where: { admin_id: adminId },
      select: { binance_api_key_encrypted: true, binance_api_secret_encrypted: true },
    });

    if (!admin?.binance_api_key_encrypted || !admin?.binance_api_secret_encrypted) {
      throw new BadRequestException(
        'Admin Binance API credentials are not set. Configure them in admin settings to place pool orders.',
      );
    }

    const apiKey = this.encryptionService.decryptApiKey(admin.binance_api_key_encrypted);
    const apiSecret = this.encryptionService.decryptApiKey(admin.binance_api_secret_encrypted);

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

    const closedTrades = await this.prisma.vc_pool_trades.findMany({
      where: { pool_id: poolId, is_open: false },
      select: { pnl_usdt: true },
    });

    const closedPnl = closedTrades.reduce(
      (sum, t) => sum + (t.pnl_usdt ? Number(t.pnl_usdt) : 0),
      0,
    );

    const totalInvested = Number(pool.total_invested_usdt);
    const currentValue = totalInvested + closedPnl;
    const totalProfit = currentValue - totalInvested;

    await this.prisma.vc_pools.update({
      where: { pool_id: poolId },
      data: {
        current_pool_value_usdt: currentValue,
        total_profit_usdt: totalProfit,
      },
    });

    return { currentValue, totalProfit, closedPnl };
  }

  // ── Helpers ──

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
