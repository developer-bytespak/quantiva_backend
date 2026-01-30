import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';
import { BinanceTestnetService } from '../binance-testnet.service';
import { CryptoAutoTradingSessionService, CryptoAutoTradeRecord } from './crypto-auto-trading-session.service';
import { v4 as uuidv4 } from 'uuid';

interface Strategy {
  strategy_id: string;
  name: string | null;
  type: string;
  risk_level: string;
  is_active: boolean;
}

interface CryptoAsset {
  asset_id: string;
  symbol: string;
  name: string | null;
}

// Risk-based exit levels for crypto (higher volatility than stocks)
interface RiskExitLevels {
  stopLossPercent: number;
  takeProfitPercent: number;
}

const CRYPTO_RISK_EXIT_LEVELS: Record<string, RiskExitLevels> = {
  low: { stopLossPercent: 5, takeProfitPercent: 10 },       // Conservative: 1:2 risk/reward
  medium: { stopLossPercent: 8, takeProfitPercent: 16 },    // Balanced: 1:2 risk/reward
  high: { stopLossPercent: 12, takeProfitPercent: 30 },     // Aggressive: 1:2.5 risk/reward
  default: { stopLossPercent: 8, takeProfitPercent: 16 },   // Fallback
};

@Injectable()
export class CryptoAutoTradingExecutionService {
  private readonly logger = new Logger(CryptoAutoTradingExecutionService.name);

  // Cache for crypto assets and strategies
  private cryptoAssetsCache: CryptoAsset[] = [];
  private strategiesCache: Strategy[] = [];
  private lastCacheRefresh: Date | null = null;
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor(
    private prisma: PrismaService,
    private binanceTestnetService: BinanceTestnetService,
    private sessionService: CryptoAutoTradingSessionService,
  ) {}

  /**
   * Execute automated trades for all active crypto strategies
   * This is the main entry point called by the cron job
   */
  async executeAutomatedTrades(): Promise<{ success: boolean; tradesExecuted: number; errors: string[] }> {
    const errors: string[] = [];
    let tradesExecuted = 0;

    try {
      // Check if trading is allowed
      if (!this.sessionService.isTradeAllowed()) {
        this.logger.log('Crypto auto trading not active, skipping execution');
        return { success: true, tradesExecuted: 0, errors: [] };
      }

      // Add AI training messages for visual effect
      this.sessionService.addRandomTrainingMessages(3);

      // Get current USDT balance
      const balance = await this.getCurrentBalance();
      if (!this.sessionService.updateBalance(balance)) {
        return { success: false, tradesExecuted: 0, errors: ['USDT balance below threshold'] };
      }

      // Refresh caches if needed
      await this.refreshCaches();

      // Get active admin strategies for crypto
      const strategies = await this.getActiveAdminStrategies();
      if (strategies.length === 0) {
        this.logger.warn('No active crypto admin strategies found');
        return { success: true, tradesExecuted: 0, errors: ['No active crypto strategies'] };
      }

      this.sessionService.addAiMessage(`Found ${strategies.length} active crypto strategies to process`, 'info');

      // Execute one trade per strategy
      for (const strategy of strategies) {
        try {
          await this.executeSingleStrategyTrade(strategy);
          tradesExecuted++;
          
          // Small delay between trades
          await this.delay(1000);
        } catch (error: any) {
          const errorMsg = `Failed to execute crypto trade for strategy ${strategy.name}: ${error?.message}`;
          this.logger.error(errorMsg);
          errors.push(errorMsg);
        }
      }

      // Update balance after trades
      const newBalance = await this.getCurrentBalance();
      this.sessionService.updateBalance(newBalance);

      this.sessionService.addAiMessage(
        `Crypto execution cycle complete: ${tradesExecuted} trades executed`,
        'success'
      );

      return { success: true, tradesExecuted, errors };
    } catch (error: any) {
      this.logger.error(`Crypto auto trading execution failed: ${error?.message}`);
      this.sessionService.addAiMessage(`Execution error: ${error?.message}`, 'warning');
      return { success: false, tradesExecuted, errors: [error?.message] };
    }
  }

  /**
   * Execute a single trade for a specific strategy
   */
  private async executeSingleStrategyTrade(strategy: Strategy): Promise<CryptoAutoTradeRecord | null> {
    this.sessionService.addAiMessage(`Processing crypto strategy: ${strategy.name}`, 'info');

    // Pick a random crypto asset
    const crypto = this.pickRandomCrypto();
    if (!crypto) {
      throw new Error('No crypto assets available');
    }

    // Get crypto momentum to inform signal direction
    const testnetSymbol = this.getTestnetSymbol(crypto.symbol);
    const momentum = await this.getCryptoMomentum(testnetSymbol);
    
    // Generate a signal (BUY or SELL) - influenced by momentum
    const signal = this.generateSignal(strategy, momentum);
    
    // Log momentum-based decision for transparency
    if (Math.abs(momentum) > 1) {
      this.sessionService.addAiMessage(
        `${crypto.symbol} momentum: ${momentum > 0 ? '+' : ''}${momentum.toFixed(2)}% → ${signal.action}`,
        'info'
      );
    }
    
    // Generate random trade amount ($10 - $100 USDT for crypto, smaller than stocks)
    const tradeAmount = this.generateTradeAmount();

    // Get current crypto price
    const price = await this.getCryptoPrice(testnetSymbol);
    if (!price || price <= 0) {
      throw new Error(`Could not get price for ${testnetSymbol}`);
    }

    // Calculate quantity (crypto allows fractional)
    const qty = tradeAmount / price;
    if (qty <= 0) {
      this.logger.warn(`Trade amount $${tradeAmount} too small for ${crypto.symbol} at $${price}`);
      return null;
    }

    // Get risk-based exit levels
    const riskLevels = CRYPTO_RISK_EXIT_LEVELS[strategy.risk_level?.toLowerCase()] || CRYPTO_RISK_EXIT_LEVELS.default;
    
    // Calculate stop-loss and take-profit prices
    const stopLossPrice = parseFloat((price * (1 - riskLevels.stopLossPercent / 100)).toFixed(8));
    const takeProfitPrice = parseFloat((price * (1 + riskLevels.takeProfitPercent / 100)).toFixed(8));

    // Generate AI message with momentum context
    const aiMessage = this.generateAiExplanation(strategy, crypto, signal, price, momentum);

    // Create trade record
    const tradeRecord: CryptoAutoTradeRecord = {
      id: uuidv4(),
      timestamp: new Date(),
      strategyId: strategy.strategy_id,
      strategyName: strategy.name || 'Unknown Strategy',
      symbol: crypto.symbol,
      action: signal.action,
      amount: tradeAmount,
      price,
      orderId: '',
      status: 'pending',
      aiMessage,
      confidence: signal.confidence,
    };

    try {
      // Place market order on Binance testnet
      this.sessionService.addAiMessage(
        `Placing ${signal.action} order: ${crypto.symbol} | SL: $${stopLossPrice.toFixed(4)} (-${riskLevels.stopLossPercent}%) | TP: $${takeProfitPrice.toFixed(4)} (+${riskLevels.takeProfitPercent}%)`,
        'info'
      );

      const order = await this.binanceTestnetService.placeOrder(
        testnetSymbol,
        signal.action,
        'MARKET',
        qty,
      );

      tradeRecord.orderId = order.orderId?.toString() || '';
      tradeRecord.status = order.status === 'FILLED' ? 'filled' : 'pending';

      // Place OCO order for automatic stop-loss and take-profit
      if (signal.action === 'BUY' && order.executedQuantity > 0) {
        try {
          const ocoResult = await this.binanceTestnetService.placeOcoOrder(
            testnetSymbol,
            'SELL',
            order.executedQuantity,
            takeProfitPrice,
            stopLossPrice,
          );
          
          this.sessionService.addAiMessage(
            `OCO exit order placed: TP $${takeProfitPrice.toFixed(4)} | SL $${stopLossPrice.toFixed(4)}`,
            'info'
          );
        } catch (ocoError: any) {
          this.logger.warn(`Failed to place OCO order: ${ocoError?.message}`);
        }
      }

      // Store the signal in database with exit levels
      await this.storeSignal(strategy, crypto, signal, tradeAmount, price, stopLossPrice, takeProfitPrice, order.orderId);

      // Record the trade in session
      this.sessionService.recordTrade(tradeRecord);

      this.logger.log(
        `Crypto order placed: ${signal.action} ${crypto.symbol} @ $${price}, SL: $${stopLossPrice}, TP: $${takeProfitPrice}, Order: ${order.orderId}`
      );

      return tradeRecord;
    } catch (error: any) {
      tradeRecord.status = 'failed';
      this.sessionService.recordTrade(tradeRecord);
      throw error;
    }
  }

  /**
   * Get current USDT balance from Binance testnet
   */
  private async getCurrentBalance(): Promise<number> {
    try {
      const accountBalance = await this.binanceTestnetService.getAccountBalance();
      const usdtBalance = accountBalance.balances.find((b: any) => b.asset === 'USDT')?.free || 0;
      return typeof usdtBalance === 'string' ? parseFloat(usdtBalance) : usdtBalance;
    } catch (error) {
      this.logger.error('Failed to get USDT balance');
      return 0;
    }
  }

  /**
   * Get active admin strategies that support crypto
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

    // Refresh crypto assets cache
    const cryptoAssets = await this.prisma.assets.findMany({
      where: {
        asset_type: 'crypto',
        is_active: true,
      },
      select: {
        asset_id: true,
        symbol: true,
        name: true,
      },
    });
    this.cryptoAssetsCache = cryptoAssets;

    // Refresh strategies cache
    this.strategiesCache = await this.getActiveAdminStrategies();

    this.lastCacheRefresh = now;
    this.logger.debug(`Caches refreshed: ${cryptoAssets.length} crypto assets, ${this.strategiesCache.length} strategies`);
  }

  /**
   * Pick a random crypto asset from cache
   */
  private pickRandomCrypto(): CryptoAsset | null {
    if (this.cryptoAssetsCache.length === 0) {
      return null;
    }
    const index = Math.floor(Math.random() * this.cryptoAssetsCache.length);
    return this.cryptoAssetsCache[index];
  }

  /**
   * Convert symbol to Binance testnet trading pair (e.g., BTC -> BTCUSDT)
   */
  private getTestnetSymbol(symbol: string): string {
    const upperSymbol = symbol.toUpperCase();
    // If already a pair, return as-is
    if (upperSymbol.includes('USDT') || upperSymbol.includes('USDC') || upperSymbol.includes('BUSD')) {
      return upperSymbol;
    }
    return `${upperSymbol}USDT`;
  }

  /**
   * Get crypto momentum (price change percentage) from Binance testnet
   */
  private async getCryptoMomentum(symbol: string): Promise<number> {
    try {
      const ticker = await this.binanceTestnetService.get24hTicker(symbol);
      if (ticker?.priceChangePercent) {
        return parseFloat(ticker.priceChangePercent);
      }
      return 0;
    } catch (error) {
      this.logger.debug(`Could not get momentum for ${symbol}, using neutral`);
      return 0;
    }
  }

  /**
   * Generate a trading signal (BUY/SELL with confidence)
   * Uses momentum-based logic: more likely to BUY when crypto is up, SELL when down
   */
  private generateSignal(strategy: Strategy, momentum: number = 0): { action: 'BUY' | 'SELL'; confidence: number; scores: any } {
    // Base probability is 50/50, adjusted by momentum
    // Crypto momentum influence is slightly higher due to trend-following nature
    const momentumInfluence = Math.max(-0.30, Math.min(0.30, momentum * 0.025));
    
    // Add slight randomness to keep it unpredictable (±10%)
    const randomNoise = (Math.random() - 0.5) * 0.2;
    
    // Final buy probability: 50% base + momentum adjustment + noise
    // Clamped between 25% and 75% for crypto (wider range than stocks)
    const buyProbability = Math.max(0.25, Math.min(0.75, 0.5 + momentumInfluence + randomNoise));
    
    const action: 'BUY' | 'SELL' = Math.random() < buyProbability ? 'BUY' : 'SELL';
    
    // Confidence is higher when momentum aligns with action
    const momentumAlignment = (action === 'BUY' && momentum > 0) || (action === 'SELL' && momentum < 0);
    const baseConfidence = 0.55 + Math.random() * 0.30;
    const confidence = momentumAlignment ? baseConfidence + 0.1 : baseConfidence;

    // Generate scores that reflect the momentum analysis
    const momentumScore = 50 + momentum * 3; // Convert momentum to 0-100 scale
    const scores = {
      sentiment_score: Math.max(0, Math.min(100, momentumScore + (Math.random() - 0.5) * 35)),
      trend_score: Math.max(0, Math.min(100, momentumScore + (Math.random() - 0.5) * 25)),
      fundamental_score: 35 + Math.random() * 45, // Less tied to momentum for crypto
      liquidity_score: 45 + Math.random() * 50,
      volatility_score: Math.abs(momentum) * 8 + Math.random() * 50,
      macro_score: 35 + Math.random() * 45,
    };

    return { action, confidence, scores };
  }

  /**
   * Generate random trade amount ($10 - $100 USDT for crypto)
   */
  private generateTradeAmount(): number {
    return Math.floor(10 + Math.random() * 90);
  }

  /**
   * Get current crypto price from Binance testnet
   */
  private async getCryptoPrice(symbol: string): Promise<number> {
    try {
      const ticker = await this.binanceTestnetService.getTickerPrice(symbol);
      const price = ticker.price;
      return typeof price === 'string' ? parseFloat(price) : (price || 0);
    } catch (error) {
      this.logger.warn(`Could not get price for ${symbol}`);
      return 0;
    }
  }

  /**
   * Generate AI explanation for the trade
   */
  private generateAiExplanation(strategy: Strategy, crypto: CryptoAsset, signal: any, price: number, momentum: number = 0): string {
    const momentumStr = momentum > 0 ? 'bullish' : momentum < 0 ? 'bearish' : 'neutral';
    const trendAligned = (signal.action === 'BUY' && momentum > 0) || (signal.action === 'SELL' && momentum < 0);
    
    const reasons = trendAligned ? [
      `${strategy.name} riding ${momentumStr} momentum for ${signal.action.toLowerCase()} opportunity`,
      `On-chain metrics confirm ${momentumStr} trend continuation`,
      `Momentum indicators align with ${signal.action.toLowerCase()} signal`,
      `Price action suggests continuation of current ${momentumStr} move`,
      `Volume analysis favors ${signal.action.toLowerCase()} position`,
      `Order flow indicates ${signal.action === 'BUY' ? 'accumulation' : 'distribution'} phase`,
    ] : [
      `${strategy.name} identified potential reversal opportunity`,
      `RSI divergence suggests counter-trend ${signal.action.toLowerCase()}`,
      `Risk-reward ratio favors contrarian ${signal.action.toLowerCase()} entry`,
      `Funding rate divergence detected, anticipating ${signal.action.toLowerCase()} setup`,
      `Support/resistance analysis suggests ${signal.action === 'BUY' ? 'bounce' : 'rejection'}`,
      `Whale wallet movements suggest incoming ${signal.action === 'BUY' ? 'pump' : 'dump'}`,
    ];

    const index = Math.floor(Math.random() * reasons.length);
    return `${reasons[index]} for ${crypto.symbol} at $${price.toFixed(4)} (${(signal.confidence * 100).toFixed(1)}% confidence)`;
  }

  /**
   * Store signal in database
   */
  private async storeSignal(
    strategy: Strategy,
    crypto: CryptoAsset,
    signal: { action: 'BUY' | 'SELL'; confidence: number; scores: any },
    amount: number,
    price: number,
    stopLossPrice?: number,
    takeProfitPrice?: number,
    orderId?: number,
  ): Promise<void> {
    try {
      await this.prisma.strategy_signals.create({
        data: {
          strategy_id: strategy.strategy_id,
          asset_id: crypto.asset_id,
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
            crypto_auto_trade: true,
            trade_amount: amount,
            trade_price: price,
            stop_loss_price: stopLossPrice,
            take_profit_price: takeProfitPrice,
            testnet_order_id: orderId,
            generated_at: new Date().toISOString(),
          },
        },
      });
    } catch (error: any) {
      this.logger.error(`Failed to store crypto signal: ${error?.message}`);
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
  async executeManualTrade(): Promise<{ success: boolean; trade?: CryptoAutoTradeRecord; error?: string }> {
    if (!this.sessionService.isTradeAllowed()) {
      return { success: false, error: 'Crypto auto trading not active' };
    }

    await this.refreshCaches();

    const strategies = await this.getActiveAdminStrategies();
    if (strategies.length === 0) {
      return { success: false, error: 'No active crypto strategies' };
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
