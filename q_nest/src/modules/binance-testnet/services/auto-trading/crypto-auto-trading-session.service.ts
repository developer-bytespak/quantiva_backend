import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';

export type CryptoAutoTradingStatus = 'idle' | 'running' | 'paused' | 'stopped';

export interface CryptoAutoTradeRecord {
  id: string;
  timestamp: Date;
  strategyId: string;
  strategyName: string;
  symbol: string;
  action: 'BUY' | 'SELL';
  amount: number;
  price: number;
  orderId: string;
  status: 'pending' | 'filled' | 'failed';
  aiMessage: string;
  confidence: number;
}

export interface CryptoSessionStats {
  totalTrades: number;
  successfulTrades: number;
  failedTrades: number;
  totalVolume: number;
  todayTrades: number;
  winRate: number;
  lastTradeTime: Date | null;
  sessionStartTime: Date | null;
  currentBalance: number;
  startingBalance: number;
  profitLoss: number;
  profitLossPercent: number;
}

export interface CryptoAutoTradingSession {
  status: CryptoAutoTradingStatus;
  sessionId: string;
  startTime: Date | null;
  lastRunTime: Date | null;
  nextRunTime: Date | null;
  trades: CryptoAutoTradeRecord[];
  stats: CryptoSessionStats;
  aiMessages: { timestamp: Date; message: string; type: 'info' | 'success' | 'warning' | 'trade' }[];
}

@Injectable()
export class CryptoAutoTradingSessionService {
  private readonly logger = new Logger(CryptoAutoTradingSessionService.name);
  private historyLoaded = false;
  private lastHistoryLoad: Date | null = null;
  private readonly HISTORY_CACHE_TTL = 30000; // 30 seconds cache
  
  constructor(private prisma: PrismaService) {}
  
  // In-memory session state
  private session: CryptoAutoTradingSession = {
    status: 'idle',
    sessionId: '',
    startTime: null,
    lastRunTime: null,
    nextRunTime: null,
    trades: [],
    stats: {
      totalTrades: 0,
      successfulTrades: 0,
      failedTrades: 0,
      totalVolume: 0,
      todayTrades: 0,
      winRate: 0,
      lastTradeTime: null,
      sessionStartTime: null,
      currentBalance: 0,
      startingBalance: 0,
      profitLoss: 0,
      profitLossPercent: 0,
    },
    aiMessages: [],
  };

  // AI training messages for visual effect
  private readonly aiTrainingMessages = [
    'Analyzing crypto market patterns...',
    'Processing on-chain data from multiple networks...',
    'Running neural network inference on price action...',
    'Evaluating DeFi risk parameters...',
    'Cross-referencing technical indicators across exchanges...',
    'Optimizing crypto portfolio allocation...',
    'Scanning for arbitrage opportunities...',
    'Computing probability distributions for volatility...',
    'Aggregating signal strength from order flow...',
    'Finalizing trade decision based on momentum...',
    'Validating entry conditions against support/resistance...',
    'Checking liquidity depth on order books...',
    'Analyzing whale wallet movements...',
    'Processing real-time WebSocket feeds...',
    'Calculating optimal position sizing for crypto...',
    'Monitoring funding rates across perpetuals...',
    'Analyzing social sentiment from crypto Twitter...',
    'Evaluating market maker activity patterns...',
  ];

  /**
   * Get current session state
   */
  getSession(): CryptoAutoTradingSession {
    return { ...this.session };
  }

  /**
   * Load historical trades from database (called on startup or when needed)
   * Uses a 30-second cache to avoid excessive DB queries
   */
  async loadHistoryFromDatabase(): Promise<void> {
    // Check cache - reload every 30 seconds max
    const now = new Date();
    if (this.historyLoaded && this.lastHistoryLoad) {
      const timeSinceLastLoad = now.getTime() - this.lastHistoryLoad.getTime();
      if (timeSinceLastLoad < this.HISTORY_CACHE_TTL) {
        return; // Use cached data
      }
    }
    
    try {
      // Load auto-trade signals from the last 30 days for crypto
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      
      const signals = await this.prisma.strategy_signals.findMany({
        where: {
          timestamp: { gte: thirtyDaysAgo },
          engine_metadata: {
            path: ['crypto_auto_trade'],
            equals: true,
          },
        },
        include: {
          strategy: { select: { name: true } },
          asset: { select: { symbol: true } },
        },
        orderBy: { timestamp: 'desc' },
        take: 100,
      });

      // Convert to trade records
      const trades: CryptoAutoTradeRecord[] = signals.map((sig) => ({
        id: sig.signal_id,
        timestamp: sig.timestamp,
        strategyId: sig.strategy_id,
        strategyName: sig.strategy?.name || 'Unknown',
        symbol: sig.asset?.symbol || 'UNKNOWN',
        action: sig.action as 'BUY' | 'SELL',
        amount: (sig.engine_metadata as any)?.trade_amount || 0,
        price: (sig.engine_metadata as any)?.trade_price || 0,
        orderId: (sig.engine_metadata as any)?.testnet_order_id || '',
        status: 'filled' as const,
        aiMessage: `Crypto auto trade: ${sig.action} at confidence ${(sig.confidence * 100).toFixed(1)}%`,
        confidence: sig.confidence,
      }));

      // Always update with fresh data from DB
      this.session.trades = trades;
      
      // Recalculate stats from loaded trades
      this.session.stats.totalTrades = trades.length;
      this.session.stats.successfulTrades = trades.filter(t => t.status === 'filled').length;
      this.session.stats.failedTrades = trades.filter(t => t.status === 'failed').length;
      this.session.stats.totalVolume = trades.reduce((sum, t) => sum + t.amount, 0);
      this.session.stats.winRate = this.session.stats.totalTrades > 0
        ? (this.session.stats.successfulTrades / this.session.stats.totalTrades) * 100
        : 0;
      this.session.stats.lastTradeTime = trades[0]?.timestamp || null;
      
      // Count today's trades
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      this.session.stats.todayTrades = trades.filter(
        t => new Date(t.timestamp) >= today
      ).length;

      this.historyLoaded = true;
      this.lastHistoryLoad = new Date();
      this.logger.debug(`Loaded ${trades.length} crypto auto-trades from database`);
    } catch (error: any) {
      this.logger.error(`Failed to load crypto history: ${error?.message}`);
    }
  }

  /**
   * Force reload from database (useful when data might be stale)
   */
  async forceReloadHistory(): Promise<void> {
    this.historyLoaded = false;
    this.lastHistoryLoad = null;
    await this.loadHistoryFromDatabase();
  }

  /**
   * Get session status
   */
  getStatus(): CryptoAutoTradingStatus {
    return this.session.status;
  }

  /**
   * Get session stats
   */
  getStats(): CryptoSessionStats {
    return { ...this.session.stats };
  }

  /**
   * Check if trading is allowed (not stopped and balance above threshold)
   */
  isTradeAllowed(): boolean {
    return this.session.status === 'running';
  }

  /**
   * Start a new trading session
   * Crypto has lower minimum balance requirement ($100 vs $10,000 for stocks)
   */
  startSession(startingBalance: number): void {
    this.session = {
      status: 'running',
      sessionId: `crypto_session_${Date.now()}`,
      startTime: new Date(),
      lastRunTime: null,
      nextRunTime: this.calculateNextRunTime(),
      trades: [],
      stats: {
        totalTrades: 0,
        successfulTrades: 0,
        failedTrades: 0,
        totalVolume: 0,
        todayTrades: 0,
        winRate: 0,
        lastTradeTime: null,
        sessionStartTime: new Date(),
        currentBalance: startingBalance,
        startingBalance: startingBalance,
        profitLoss: 0,
        profitLossPercent: 0,
      },
      aiMessages: [],
    };

    this.addAiMessage('Crypto AI Trading System initialized', 'info');
    this.addAiMessage(`Starting USDT balance: $${startingBalance.toLocaleString()}`, 'info');
    this.addAiMessage('Beginning 24/7 crypto market analysis...', 'info');
    
    this.logger.log(`Crypto auto trading session started: ${this.session.sessionId}`);
  }

  /**
   * Pause the trading session
   */
  pauseSession(): void {
    if (this.session.status === 'running') {
      this.session.status = 'paused';
      this.addAiMessage('Crypto trading paused by user', 'warning');
      this.logger.log('Crypto auto trading session paused');
    }
  }

  /**
   * Resume the trading session
   */
  resumeSession(): void {
    if (this.session.status === 'paused') {
      this.session.status = 'running';
      this.session.nextRunTime = this.calculateNextRunTime();
      this.addAiMessage('Crypto trading resumed', 'info');
      this.logger.log('Crypto auto trading session resumed');
    }
  }

  /**
   * Stop the trading session
   */
  stopSession(): void {
    this.session.status = 'stopped';
    this.addAiMessage('Crypto trading session stopped', 'warning');
    this.logger.log('Crypto auto trading session stopped');
  }

  /**
   * Clear all trade history and reset stats
   */
  clearHistory(): void {
    this.session.trades = [];
    this.session.aiMessages = [];
    this.session.stats = {
      totalTrades: 0,
      successfulTrades: 0,
      failedTrades: 0,
      totalVolume: 0,
      todayTrades: 0,
      winRate: 0,
      lastTradeTime: null,
      sessionStartTime: this.session.stats.sessionStartTime,
      currentBalance: this.session.stats.currentBalance,
      startingBalance: this.session.stats.currentBalance,
      profitLoss: 0,
      profitLossPercent: 0,
    };
    this.historyLoaded = false;
    this.lastHistoryLoad = null;
    this.addAiMessage('Trade history cleared', 'info');
    this.logger.log('Crypto auto trading history cleared');
  }

  /**
   * Update balance and check threshold
   * Crypto uses $100 minimum (vs $10,000 for stocks)
   */
  updateBalance(newBalance: number): boolean {
    const threshold = 100; // $100 USDT minimum balance for crypto
    
    this.session.stats.currentBalance = newBalance;
    this.session.stats.profitLoss = newBalance - this.session.stats.startingBalance;
    this.session.stats.profitLossPercent = this.session.stats.startingBalance > 0
      ? (this.session.stats.profitLoss / this.session.stats.startingBalance) * 100
      : 0;

    if (newBalance < threshold) {
      this.session.status = 'stopped';
      this.addAiMessage(`USDT balance fell below $${threshold} threshold. Trading stopped.`, 'warning');
      this.logger.warn(`Crypto auto trading stopped: Balance ${newBalance} below threshold ${threshold}`);
      return false;
    }

    return true;
  }

  /**
   * Record a trade
   */
  recordTrade(trade: CryptoAutoTradeRecord): void {
    // Add to beginning of trades array
    this.session.trades.unshift(trade);
    
    // Keep only last 100 trades in memory
    if (this.session.trades.length > 100) {
      this.session.trades = this.session.trades.slice(0, 100);
    }

    // Update stats
    this.session.stats.totalTrades++;
    if (trade.status === 'filled') {
      this.session.stats.successfulTrades++;
    } else if (trade.status === 'failed') {
      this.session.stats.failedTrades++;
    }
    this.session.stats.totalVolume += trade.amount;
    this.session.stats.lastTradeTime = trade.timestamp;
    this.session.stats.winRate = this.session.stats.totalTrades > 0
      ? (this.session.stats.successfulTrades / this.session.stats.totalTrades) * 100
      : 0;

    // Update today's trades
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (trade.timestamp >= today) {
      this.session.stats.todayTrades++;
    }

    // Update last run time and next run time
    this.session.lastRunTime = new Date();
    this.session.nextRunTime = this.calculateNextRunTime();

    // Add AI message for the trade
    const statusEmoji = trade.status === 'filled' ? '✅' : trade.status === 'failed' ? '❌' : '⏳';
    this.addAiMessage(
      `${statusEmoji} ${trade.action} ${trade.symbol}: $${trade.amount.toFixed(2)} @ $${trade.price.toFixed(4)}`,
      'trade'
    );
  }

  /**
   * Add AI message
   */
  addAiMessage(message: string, type: 'info' | 'success' | 'warning' | 'trade'): void {
    this.session.aiMessages.unshift({
      timestamp: new Date(),
      message,
      type,
    });

    // Keep only last 50 messages
    if (this.session.aiMessages.length > 50) {
      this.session.aiMessages = this.session.aiMessages.slice(0, 50);
    }
  }

  /**
   * Add random training messages for visual effect
   */
  addRandomTrainingMessages(count: number = 2): void {
    for (let i = 0; i < count; i++) {
      const randomIndex = Math.floor(Math.random() * this.aiTrainingMessages.length);
      this.addAiMessage(this.aiTrainingMessages[randomIndex], 'info');
    }
  }

  /**
   * Get recent trades
   */
  getRecentTrades(limit: number = 10): CryptoAutoTradeRecord[] {
    return this.session.trades.slice(0, limit);
  }

  /**
   * Get AI messages
   */
  getAiMessages(limit: number = 15): { timestamp: Date; message: string; type: string }[] {
    return this.session.aiMessages.slice(0, limit);
  }

  /**
   * Calculate next run time (every 6 hours)
   */
  private calculateNextRunTime(): Date {
    const now = new Date();
    const nextRun = new Date(now);
    
    // Round to next 6-hour mark
    const hours = now.getHours();
    const nextHour = Math.ceil((hours + 1) / 6) * 6;
    
    if (nextHour >= 24) {
      nextRun.setDate(nextRun.getDate() + 1);
      nextRun.setHours(0, 0, 0, 0);
    } else {
      nextRun.setHours(nextHour, 0, 0, 0);
    }
    
    return nextRun;
  }

  /**
   * Reset session (clear everything and start fresh)
   */
  resetSession(): void {
    this.session = {
      status: 'idle',
      sessionId: '',
      startTime: null,
      lastRunTime: null,
      nextRunTime: null,
      trades: [],
      stats: {
        totalTrades: 0,
        successfulTrades: 0,
        failedTrades: 0,
        totalVolume: 0,
        todayTrades: 0,
        winRate: 0,
        lastTradeTime: null,
        sessionStartTime: null,
        currentBalance: 0,
        startingBalance: 0,
        profitLoss: 0,
        profitLossPercent: 0,
      },
      aiMessages: [],
    };
    this.historyLoaded = false;
    this.lastHistoryLoad = null;
    this.logger.log('Crypto auto trading session reset');
  }
}
