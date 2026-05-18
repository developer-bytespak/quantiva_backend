import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';
import { AlpacaService } from '../../exchanges/integrations/alpaca.service';
import { SignalsService } from '../../signals/signals.service';
import { PortfolioService } from '../../portfolio/portfolio.service';
import { SignalAction } from '@prisma/client';
import { ConfigService } from '@nestjs/config';

/**
 * Paper Trading Automation Service
 *
 * Monitors signals and automatically executes trades on Alpaca paper trading when:
 * 1. Signal confidence exceeds strategy's auto_trade_threshold
 * 2. Position sizing is available from signal details
 * 3. Account has sufficient balance on paper account
 *
 * Features:
 * - Automatic order placement when thresholds are met
 * - Order linking to signals in database
 * - Position tracking and synchronization
 * - Error handling and recovery
 */
// Look-back window for "recent unexecuted" signals (5 minutes). Wider than
// the 30-second cron interval so we don't miss signals on cron skew or
// service restarts. Anything older than this is considered stale market
// data and is intentionally ignored — see `processNewSignals()`.
const RECENT_SIGNAL_WINDOW_MS = 5 * 60 * 1000;

@Injectable()
export class PaperTradingService {
  private readonly logger = new Logger(PaperTradingService.name);
  private isTickRunning = false; // Prevent overlapping cron ticks

  constructor(
    private prisma: PrismaService,
    private alpacaService: AlpacaService,
    private signalsService: SignalsService,
    private portfolioService: PortfolioService,
    private configService: ConfigService,
  ) {}

  /**
   * Cron-driven replacement for the old `while(true)` 10-second polling loop.
   *
   * Fires every 30 seconds. Gated by `ENABLE_PAPER_AUTO_TRADER` env var so
   * the trader can be turned off in production without code changes. Skips
   * its own tick if a previous tick is still running to avoid overlap on
   * slow Alpaca responses.
   *
   * Trades are placed on Alpaca PAPER (fake money) — see ALPACA_API_KEY
   * in .env, which is a `PK*` paper key, not a live `AK*` key.
   */
  @Cron('*/30 * * * * *')
  async pollNewSignals(): Promise<void> {
    if (this.configService.get('ENABLE_PAPER_AUTO_TRADER') !== 'true') {
      return;
    }
    if (this.isTickRunning) {
      return;
    }
    this.isTickRunning = true;
    try {
      await this.processNewSignals();
    } catch (error: any) {
      this.logger.error(
        `Error in paper trading cron tick: ${error.message}`,
        error.stack,
      );
    } finally {
      this.isTickRunning = false;
    }
  }

  /**
   * Process new signals that haven't been auto-executed yet
   * Finds signals with high confidence and converts them to testnet orders
   */
  private async processNewSignals() {
    try {
      // Find signals from the recent window that:
      // 1. Have NOT been converted to orders yet (orders.length === 0)
      // 2. Are BUY or SELL actions (not HOLD)
      // 3. Have confidence >= auto_trade_threshold (checked per-signal below)
      //
      // Window matches RECENT_SIGNAL_WINDOW_MS (5 min). Stale signals
      // outside the window are intentionally skipped — we don't want to
      // place trades based on 4-day-old market conditions.

      const cutoff = new Date(Date.now() - RECENT_SIGNAL_WINDOW_MS);

      const unexecutedSignals = await this.prisma.strategy_signals.findMany({
        where: {
          timestamp: {
            gte: cutoff,
          },
          action: {
            in: [SignalAction.BUY, SignalAction.SELL],
          },
          // Only signals that haven't been converted to orders
          orders: {
            none: {},
          },
        },
        include: {
          strategy: true,
          asset: true,
          details: true,
          user: true,
        },
        orderBy: {
          timestamp: 'desc',
        },
        take: 50, // Process max 50 signals per poll
      });

      if (unexecutedSignals.length > 0) {
        this.logger.debug(`Found ${unexecutedSignals.length} unexecuted signals`);
      }

      // Process each signal
      for (const signal of unexecutedSignals) {
        await this.executeSignalAsOrder(signal);
      }
    } catch (error: any) {
      this.logger.error(`Error processing new signals: ${error.message}`);
    }
  }

  /**
   * Execute a signal as a testnet order if it meets criteria
   */
  private async executeSignalAsOrder(signal: any) {
    try {
      // Get strategy to check auto_trade_threshold
      const strategy = signal.strategy ||
        (await this.prisma.strategies.findUnique({
          where: { strategy_id: signal.strategy_id },
        }));

      if (!strategy) {
        this.logger.warn(`Strategy ${signal.strategy_id} not found for signal ${signal.signal_id}`);
        return;
      }

      // Check if signal confidence meets auto-trade threshold
      const threshold = strategy.auto_trade_threshold || 0.7; // Default 70% confidence
      if (signal.confidence < threshold) {
        this.logger.debug(
          `Signal ${signal.signal_id} confidence (${signal.confidence}) below threshold (${threshold})`,
        );
        return;
      }

      // Get signal details for position sizing
      const signalDetails = signal.details && signal.details.length > 0 ? signal.details[0] : null;
      if (!signalDetails || !signalDetails.position_size) {
        this.logger.warn(
          `Signal ${signal.signal_id} missing position sizing details. Skipping auto-execution.`,
        );
        return;
      }

      // Get asset info
      const asset = signal.asset ||
        (await this.prisma.assets.findUnique({
          where: { asset_id: signal.asset_id },
        }));

      if (!asset || !asset.symbol) {
        this.logger.warn(`Asset ${signal.asset_id} not found or has no symbol`);
        return;
      }

      // Determine paper trading symbol (e.g., BTC -> BTC/USD, ETH -> ETH/USD)
      const paperSymbol = this.getPaperTradingSymbol(asset.symbol, asset.asset_type);

      // Check paper account balance before placing order
      const accountBalance = await this.alpacaService.getAccountBalance();
      const usdBalance = accountBalance.balances.find((b: any) => b.asset === 'USD')?.free || 0;

      if (usdBalance <= 0) {
        this.logger.warn(
          `Insufficient paper USD balance (${usdBalance}) for signal ${signal.signal_id}. Skipping.`,
        );
        return;
      }

      // Place paper trading order
      this.logger.log(
        `Auto-executing signal ${signal.signal_id}: ${signal.action} ${paperSymbol} qty=${signalDetails.position_size} at price=${signalDetails.entry_price}`,
      );

      const orderResult = await this.alpacaService.placeOrder(
        paperSymbol,
        signal.action === SignalAction.BUY ? 'BUY' : 'SELL',
        'MARKET', // Use market orders for immediate execution
        signalDetails.position_size,
        undefined, // No price for market orders
      );

      // Create order record linking to signal
      const order = await this.prisma.orders.create({
        data: {
          portfolio_id: strategy.portfolio_id, // Use strategy's portfolio if available
          signal_id: signal.signal_id,
          side: signal.action,
          order_type: 'MARKET',
          quantity: signalDetails.position_size,
          price: signalDetails.entry_price,
          status: 'FILLED', // Market orders execute immediately
          auto_trade_approved: true,
          // Store Alpaca order ID for tracking
          metadata: {
            alpaca_order_id: orderResult.orderId,
            alpaca_symbol: paperSymbol,
            execution_timestamp: new Date().toISOString(),
          },
        },
      });

      // Create execution record with Alpaca fill information
      if (orderResult.executedQuantity > 0) {
        await this.prisma.order_executions.create({
          data: {
            order_id: order.order_id,
            trade_id: `alpaca_${orderResult.orderId}`,
            price: orderResult.price > 0 ? orderResult.price : orderResult.cumulativeQuoteAssetTransacted / orderResult.executedQuantity,
            quantity: orderResult.executedQuantity,
            fee: 0, // Paper trading doesn't charge fees
            timestamp: new Date(),
          },
        });
      }

      this.logger.log(
        `Successfully auto-executed signal ${signal.signal_id} as order ${order.order_id}`,
      );

      // If this was a BUY order and we have SL/TP levels, place bracket order for automatic exit
      if (signal.action === SignalAction.BUY && orderResult.executedQuantity > 0) {
        await this.placeBracketForPosition(
          signal,
          signalDetails,
          paperSymbol,
          orderResult.executedQuantity,
          order.order_id,
        );
      }
    } catch (error: any) {
      this.logger.error(
        `Error auto-executing signal ${signal.signal_id}: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Places a bracket order to automatically manage stop-loss and take-profit
   * This is called after a successful BUY order to protect the position
   */
  private async placeBracketForPosition(
    signal: any,
    signalDetails: any,
    paperSymbol: string,
    executedQuantity: number,
    parentOrderId: string,
  ): Promise<void> {
    try {
      // Get stop_loss and take_profit from signal details
      const stopLossPercent = signalDetails.stop_loss || 0.05; // Default 5%
      const takeProfitPercent = signalDetails.take_profit || 0.10; // Default 10%
      const entryPrice = signalDetails.entry_price;

      if (!entryPrice || entryPrice <= 0) {
        this.logger.warn(`Cannot place bracket order: No valid entry price for signal ${signal.signal_id}`);
        return;
      }

      // Calculate actual SL and TP prices
      const stopLossPrice = entryPrice * (1 - stopLossPercent);
      const takeProfitPrice = entryPrice * (1 + takeProfitPercent);

      this.logger.log(
        `Placing bracket order for signal ${signal.signal_id}: ` +
        `Entry=${entryPrice}, SL=${stopLossPrice.toFixed(4)} (-${(stopLossPercent * 100).toFixed(1)}%), ` +
        `TP=${takeProfitPrice.toFixed(4)} (+${(takeProfitPercent * 100).toFixed(1)}%)`
      );

      // Place bracket sell order to protect the long position
      const bracketResult = await this.alpacaService.placeBracketOrder(
        paperSymbol,
        'SELL',
        executedQuantity,
        takeProfitPrice,
        stopLossPrice,
      );

      // Update order metadata with bracket information
      await this.prisma.orders.update({
        where: { order_id: parentOrderId },
        data: {
          metadata: {
            alpaca_order_id: parentOrderId,
            alpaca_symbol: paperSymbol,
            execution_timestamp: new Date().toISOString(),
            bracket_order_list_id: bracketResult.orderListId,
            bracket_take_profit_price: takeProfitPrice,
            bracket_stop_loss_price: stopLossPrice,
            bracket_orders: bracketResult.orders,
          },
        },
      });

      this.logger.log(
        `Bracket order placed successfully for signal ${signal.signal_id}: orderListId=${bracketResult.orderListId}`
      );
    } catch (error: any) {
      // Log error but don't fail the main order - bracket is enhancement, not critical
      this.logger.error(
        `Failed to place bracket order for signal ${signal.signal_id}: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Convert asset symbol to paper trading symbol
   * e.g., BTC -> BTC/USD, ETH -> ETH/USD
   */
  private getPaperTradingSymbol(symbol: string, assetType: string): string {
    const upperSymbol = symbol.toUpperCase();

    // Crypto: convert to Alpaca format (BTC -> BTC/USD)
    if (assetType === 'crypto' || assetType === 'CRYPTO') {
      // If already in correct format, return as-is
      if (upperSymbol.includes('/')) {
        return upperSymbol;
      }
      // Remove common suffixes and add /USD
      const cleanSymbol = upperSymbol
        .replace('USDT', '')
        .replace('USDC', '')
        .replace('BUSD', '');
      return `${cleanSymbol}/USD`;
    }

    // Stocks: return as-is
    return upperSymbol;
  }

  /**
   * Sync paper trading order fills back to portfolio positions
   * This should be called periodically to update position tracking
   */
  async syncPaperPositions() {
    try {
      this.logger.log('Syncing paper trading positions to portfolio');

      // Get all open orders from Alpaca
      const openOrdersResult = await this.alpacaService.getAllOrders({
        limit: 100,
      });

      if (!openOrdersResult || openOrdersResult.length === 0) {
        return;
      }

      // Get all Alpaca-linked orders from database
      const dbOrders = await this.prisma.orders.findMany({
        where: {
          auto_trade_approved: true,
          metadata: {
            path: ['alpaca_order_id'],
            not: null,
          },
        },
        include: {
          signal: true,
          executions: true,
        },
      });

      // Update positions for filled orders
      for (const dbOrder of dbOrders) {
        const alpacaOrderId = dbOrder.metadata?.alpaca_order_id;
        if (!alpacaOrderId) continue;

        // Find corresponding Alpaca order
        const alpacaOrder = openOrdersResult.find(
          (o: any) => o.id === alpacaOrderId,
        );

        if (alpacaOrder && alpacaOrder.status === 'filled') {
          // Update portfolio position
          await this.updatePortfolioPosition(dbOrder);
        }
      }

      this.logger.log('Paper trading position sync completed');
    } catch (error: any) {
      this.logger.error(`Error syncing paper positions: ${error.message}`);
    }
  }

  /**
   * Update portfolio position based on order fills
   */
  private async updatePortfolioPosition(order: any) {
    try {
      if (!order.signal || !order.signal.asset_id) {
        return;
      }

      // Get or create portfolio position
      const position = await this.prisma.portfolio_positions.upsert({
        where: {
          portfolio_id_asset_id: {
            portfolio_id: order.portfolio_id,
            asset_id: order.signal.asset_id,
          },
        },
        create: {
          portfolio_id: order.portfolio_id,
          asset_id: order.signal.asset_id,
          quantity: order.quantity,
          avg_entry_price: order.price,
          current_price: order.price,
          unrealized_pnl: 0,
          realized_pnl: 0,
        },
        update: {
          // Update quantity and entry price
          quantity: {
            increment: order.side === 'BUY' ? order.quantity : -order.quantity,
          },
        },
      });

      this.logger.debug(
        `Updated portfolio position for asset ${order.signal.asset_id}: ${position.quantity} units`,
      );
    } catch (error: any) {
      this.logger.error(`Error updating portfolio position: ${error.message}`);
    }
  }

  /**
   * Get paper trading statistics
   */
  async getPaperTradingStats(strategyId?: string) {
    try {
      const where: any = {
        auto_trade_approved: true,
      };

      if (strategyId) {
        where.signal = {
          strategy_id: strategyId,
        };
      }

      const orders = await this.prisma.orders.findMany({
        where,
        include: {
          executions: true,
          signal: true,
        },
      });

      const stats = {
        total_orders: orders.length,
        buy_orders: orders.filter(o => o.side === SignalAction.BUY).length,
        sell_orders: orders.filter(o => o.side === SignalAction.SELL).length,
        filled_orders: orders.filter(o => o.status === 'FILLED').length,
        total_volume: 0,
        total_fees: 0,
        trades_with_pnl: 0,
      };

      for (const order of orders) {
        if (order.executions && order.executions.length > 0) {
          for (const exec of order.executions) {
            stats.total_volume += exec.quantity * exec.price;
            stats.total_fees += exec.fee || 0;
          }
        }
      }

      return stats;
    } catch (error: any) {
      this.logger.error(`Error getting paper trading stats: ${error.message}`);
      return null;
    }
  }
}
