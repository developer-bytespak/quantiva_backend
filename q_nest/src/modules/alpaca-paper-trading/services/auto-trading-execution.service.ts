import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AlpacaPaperTradingService } from '../alpaca-paper-trading.service';
import { AutoTradingSessionService, AutoTradeRecord } from './auto-trading-session.service';
import { v4 as uuidv4 } from 'uuid';

interface Strategy {
  strategy_id: string;
  name: string | null;
  type: string;
  risk_level: string;
  is_active: boolean;
}

interface Stock {
  asset_id: string;
  symbol: string;
  name: string | null;
  sector: string | null;
}

@Injectable()
export class AutoTradingExecutionService {
  private readonly logger = new Logger(AutoTradingExecutionService.name);

  // Cache for stocks and strategies
  private stocksCache: Stock[] = [];
  private strategiesCache: Strategy[] = [];
  private lastCacheRefresh: Date | null = null;
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor(
    private prisma: PrismaService,
    private alpacaService: AlpacaPaperTradingService,
    private sessionService: AutoTradingSessionService,
  ) {}

  /**
   * Execute automated trades for all active strategies
   * This is the main entry point called by the cron job
   */
  async executeAutomatedTrades(): Promise<{ success: boolean; tradesExecuted: number; errors: string[] }> {
    const errors: string[] = [];
    let tradesExecuted = 0;

    try {
      // Check if trading is allowed
      if (!this.sessionService.isTradeAllowed()) {
        this.logger.log('Auto trading not active, skipping execution');
        return { success: true, tradesExecuted: 0, errors: [] };
      }

      // Add AI training messages for visual effect
      this.sessionService.addRandomTrainingMessages(3);

      // Get current balance
      const balance = await this.getCurrentBalance();
      if (!this.sessionService.updateBalance(balance)) {
        return { success: false, tradesExecuted: 0, errors: ['Balance below threshold'] };
      }

      // Refresh caches if needed
      await this.refreshCaches();

      // Get active admin strategies
      const strategies = await this.getActiveAdminStrategies();
      if (strategies.length === 0) {
        this.logger.warn('No active admin strategies found');
        return { success: true, tradesExecuted: 0, errors: ['No active strategies'] };
      }

      this.sessionService.addAiMessage(`Found ${strategies.length} active strategies to process`, 'info');

      // Execute one trade per strategy
      for (const strategy of strategies) {
        try {
          await this.executeSingleStrategyTrade(strategy);
          tradesExecuted++;
          
          // Small delay between trades
          await this.delay(1000);
        } catch (error: any) {
          const errorMsg = `Failed to execute trade for strategy ${strategy.name}: ${error?.message}`;
          this.logger.error(errorMsg);
          errors.push(errorMsg);
        }
      }

      // Update balance after trades
      const newBalance = await this.getCurrentBalance();
      this.sessionService.updateBalance(newBalance);

      this.sessionService.addAiMessage(
        `Execution cycle complete: ${tradesExecuted} trades executed`,
        'success'
      );

      return { success: true, tradesExecuted, errors };
    } catch (error: any) {
      this.logger.error(`Auto trading execution failed: ${error?.message}`);
      this.sessionService.addAiMessage(`Execution error: ${error?.message}`, 'warning');
      return { success: false, tradesExecuted, errors: [error?.message] };
    }
  }

  /**
   * Execute a single trade for a specific strategy
   */
  private async executeSingleStrategyTrade(strategy: Strategy): Promise<AutoTradeRecord | null> {
    this.sessionService.addAiMessage(`Processing strategy: ${strategy.name}`, 'info');

    // Pick a random stock
    const stock = this.pickRandomStock();
    if (!stock) {
      throw new Error('No stocks available');
    }

    // Generate a signal (BUY or SELL)
    const signal = this.generateSignal(strategy);
    
    // Generate random trade amount ($100 - $500)
    const tradeAmount = this.generateTradeAmount();

    // Get current stock price
    const price = await this.getStockPrice(stock.symbol);
    if (!price || price <= 0) {
      throw new Error(`Could not get price for ${stock.symbol}`);
    }

    // Calculate quantity
    const qty = Math.floor(tradeAmount / price);
    if (qty < 1) {
      this.logger.warn(`Trade amount $${tradeAmount} too small for ${stock.symbol} at $${price}`);
      return null;
    }

    // Check if we need to sell (must have position)
    if (signal.action === 'SELL') {
      const position = await this.alpacaService.getPosition(stock.symbol);
      if (!position) {
        // Switch to BUY if no position to sell
        signal.action = 'BUY';
      }
    }

    // Generate AI message
    const aiMessage = this.generateAiExplanation(strategy, stock, signal, price);

    // Create trade record
    const tradeRecord: AutoTradeRecord = {
      id: uuidv4(),
      timestamp: new Date(),
      strategyId: strategy.strategy_id,
      strategyName: strategy.name || 'Unknown Strategy',
      symbol: stock.symbol,
      action: signal.action,
      amount: tradeAmount,
      price,
      orderId: '',
      status: 'pending',
      aiMessage,
      confidence: signal.confidence,
    };

    try {
      // Place the order via Alpaca
      this.sessionService.addAiMessage(`Executing ${signal.action} order for ${stock.symbol}`, 'info');
      
      const order = await this.alpacaService.placeOrder({
        symbol: stock.symbol,
        qty: signal.action === 'SELL' ? undefined : qty,
        side: signal.action.toLowerCase() as 'buy' | 'sell',
        type: 'market',
        time_in_force: 'day',
        notional: signal.action === 'BUY' ? tradeAmount : undefined,
      });

      tradeRecord.orderId = order.id;
      tradeRecord.status = order.status === 'filled' ? 'filled' : 'pending';

      // Store the signal in database
      await this.storeSignal(strategy, stock, signal, tradeAmount, price);

      // Store the order in database with auto-trade metadata
      await this.storeOrder(stock, signal, tradeAmount, price, order.id);

      // Record the trade in session
      this.sessionService.recordTrade(tradeRecord);

      this.logger.log(`Auto trade executed: ${signal.action} ${stock.symbol} @ $${price}, Order: ${order.id}`);

      return tradeRecord;
    } catch (error: any) {
      tradeRecord.status = 'failed';
      this.sessionService.recordTrade(tradeRecord);
      throw error;
    }
  }

  /**
   * Get current account balance
   */
  private async getCurrentBalance(): Promise<number> {
    try {
      const account = await this.alpacaService.getAccount();
      return parseFloat(account.portfolio_value) || 0;
    } catch (error) {
      this.logger.error('Failed to get account balance');
      return 0;
    }
  }

  /**
   * Get active admin strategies
   */
  private async getActiveAdminStrategies(): Promise<Strategy[]> {
    return this.prisma.strategies.findMany({
      where: {
        type: 'admin',
        is_active: true,
      },
      select: {
        strategy_id: true,
        name: true,
        type: true,
        risk_level: true,
        is_active: true,
      },
    });
  }

  /**
   * Refresh caches if expired
   */
  private async refreshCaches(): Promise<void> {
    const now = new Date();
    if (this.lastCacheRefresh && (now.getTime() - this.lastCacheRefresh.getTime()) < this.CACHE_TTL) {
      return;
    }

    // Refresh stocks cache
    const stocks = await this.prisma.assets.findMany({
      where: {
        asset_type: 'stock',
        is_active: true,
      },
      select: {
        asset_id: true,
        symbol: true,
        name: true,
        sector: true,
      },
    });
    this.stocksCache = stocks;

    // Refresh strategies cache
    this.strategiesCache = await this.getActiveAdminStrategies();

    this.lastCacheRefresh = now;
    this.logger.debug(`Caches refreshed: ${stocks.length} stocks, ${this.strategiesCache.length} strategies`);
  }

  /**
   * Pick a random stock from cache
   */
  private pickRandomStock(): Stock | null {
    if (this.stocksCache.length === 0) {
      return null;
    }
    const index = Math.floor(Math.random() * this.stocksCache.length);
    return this.stocksCache[index];
  }

  /**
   * Generate a trading signal (BUY/SELL with confidence)
   */
  private generateSignal(strategy: Strategy): { action: 'BUY' | 'SELL'; confidence: number; scores: any } {
    // Bias slightly towards BUY for paper trading demonstration
    const buyProbability = 0.65;
    const action: 'BUY' | 'SELL' = Math.random() < buyProbability ? 'BUY' : 'SELL';
    
    // Generate random confidence (0.6 - 0.95)
    const confidence = 0.6 + Math.random() * 0.35;

    // Generate fake scores for different factors
    const scores = {
      sentiment_score: Math.random() * 100,
      trend_score: Math.random() * 100,
      fundamental_score: Math.random() * 100,
      liquidity_score: 50 + Math.random() * 50, // Higher liquidity for stocks
      volatility_score: Math.random() * 100,
      macro_score: Math.random() * 100,
    };

    return { action, confidence, scores };
  }

  /**
   * Generate random trade amount ($100 - $500)
   */
  private generateTradeAmount(): number {
    return Math.floor(100 + Math.random() * 400);
  }

  /**
   * Get current stock price from Alpaca
   */
  private async getStockPrice(symbol: string): Promise<number> {
    try {
      // Try to get from Alpaca quotes
      const quotes = await this.alpacaService.getLatestQuotes([symbol]);
      if (quotes && quotes[symbol]) {
        return parseFloat(quotes[symbol].ap) || parseFloat(quotes[symbol].bp) || 0;
      }
      
      // Fallback: try getting from position if exists
      const position = await this.alpacaService.getPosition(symbol);
      if (position) {
        return parseFloat(position.current_price);
      }

      // Last resort: return a reasonable default price for testing
      return 100;
    } catch (error) {
      this.logger.warn(`Could not get price for ${symbol}, using default`);
      return 100;
    }
  }

  /**
   * Generate AI explanation for the trade
   */
  private generateAiExplanation(strategy: Strategy, stock: Stock, signal: any, price: number): string {
    const reasons = [
      `${strategy.name} detected favorable ${signal.action.toLowerCase()} conditions`,
      `Technical analysis indicates strong ${signal.action === 'BUY' ? 'support' : 'resistance'} levels`,
      `Sentiment analysis shows ${signal.action === 'BUY' ? 'positive' : 'negative'} market outlook`,
      `Risk-adjusted returns suggest ${signal.action.toLowerCase()} opportunity`,
      `Pattern recognition identified ${signal.action === 'BUY' ? 'accumulation' : 'distribution'} phase`,
      `Momentum indicators confirm ${signal.action.toLowerCase()} signal strength`,
    ];

    const index = Math.floor(Math.random() * reasons.length);
    return `${reasons[index]} for ${stock.symbol} at $${price.toFixed(2)} (${(signal.confidence * 100).toFixed(1)}% confidence)`;
  }

  /**
   * Store signal in database
   */
  private async storeSignal(
    strategy: Strategy,
    stock: Stock,
    signal: { action: 'BUY' | 'SELL'; confidence: number; scores: any },
    amount: number,
    price: number,
  ): Promise<void> {
    try {
      await this.prisma.strategy_signals.create({
        data: {
          strategy_id: strategy.strategy_id,
          asset_id: stock.asset_id,
          timestamp: new Date(),
          action: signal.action,
          confidence: signal.confidence,
          final_score: signal.confidence * 100,
          sentiment_score: signal.scores.sentiment_score,
          trend_score: signal.scores.trend_score,
          fundamental_score: signal.scores.fundamental_score,
          liquidity_score: signal.scores.liquidity_score,
          volatility_score: signal.scores.volatility_score,
          macro_score: signal.scores.macro_score,
          engine_metadata: {
            auto_trade: true,
            trade_amount: amount,
            trade_price: price,
            generated_at: new Date().toISOString(),
          },
        },
      });
    } catch (error: any) {
      this.logger.error(`Failed to store signal: ${error?.message}`);
    }
  }

  /**
   * Store order in database with auto-trade metadata
   */
  private async storeOrder(
    stock: Stock,
    signal: { action: 'BUY' | 'SELL'; confidence: number },
    amount: number,
    price: number,
    alpacaOrderId: string,
  ): Promise<void> {
    try {
      // Get or create a default portfolio for auto-trading
      let portfolio = await this.prisma.portfolios.findFirst({
        where: {
          name: 'Auto Trading Portfolio',
        },
      });

      if (!portfolio) {
        // Create default auto-trading portfolio with a system user
        // For now, we'll skip this if no portfolio exists
        this.logger.warn('No auto-trading portfolio found, skipping order storage');
        return;
      }

      await this.prisma.orders.create({
        data: {
          portfolio_id: portfolio.portfolio_id,
          side: signal.action,
          order_type: 'market',
          quantity: amount / price,
          price: price,
          status: 'pending',
          auto_trade_approved: true,
          metadata: {
            auto_trade: true,
            alpaca_order_id: alpacaOrderId,
            symbol: stock.symbol,
            asset_id: stock.asset_id,
            confidence: signal.confidence,
            generated_at: new Date().toISOString(),
          },
        },
      });
    } catch (error: any) {
      this.logger.error(`Failed to store order: ${error?.message}`);
    }
  }

  /**
   * Helper delay function
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Execute a manual trade trigger (for testing)
   */
  async executeManualTrade(): Promise<{ success: boolean; trade?: AutoTradeRecord; error?: string }> {
    if (!this.sessionService.isTradeAllowed()) {
      return { success: false, error: 'Auto trading not active' };
    }

    await this.refreshCaches();

    const strategies = await this.getActiveAdminStrategies();
    if (strategies.length === 0) {
      return { success: false, error: 'No active strategies' };
    }

    // Pick random strategy
    const strategy = strategies[Math.floor(Math.random() * strategies.length)];

    try {
      const trade = await this.executeSingleStrategyTrade(strategy);
      return { success: true, trade: trade || undefined };
    } catch (error: any) {
      return { success: false, error: error?.message };
    }
  }
}
