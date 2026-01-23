import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { BinanceTestnetService } from '../../binance-testnet/services/binance-testnet.service';
import { SignalsService } from '../../signals/signals.service';
import { PortfolioService } from '../../portfolio/portfolio.service';
import { SignalAction } from '@prisma/client';

/**
 * Paper Trading Automation Service
 *
 * Monitors signals and automatically executes trades on Binance testnet when:
 * 1. Signal confidence exceeds strategy's auto_trade_threshold
 * 2. Position sizing is available from signal details
 * 3. Account has sufficient balance on testnet
 *
 * Features:
 * - Automatic order placement when thresholds are met
 * - Order linking to signals in database
 * - Position tracking and synchronization
 * - Error handling and recovery
 */
@Injectable()
export class PaperTradingService implements OnModuleInit {
  private readonly logger = new Logger(PaperTradingService.name);
  private isRunning = false;
  private pollInterval = 10000; // Poll every 10 seconds for new signals

  constructor(
    private prisma: PrismaService,
    private binanceTestnetService: BinanceTestnetService,
    private signalsService: SignalsService,
    private portfolioService: PortfolioService,
  ) {}

  /**
   * Initialize paper trading service on module init
   * Starts monitoring signals for auto-execution
   */
  onModuleInit() {
    // Only start if testnet is configured
    if (this.binanceTestnetService.isConfigured()) {
      this.logger.log('Starting Paper Trading Automation Service');
      this.startMonitoring();
    } else {
      this.logger.warn('Binance testnet not configured. Paper trading automation disabled.');
    }
  }

  /**
   * Start monitoring signals for auto-execution
   */
  private startMonitoring() {
    if (this.isRunning) {
      this.logger.warn('Monitoring already running');
      return;
    }

    this.isRunning = true;

    // Run monitoring loop
    const monitoringLoop = async () => {
      while (this.isRunning) {
        try {
          await this.processNewSignals();
        } catch (error: any) {
          this.logger.error(
            `Error in paper trading monitoring loop: ${error.message}`,
            error.stack,
          );
        }

        // Wait before next poll
        await new Promise(resolve => setTimeout(resolve, this.pollInterval));
      }
    };

    // Run monitoring in background (don't await)
    monitoringLoop().catch(error =>
      this.logger.error(`Fatal error in monitoring loop: ${error.message}`),
    );
  }

  /**
   * Stop monitoring
   */
  stopMonitoring() {
    this.isRunning = false;
    this.logger.log('Paper Trading Automation Service stopped');
  }

  /**
   * Process new signals that haven't been auto-executed yet
   * Finds signals with high confidence and converts them to testnet orders
   */
  private async processNewSignals() {
    try {
      // Find signals created in the last 10 seconds that:
      // 1. Have NOT been converted to orders yet (orders.length === 0)
      // 2. Are BUY or SELL actions (not HOLD)
      // 3. Have confidence >= auto_trade_threshold from their strategy

      const now = new Date();
      const tenSecondsAgo = new Date(now.getTime() - 10000);

      const unexecutedSignals = await this.prisma.strategy_signals.findMany({
        where: {
          timestamp: {
            gte: tenSecondsAgo,
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

      // Determine testnet symbol (e.g., BTC -> BTCUSDT, AAPL -> AAPL, etc.)
      const testnetSymbol = this.getTestnetSymbol(asset.symbol, asset.asset_type);

      // Check testnet balance before placing order
      const accountBalance = await this.binanceTestnetService.getAccountBalance();
      const usdtBalance = accountBalance.balances.find((b: any) => b.asset === 'USDT')?.free || 0;

      if (usdtBalance <= 0) {
        this.logger.warn(
          `Insufficient testnet USDT balance (${usdtBalance}) for signal ${signal.signal_id}. Skipping.`,
        );
        return;
      }

      // Place testnet order
      this.logger.log(
        `Auto-executing signal ${signal.signal_id}: ${signal.action} ${testnetSymbol} qty=${signalDetails.position_size} at price=${signalDetails.entry_price}`,
      );

      const orderResult = await this.binanceTestnetService.placeOrder(
        testnetSymbol,
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
          // Store testnet order ID for tracking
          metadata: {
            testnet_order_id: orderResult.orderId,
            testnet_symbol: testnetSymbol,
            execution_timestamp: new Date().toISOString(),
          },
        },
      });

      // Create execution record with testnet fill information
      if (orderResult.executedQuantity > 0) {
        await this.prisma.order_executions.create({
          data: {
            order_id: order.order_id,
            trade_id: `testnet_${orderResult.orderId}`,
            price: orderResult.price > 0 ? orderResult.price : orderResult.cumulativeQuoteAssetTransacted / orderResult.executedQuantity,
            quantity: orderResult.executedQuantity,
            fee: 0, // Testnet doesn't charge fees
            timestamp: new Date(),
          },
        });
      }

      this.logger.log(
        `Successfully auto-executed signal ${signal.signal_id} as order ${order.order_id}`,
      );
    } catch (error: any) {
      this.logger.error(
        `Error auto-executing signal ${signal.signal_id}: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Convert asset symbol to testnet trading symbol
   * e.g., BTC -> BTCUSDT, AAPL -> AAPL (if stock)
   */
  private getTestnetSymbol(symbol: string, assetType: string): string {
    const upperSymbol = symbol.toUpperCase();

    // Crypto: append USDT if not already a trading pair
    if (assetType === 'crypto' || assetType === 'CRYPTO') {
      if (!upperSymbol.includes('USDT') && !upperSymbol.includes('USDC') && !upperSymbol.includes('BUSD')) {
        return `${upperSymbol}USDT`;
      }
      return upperSymbol;
    }

    // Stocks: return as-is (testnet might not support stocks)
    return upperSymbol;
  }

  /**
   * Sync testnet order fills back to portfolio positions
   * This should be called periodically to update position tracking
   */
  async syncTestnetPositions() {
    try {
      this.logger.log('Syncing testnet positions to portfolio');

      // Get all open orders from testnet
      const openOrdersResult = await this.binanceTestnetService.getAllOrders({
        limit: 100,
      });

      if (!openOrdersResult || openOrdersResult.length === 0) {
        return;
      }

      // Get all testnet-linked orders from database
      const dbOrders = await this.prisma.orders.findMany({
        where: {
          auto_trade_approved: true,
          metadata: {
            path: ['testnet_order_id'],
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
        const testnetOrderId = dbOrder.metadata?.testnet_order_id;
        if (!testnetOrderId) continue;

        // Find corresponding testnet order
        const testnetOrder = openOrdersResult.find(
          (o: any) => o.orderId === testnetOrderId,
        );

        if (testnetOrder && testnetOrder.status === 'FILLED') {
          // Update portfolio position
          await this.updatePortfolioPosition(dbOrder);
        }
      }

      this.logger.log('Testnet position sync completed');
    } catch (error: any) {
      this.logger.error(`Error syncing testnet positions: ${error.message}`);
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
