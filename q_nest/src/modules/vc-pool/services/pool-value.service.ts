import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { BinanceService } from '../../binance/binance.service';

@Injectable()
export class PoolValueService {
  private readonly logger = new Logger(PoolValueService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly binance: BinanceService,
  ) {}

  async calculatePoolValue(poolId: string) {
    const pool = await this.prisma.vc_pools.findUnique({
      where: { pool_id: poolId },
      select: { total_invested_usdt: true, status: true },
    });

    if (!pool || pool.status !== 'active' || !pool.total_invested_usdt) return null;

    const totalInvested = Number(pool.total_invested_usdt);

    // Realized PnL from closed manual trades
    const closedTrades = await this.prisma.vc_pool_trades.findMany({
      where: { pool_id: poolId, is_open: false },
      select: { pnl_usdt: true },
    });
    let closedPnl = closedTrades.reduce(
      (sum, t) => sum + (t.pnl_usdt ? Number(t.pnl_usdt) : 0),
      0,
    );

    // Realized PnL from closed pool-tagged exchange orders
    const closedExchangeOrders = await this.prisma.vc_pool_exchange_orders.findMany({
      where: { pool_id: poolId, is_open: false },
      select: { realized_pnl_usdt: true },
    });
    closedPnl += closedExchangeOrders.reduce(
      (sum, o) => sum + (o.realized_pnl_usdt ? Number(o.realized_pnl_usdt) : 0),
      0,
    );

    // Unrealized PnL from open manual trades (fetch live prices)
    const openTrades = await this.prisma.vc_pool_trades.findMany({
      where: { pool_id: poolId, is_open: true },
      select: { trade_id: true, asset_pair: true, action: true, quantity: true, entry_price_usdt: true },
    });

    let unrealizedPnl = 0;
    for (const trade of openTrades) {
      try {
        const currentPrice = await this.binance.getPrice(trade.asset_pair);
        const entry = Number(trade.entry_price_usdt);
        const qty = Number(trade.quantity);

        if (trade.action === 'BUY') {
          unrealizedPnl += (currentPrice - entry) * qty;
        } else {
          unrealizedPnl += (entry - currentPrice) * qty;
        }
      } catch (err) {
        this.logger.warn(
          `Could not fetch price for ${trade.asset_pair}: ${err.message}. Skipping unrealized PnL.`,
        );
      }
    }

    // Unrealized PnL from open pool-tagged exchange orders
    const openExchangeOrders = await this.prisma.vc_pool_exchange_orders.findMany({
      where: { pool_id: poolId, is_open: true },
      select: { symbol: true, side: true, quantity: true, entry_price_usdt: true },
    });
    for (const ord of openExchangeOrders) {
      try {
        const symbol = ord.symbol.includes('USDT') ? ord.symbol : `${ord.symbol}USDT`;
        const currentPrice = await this.binance.getPrice(symbol);
        const entry = Number(ord.entry_price_usdt);
        const qty = Number(ord.quantity);
        const side = (ord.side || '').toUpperCase();
        if (side === 'BUY') {
          unrealizedPnl += (currentPrice - entry) * qty;
        } else {
          unrealizedPnl += (entry - currentPrice) * qty;
        }
      } catch (err) {
        this.logger.warn(
          `Could not fetch price for ${ord.symbol}: ${err?.message}. Skipping unrealized PnL.`,
        );
      }
    }

    const currentValue = totalInvested + closedPnl + unrealizedPnl;
    const totalProfit = currentValue - totalInvested;

    await this.prisma.vc_pools.update({
      where: { pool_id: poolId },
      data: {
        current_pool_value_usdt: currentValue,
        total_profit_usdt: totalProfit,
      },
    });

    return { poolId, totalInvested, closedPnl, unrealizedPnl, currentValue, totalProfit };
  }

  async updateAllActivePools() {
    const activePools = await this.prisma.vc_pools.findMany({
      where: { status: 'active' as any },
      select: { pool_id: true },
    });

    const results = [];
    for (const pool of activePools) {
      try {
        const result = await this.calculatePoolValue(pool.pool_id);
        if (result) results.push(result);
      } catch (err) {
        this.logger.error(
          `Failed to update value for pool ${pool.pool_id}: ${err.message}`,
        );
      }
    }

    return results;
  }
}
