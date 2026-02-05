import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AlpacaService } from '../exchanges/integrations/alpaca.service';
import { SignalAction } from '@prisma/client';

/**
 * Position Synchronization Service
 *
 * Synchronizes paper trading order fills with portfolio positions.
 * This ensures that:
 * 1. Portfolio positions reflect paper trading fills
 * 2. PnL is calculated correctly
 * 3. Position history is maintained
 */
@Injectable()
export class PositionSyncService {
  private readonly logger = new Logger(PositionSyncService.name);

  constructor(
    private prisma: PrismaService,
    private alpacaService: AlpacaService,
  ) {}

  /**
   * Sync all paper trading orders with portfolio positions
   * Called periodically to update positions based on actual fills
   */
  async syncAllPositions() {
    try {
      this.logger.log('Starting position synchronization');

      // Get all auto-executed orders that were placed on paper trading
      const autoTradedOrders = await this.prisma.orders.findMany({
        where: {
          auto_trade_approved: true,
          metadata: {
            path: ['alpaca_order_id'],
            not: null,
          },
        },
        include: {
          signal: {
            include: {
              asset: true,
            },
          },
          executions: true,
          portfolio: true,
        },
      });

      if (autoTradedOrders.length === 0) {
        this.logger.debug('No auto-traded orders found');
        return;
      }

      // Get current paper trading positions
      if (!this.alpacaService.isConfigured()) {
        this.logger.warn('Alpaca not configured. Skipping position sync.');
        return;
      }

      const positions = await this.alpacaService.getPositions();
      const positionMap = new Map<string, any>();

      for (const position of positions) {
        positionMap.set(position.symbol, position);
      }

      // Update each position based on current holdings
      for (const order of autoTradedOrders) {
        if (!order.signal?.asset) continue;

        const asset = order.signal.asset;
        const alpacaSymbol = order.metadata?.alpaca_symbol;
        
        if (!alpacaSymbol) continue;

        const position = positionMap.get(alpacaSymbol);
        const currentHolding = position ? parseFloat(position.qty) : 0;

        await this.updatePositionFromHolding(
          order.portfolio_id,
          asset.asset_id,
          currentHolding,
          order,
        );
      }

      this.logger.log('Position synchronization completed');
    } catch (error: any) {
      this.logger.error(`Error syncing positions: ${error.message}`, error.stack);
    }
  }

  /**
   * Update portfolio position based on current holdings
   */
  private async updatePositionFromHolding(
    portfolioId: string,
    assetId: string,
    currentQuantity: number,
    order: any,
  ) {
    try {
      // Get or create position
      let position = await this.prisma.portfolio_positions.findUnique({
        where: {
          portfolio_id_asset_id: {
            portfolio_id: portfolioId,
            asset_id: assetId,
          },
        },
      });

      if (!position) {
        // Create new position
        position = await this.prisma.portfolio_positions.create({
          data: {
            portfolio_id: portfolioId,
            asset_id: assetId,
            quantity: currentQuantity,
            avg_entry_price: order.price,
            current_price: order.price,
            unrealized_pnl: 0,
            realized_pnl: 0,
          },
        });

        this.logger.debug(
          `Created new position: ${assetId} qty=${currentQuantity}`,
        );
      } else {
        // Update position quantity
        const quantityDiff = currentQuantity - position.quantity;

        // Calculate new average entry price if adding to position
        let newAvgPrice = position.avg_entry_price;
        if (quantityDiff > 0 && order.price) {
          const totalCost =
            (position.quantity || 0) * (position.avg_entry_price || 0) +
            quantityDiff * order.price;
          const totalQty = (position.quantity || 0) + quantityDiff;
          newAvgPrice = totalQty > 0 ? totalCost / totalQty : position.avg_entry_price;
        }

        // Update position
        position = await this.prisma.portfolio_positions.update({
          where: {
            portfolio_id_asset_id: {
              portfolio_id: portfolioId,
              asset_id: assetId,
            },
          },
          data: {
            quantity: currentQuantity,
            avg_entry_price: newAvgPrice,
          },
        });

        this.logger.debug(
          `Updated position: ${assetId} qty=${currentQuantity} avg_entry=${newAvgPrice}`,
        );
      }

      return position;
    } catch (error: any) {
      this.logger.error(
        `Error updating position for ${assetId}: ${error.message}`,
      );
    }
  }

  /**
   * Calculate realized PnL from closed positions
   */
  async calculateRealizedPnL(portfolioId: string, assetId: string) {
    try {
      // Get all order executions for this position
      const executions = await this.prisma.order_executions.findMany({
        include: {
          order: {
            include: {
              signal: true,
            },
          },
        },
      });

      let realizedPnL = 0;
      let costBasis = 0;

      // Process executions in chronological order
      const sortedExecutions = executions.sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      );

      for (const exec of sortedExecutions) {
        if (exec.order?.signal?.asset_id !== assetId) continue;

        const executionValue = exec.price * exec.quantity;

        if (exec.order.side === SignalAction.BUY) {
          costBasis += executionValue;
        } else if (exec.order.side === SignalAction.SELL) {
          // Calculate PnL on sale
          const proceeds = executionValue;
          const cost = (costBasis / exec.quantity) * exec.quantity;
          realizedPnL += proceeds - cost - (exec.fee || 0);

          costBasis = Math.max(0, costBasis - cost);
        }
      }

      return realizedPnL;
    } catch (error: any) {
      this.logger.error(
        `Error calculating realized PnL: ${error.message}`,
      );
      return 0;
    }
  }

  /**
   * Calculate unrealized PnL for open positions
   */
  async calculateUnrealizedPnL(
    portfolioId: string,
    assetId: string,
    currentPrice: number,
  ) {
    try {
      const position = await this.prisma.portfolio_positions.findUnique({
        where: {
          portfolio_id_asset_id: {
            portfolio_id: portfolioId,
            asset_id: assetId,
          },
        },
      });

      if (!position || position.quantity === 0) {
        return 0;
      }

      const costBasis = (position.avg_entry_price || 0) * position.quantity;
      const currentValue = currentPrice * position.quantity;
      const unrealizedPnL = currentValue - costBasis;

      // Update position with current price and unrealized PnL
      await this.prisma.portfolio_positions.update({
        where: {
          portfolio_id_asset_id: {
            portfolio_id: portfolioId,
            asset_id: assetId,
          },
        },
        data: {
          current_price: currentPrice,
          unrealized_pnl: unrealizedPnL,
        },
      });

      return unrealizedPnL;
    } catch (error: any) {
      this.logger.error(
        `Error calculating unrealized PnL: ${error.message}`,
      );
      return 0;
    }
  }

  /**
   * Get complete portfolio performance metrics
   */
  async getPortfolioMetrics(portfolioId: string) {
    try {
      const positions = await this.prisma.portfolio_positions.findMany({
        where: { portfolio_id: portfolioId },
        include: {
          asset: true,
        },
      });

      let totalInvested = 0;
      let totalCurrentValue = 0;
      let totalUnrealizedPnL = 0;
      let totalRealizedPnL = 0;

      for (const position of positions) {
        const invested = (position.avg_entry_price || 0) * position.quantity;
        const current = (position.current_price || 0) * position.quantity;

        totalInvested += invested;
        totalCurrentValue += current;
        totalUnrealizedPnL += position.unrealized_pnl || 0;
        totalRealizedPnL += position.realized_pnl || 0;
      }

      const totalPnL = totalUnrealizedPnL + totalRealizedPnL;
      const returnPercent =
        totalInvested > 0 ? (totalPnL / totalInvested) * 100 : 0;

      return {
        total_invested: totalInvested,
        total_current_value: totalCurrentValue,
        total_unrealized_pnl: totalUnrealizedPnL,
        total_realized_pnl: totalRealizedPnL,
        total_pnl: totalPnL,
        return_percent: returnPercent,
        positions: positions.map(p => ({
          asset_id: p.asset_id,
          asset_symbol: p.asset?.symbol,
          quantity: p.quantity,
          avg_entry_price: p.avg_entry_price,
          current_price: p.current_price,
          unrealized_pnl: p.unrealized_pnl,
          realized_pnl: p.realized_pnl,
          invested: (p.avg_entry_price || 0) * p.quantity,
          current_value: (p.current_price || 0) * p.quantity,
        })),
      };
    } catch (error: any) {
      this.logger.error(`Error getting portfolio metrics: ${error.message}`);
      return null;
    }
  }
}
