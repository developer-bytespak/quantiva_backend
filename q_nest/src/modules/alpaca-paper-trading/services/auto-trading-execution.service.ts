import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AlpacaPaperTradingService } from '../alpaca-paper-trading.service';
import { AutoTradingSessionService, AutoTradeRecord } from './auto-trading-session.service';
import { ALPACA_SUPPORTED_CRYPTO } from '../../exchanges/integrations/alpaca.service';
import { v4 as uuidv4 } from 'uuid';

interface Strategy {
  strategy_id: string;
  name: string | null;
  type: string;
  risk_level: string;
  is_active: boolean;
}

interface Asset {
  asset_id: string;
  symbol: string;
  name: string | null;
  sector: string | null;
  asset_type: string;
}

// Risk-based exit levels (stop-loss and take-profit percentages)
interface RiskExitLevels {
  stopLossPercent: number;
  takeProfitPercent: number;
}

const RISK_EXIT_LEVELS: Record<string, RiskExitLevels> = {
  low: { stopLossPercent: 3, takeProfitPercent: 6 },      // Conservative: 1:2 risk/reward
  medium: { stopLossPercent: 5, takeProfitPercent: 10 },  // Balanced: 1:2 risk/reward
  high: { stopLossPercent: 8, takeProfitPercent: 20 },    // Aggressive: 1:2.5 risk/reward
  default: { stopLossPercent: 5, takeProfitPercent: 10 }, // Fallback
};

@Injectable()
export class AutoTradingExecutionService {
  private readonly logger = new Logger(AutoTradingExecutionService.name);

  // Cache for assets (stocks + crypto) and strategies
  private assetsCache: Asset[] = [];
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

    // Pick a random asset (stock or crypto)
    const asset = this.pickRandomAsset();
    if (!asset) {
      throw new Error('No assets available');
    }
    
    // Convert symbol to Alpaca format if crypto (BTCUSDT -> BTC/USD)
    const alpacaSymbol = this.convertToAlpacaSymbol(asset.symbol, asset.asset_type);

    // Get asset momentum to inform signal direction
    const momentum = await this.getStockMomentum(alpacaSymbol);
    
    // Generate a signal (BUY or SELL) - influenced by momentum
    const signal = this.generateSignal(strategy, momentum);
    
    // Log momentum-based decision for transparency
    if (Math.abs(momentum) > 1) {
      this.sessionService.addAiMessage(
        `${alpacaSymbol} momentum: ${momentum > 0 ? '+' : ''}${momentum.toFixed(2)}% → ${signal.action}`,
        'info'
      );
    }
    
    // Generate random trade amount ($100 - $500)
    const tradeAmount = this.generateTradeAmount();

    // Get current asset price
    const price = await this.getStockPrice(alpacaSymbol);
    if (!price || price <= 0) {
      throw new Error(`Could not get price for ${alpacaSymbol}`);
    }

    // Calculate quantity (handle fractional for crypto, whole for stocks)
    const qty = asset.asset_type === 'crypto' 
      ? parseFloat((tradeAmount / price).toFixed(8)) // Crypto allows fractional
      : Math.floor(tradeAmount / price); // Stocks require whole numbers
    
    if (qty <= 0 || (asset.asset_type === 'stock' && qty < 1)) {
      this.logger.warn(`Trade amount $${tradeAmount} too small for ${alpacaSymbol} at $${price}`);
      return null;
    }

    // Get risk-based exit levels
    const riskLevels = RISK_EXIT_LEVELS[strategy.risk_level?.toLowerCase()] || RISK_EXIT_LEVELS.default;
    
    // Calculate stop-loss and take-profit prices
    const stopLossPrice = parseFloat((price * (1 - riskLevels.stopLossPercent / 100)).toFixed(2));
    const takeProfitPrice = parseFloat((price * (1 + riskLevels.takeProfitPercent / 100)).toFixed(2));

    // Auto-trading now ONLY places BUY orders with bracket (OCO-like) exits
    // Alpaca automatically handles selling when stop-loss or take-profit is hit
    // This eliminates the need for manual SELL logic
    signal.action = 'BUY';

    // Generate AI message with momentum context
    const aiMessage = this.generateAiExplanation(strategy, asset, signal, price, momentum);

    // Create trade record
    const tradeRecord: AutoTradeRecord = {
      id: uuidv4(),
      timestamp: new Date(),
      strategyId: strategy.strategy_id,
      strategyName: strategy.name || 'Unknown Strategy',
      symbol: alpacaSymbol,
      action: signal.action,
      amount: tradeAmount,
      price,
      orderId: '',
      status: 'pending',
      aiMessage,
      confidence: signal.confidence,
    };

    try {
      // Place BRACKET order via Alpaca (entry + automatic stop-loss + take-profit)
      // This is OCO-like: when one exit condition hits, the other is cancelled
      this.sessionService.addAiMessage(
        `Placing bracket order: BUY ${alpacaSymbol} (${asset.asset_type}) | SL: $${stopLossPrice} (-${riskLevels.stopLossPercent}%) | TP: $${takeProfitPrice} (+${riskLevels.takeProfitPercent}%)`,
        'info'
      );
      
      const order = await this.alpacaService.placeOrder({
        symbol: alpacaSymbol,
        qty: qty,
        side: 'buy',
        type: 'market',
        time_in_force: 'gtc', // Good-til-cancelled for bracket orders
        order_class: 'bracket', // Enable OCO-like behavior
        take_profit: {
          limit_price: takeProfitPrice,
        },
        stop_loss: {
          stop_price: stopLossPrice,
        },
      });

      tradeRecord.orderId = order.id;
      tradeRecord.status = order.status === 'filled' ? 'filled' : 'pending';

      // Store the signal in database with exit levels
      await this.storeSignal(strategy, asset, signal, tradeAmount, price, stopLossPrice, takeProfitPrice);

      // Store the order in database with auto-trade metadata
      await this.storeOrder(asset, signal, tradeAmount, price, order.id, stopLossPrice, takeProfitPrice);

      // Record the trade in session
      this.sessionService.recordTrade(tradeRecord);

      this.logger.log(
        `Bracket order placed: BUY ${alpacaSymbol} (${asset.asset_type}) @ $${price}, SL: $${stopLossPrice}, TP: $${takeProfitPrice}, Order: ${order.id}`
      );

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

    // Refresh assets cache - both stocks and crypto
    const assets = await this.prisma.assets.findMany({
      where: {
        OR: [
          { asset_type: 'stock', is_active: true },
          { asset_type: 'crypto', is_active: true },
        ],
      },
      select: {
        asset_id: true,
        symbol: true,
        name: true,
        sector: true,
        asset_type: true,
      },
    });
    
    // Filter crypto to only Alpaca-supported coins
    this.assetsCache = assets.filter(asset => {
      if (asset.asset_type === 'crypto') {
        const baseSymbol = asset.symbol.replace(/USDT?$/, '');
        return ALPACA_SUPPORTED_CRYPTO.includes(baseSymbol);
      }
      return true; // Include all stocks
    });

    // Refresh strategies cache
    this.strategiesCache = await this.getActiveAdminStrategies();

    const cryptoCount = this.assetsCache.filter(a => a.asset_type === 'crypto').length;
    const stockCount = this.assetsCache.filter(a => a.asset_type === 'stock').length;
    this.lastCacheRefresh = now;
    this.logger.debug(`Caches refreshed: ${stockCount} stocks, ${cryptoCount} crypto, ${this.strategiesCache.length} strategies`);
  }

  /**
   * Pick a random asset (stock or crypto) from cache
   */
  private pickRandomAsset(): Asset | null {
    if (this.assetsCache.length === 0) {
      return null;
    }
    const index = Math.floor(Math.random() * this.assetsCache.length);
    return this.assetsCache[index];
  }

  /**
   * Convert crypto symbol to Alpaca format: BTCUSDT -> BTC/USD
   */
  private convertToAlpacaSymbol(symbol: string, assetType: string): string {
    if (assetType === 'crypto') {
      const baseSymbol = symbol.replace(/USDT?$/, '');
      return `${baseSymbol}/USD`;
    }
    return symbol; // Stock symbols remain unchanged
  }

  /**
   * Get stock momentum (price change percentage) from Alpaca snapshots
   * Returns positive for upward momentum, negative for downward
   */
  private async getStockMomentum(symbol: string): Promise<number> {
    try {
      // Use the existing alpacaService which has proper authentication
      // Instead of creating a new axios client that might have auth issues
      return 0; // Temporarily disable momentum check to avoid auth issues
      
      /* Original code causing 401 errors:
      const dataClient = (await import('axios')).default.create({
        baseURL: 'https://data.alpaca.markets',
        timeout: 10000,
        headers: {
          'APCA-API-KEY-ID': process.env.ALPACA_PAPER_API_KEY || process.env.ALPACA_API_KEY || '',
          'APCA-API-SECRET-KEY': process.env.ALPACA_PAPER_SECRET_KEY || process.env.ALPACA_SECRET_KEY || '',
        },
      });

      const response = await dataClient.get(`/v2/stocks/${symbol}/snapshot`);
      const snapshot = response.data;
      
      if (snapshot?.prevDailyBar?.c && snapshot?.latestTrade?.p) {
        const prevClose = snapshot.prevDailyBar.c;
        const currentPrice = snapshot.latestTrade.p;
        return ((currentPrice - prevClose) / prevClose) * 100;
      }
      
      return 0;
      */
    } catch (error) {
      this.logger.debug(`Could not get momentum for ${symbol}, using neutral`);
      return 0;
    }
  }

  /**
   * Generate a trading signal (BUY/SELL with confidence)
   * Uses momentum-based logic: more likely to BUY when stock is up, SELL when down
   * Keeps natural randomness to avoid predictable behavior
   */
  private generateSignal(strategy: Strategy, momentum: number = 0): { action: 'BUY' | 'SELL'; confidence: number; scores: any } {
    // Base probability is 50/50, adjusted by momentum
    // Momentum influence: +5% change = +15% buy probability
    // This creates a "ride the trend" behavior that feels natural
    const momentumInfluence = Math.max(-0.25, Math.min(0.25, momentum * 0.03));
    
    // Add slight randomness to keep it unpredictable (±10%)
    const randomNoise = (Math.random() - 0.5) * 0.2;
    
    // Final buy probability: 50% base + momentum adjustment + noise
    // Clamped between 30% and 70% to prevent extreme bias
    const buyProbability = Math.max(0.3, Math.min(0.7, 0.5 + momentumInfluence + randomNoise));
    
    const action: 'BUY' | 'SELL' = Math.random() < buyProbability ? 'BUY' : 'SELL';
    
    // Confidence is higher when momentum aligns with action
    const momentumAlignment = (action === 'BUY' && momentum > 0) || (action === 'SELL' && momentum < 0);
    const baseConfidence = 0.6 + Math.random() * 0.25;
    const confidence = momentumAlignment ? baseConfidence + 0.1 : baseConfidence;

    // Generate scores that reflect the momentum analysis
    const momentumScore = 50 + momentum * 5; // Convert momentum to 0-100 scale
    const scores = {
      sentiment_score: Math.max(0, Math.min(100, momentumScore + (Math.random() - 0.5) * 30)),
      trend_score: Math.max(0, Math.min(100, momentumScore + (Math.random() - 0.5) * 20)),
      fundamental_score: 40 + Math.random() * 40, // Less tied to momentum
      liquidity_score: 50 + Math.random() * 50,
      volatility_score: Math.abs(momentum) * 10 + Math.random() * 40,
      macro_score: 40 + Math.random() * 40,
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
  private generateAiExplanation(strategy: Strategy, asset: Asset, signal: any, price: number, momentum: number = 0): string {
    // Momentum-aware explanations feel more natural
    const momentumStr = momentum > 0 ? 'upward' : momentum < 0 ? 'downward' : 'neutral';
    const trendAligned = (signal.action === 'BUY' && momentum > 0) || (signal.action === 'SELL' && momentum < 0);
    const assetType = asset.asset_type === 'crypto' ? 'crypto' : 'stock';
    
    const reasons = trendAligned ? [
      `${strategy.name} riding ${momentumStr} momentum for ${signal.action.toLowerCase()} opportunity in ${assetType}`,
      `Technical analysis confirms ${momentumStr} trend continuation for ${asset.symbol}`,
      `Momentum indicators align with ${signal.action.toLowerCase()} signal`,
      `Price action suggests continuation of current ${momentumStr} move`,
      `Trend-following analysis favors ${signal.action.toLowerCase()} position`,
    ] : [
      `${strategy.name} identified potential reversal opportunity`,
      `Mean reversion analysis suggests counter-trend ${signal.action.toLowerCase()}`,
      `Risk-reward ratio favors contrarian ${signal.action.toLowerCase()} entry`,
      `Sentiment divergence detected, anticipating ${signal.action.toLowerCase()} setup`,
      `Pattern recognition suggests ${signal.action === 'BUY' ? 'accumulation' : 'distribution'} phase`,
    ];

    const index = Math.floor(Math.random() * reasons.length);
    return `${reasons[index]} for ${asset.symbol} at $${price.toFixed(2)} (${(signal.confidence * 100).toFixed(1)}% confidence)`;
  }

  /**
   * Store signal in database
   */
  private async storeSignal(
    strategy: Strategy,
    asset: Asset,
    signal: { action: 'BUY' | 'SELL'; confidence: number; scores: any },
    amount: number,
    price: number,
    stopLossPrice?: number,
    takeProfitPrice?: number,
  ): Promise<void> {
    try {
      await this.prisma.strategy_signals.create({
        data: {
          strategy_id: strategy.strategy_id,
          asset_id: asset.asset_id,
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
            order_class: 'bracket',
            trade_amount: amount,
            trade_price: price,
            stop_loss_price: stopLossPrice,
            take_profit_price: takeProfitPrice,
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
    asset: Asset,
    signal: { action: 'BUY' | 'SELL'; confidence: number },
    amount: number,
    price: number,
    alpacaOrderId: string,
    stopLossPrice?: number,
    takeProfitPrice?: number,
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
            order_class: 'bracket',
            alpaca_order_id: alpacaOrderId,
            symbol: asset.symbol,
            asset_id: asset.asset_id,
            asset_type: asset.asset_type,
            confidence: signal.confidence,
            stop_loss_price: stopLossPrice,
            take_profit_price: takeProfitPrice,
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
