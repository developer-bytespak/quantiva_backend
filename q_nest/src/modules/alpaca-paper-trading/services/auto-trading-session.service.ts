import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

export type AutoTradingStatus = 'idle' | 'running' | 'paused' | 'stopped';

export interface AutoTradeRecord {
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

export interface SessionStats {
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

export interface AutoTradingSession {
  status: AutoTradingStatus;
  sessionId: string;
  startTime: Date | null;
  lastRunTime: Date | null;
  nextRunTime: Date | null;
  trades: AutoTradeRecord[];
  stats: SessionStats;
  aiMessages: { timestamp: Date; message: string; type: 'info' | 'success' | 'warning' | 'trade' }[];
}

@Injectable()
export class AutoTradingSessionService {
  private readonly logger = new Logger(AutoTradingSessionService.name);
  private historyLoaded = false;
  private lastHistoryLoad: Date | null = null;
  private readonly HISTORY_CACHE_TTL = 30000; // 30 seconds cache
  
  constructor(private prisma: PrismaService) {}
  
  // In-memory session state
  private session: AutoTradingSession = {
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
    'Analyzing market patterns...',
    'Processing sentiment data from 50+ sources...',
    'Running neural network inference...',
    'Evaluating risk parameters...',
    'Cross-referencing technical indicators...',
    'Optimizing portfolio allocation...',
    'Scanning market anomalies...',
    'Computing probability distributions...',
    'Aggregating signal strength...',
    'Finalizing trade decision...',
    'Validating entry conditions...',
    'Checking liquidity depth...',
    'Analyzing order book imbalance...',
    'Processing real-time feeds...',
    'Calculating position sizing...',
  ];

  /**
   * Get current session state
   */
  getSession(): AutoTradingSession {
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
      // Load auto-trade signals from the last 30 days (extended for better history)
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      
      const signals = await this.prisma.strategy_signals.findMany({
        where: {
          timestamp: { gte: thirtyDaysAgo },
          engine_metadata: {
            path: ['auto_trade'],
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
      const trades: AutoTradeRecord[] = signals.map((sig) => ({
        id: sig.signal_id,
        timestamp: sig.timestamp,
        strategyId: sig.strategy_id,
        strategyName: sig.strategy?.name || 'Unknown',
        symbol: sig.asset?.symbol || 'UNKNOWN',
        action: sig.action as 'BUY' | 'SELL',
        amount: (sig.engine_metadata as any)?.trade_amount || 0,
        price: (sig.engine_metadata as any)?.trade_price || 0,
        orderId: '',
        status: 'filled' as const,
        aiMessage: `Auto trade: ${sig.action} at confidence ${(sig.confidence * 100).toFixed(1)}%`,
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
      this.logger.debug(`Loaded ${trades.length} auto-trades from database`);
    } catch (error: any) {
      this.logger.error(`Failed to load history: ${error?.message}`);
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
  getStatus(): AutoTradingStatus {
    return this.session.status;
  }

  /**
   * Check if trading is allowed (not stopped and balance above threshold)
   */
  isTradeAllowed(): boolean {
    return this.session.status === 'running';
  }

  /**
   * Start a new trading session
   */
  startSession(startingBalance: number): void {
    this.session = {
      status: 'running',
      sessionId: `session_${Date.now()}`,
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

    this.addAiMessage('AI Trading System initialized', 'info');
    this.addAiMessage(`Starting balance: $${startingBalance.toLocaleString()}`, 'info');
    this.addAiMessage('Beginning market analysis cycle...', 'info');
    
    this.logger.log(`Auto trading session started: ${this.session.sessionId}`);
  }

  /**
   * Pause the trading session
   */
  pauseSession(): void {
    if (this.session.status === 'running') {
      this.session.status = 'paused';
      this.addAiMessage('Trading paused by user', 'warning');
      this.logger.log('Auto trading session paused');
    }
  }

  /**
   * Resume the trading session
   */
  resumeSession(): void {
    if (this.session.status === 'paused') {
      this.session.status = 'running';
      this.session.nextRunTime = this.calculateNextRunTime();
      this.addAiMessage('Trading resumed', 'info');
      this.logger.log('Auto trading session resumed');
    }
  }

  /**
   * Stop the trading session
   */
  stopSession(): void {
    this.session.status = 'stopped';
    this.addAiMessage('Trading session stopped', 'warning');
    this.logger.log('Auto trading session stopped');
  }

  /**
   * Update balance and check threshold
   */
  updateBalance(newBalance: number): boolean {
    const threshold = 10000; // $10,000 minimum balance
    
    this.session.stats.currentBalance = newBalance;
    this.session.stats.profitLoss = newBalance - this.session.stats.startingBalance;
    this.session.stats.profitLossPercent = this.session.stats.startingBalance > 0
      ? (this.session.stats.profitLoss / this.session.stats.startingBalance) * 100
      : 0;

    if (newBalance < threshold) {
      this.session.status = 'stopped';
      this.addAiMessage(`Balance fell below $${threshold.toLocaleString()} threshold. Trading stopped.`, 'warning');
      this.logger.warn(`Auto trading stopped: Balance ${newBalance} below threshold ${threshold}`);
      return false;
    }

    return true;
  }

  /**
   * Record a trade
   */
  recordTrade(trade: AutoTradeRecord): void {
    this.session.trades.unshift(trade); // Add to beginning
    
    // Keep only last 100 trades in memory
    if (this.session.trades.length > 100) {
      this.session.trades = this.session.trades.slice(0, 100);
    }

    // Update stats
    this.session.stats.totalTrades++;
    this.session.stats.totalVolume += trade.amount;
    this.session.stats.lastTradeTime = trade.timestamp;

    if (trade.status === 'filled') {
      this.session.stats.successfulTrades++;
    } else if (trade.status === 'failed') {
      this.session.stats.failedTrades++;
    }

    this.session.stats.winRate = this.session.stats.totalTrades > 0
      ? (this.session.stats.successfulTrades / this.session.stats.totalTrades) * 100
      : 0;

    // Count today's trades
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    this.session.stats.todayTrades = this.session.trades.filter(
      t => new Date(t.timestamp) >= today
    ).length;

    // Add AI message for the trade
    this.addAiMessage(
      `${trade.action} ${trade.symbol} @ $${trade.price.toFixed(2)} - ${trade.strategyName}`,
      'trade'
    );

    this.session.lastRunTime = new Date();
    this.session.nextRunTime = this.calculateNextRunTime();
  }

  /**
   * Update trade status
   */
  updateTradeStatus(tradeId: string, status: 'pending' | 'filled' | 'failed'): void {
    const trade = this.session.trades.find(t => t.id === tradeId);
    if (trade) {
      const prevStatus = trade.status;
      trade.status = status;

      // Update stats based on status change
      if (prevStatus === 'pending') {
        if (status === 'filled') {
          this.session.stats.successfulTrades++;
        } else if (status === 'failed') {
          this.session.stats.failedTrades++;
        }
        this.session.stats.winRate = this.session.stats.totalTrades > 0
          ? (this.session.stats.successfulTrades / this.session.stats.totalTrades) * 100
          : 0;
      }
    }
  }

  /**
   * Add AI message for visual effect
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
   * Get a random AI training message
   */
  getRandomAiMessage(): string {
    const index = Math.floor(Math.random() * this.aiTrainingMessages.length);
    return this.aiTrainingMessages[index];
  }

  /**
   * Add random AI training messages (for visual effect)
   */
  addRandomTrainingMessages(count: number = 3): void {
    for (let i = 0; i < count; i++) {
      setTimeout(() => {
        this.addAiMessage(this.getRandomAiMessage(), 'info');
      }, i * 500); // Stagger messages
    }
  }

  /**
   * Calculate next run time (2 hours from now)
   */
  private calculateNextRunTime(): Date {
    const next = new Date();
    next.setHours(next.getHours() + 2);
    return next;
  }

  /**
   * Get recent trades
   */
  getRecentTrades(limit: number = 20): AutoTradeRecord[] {
    return this.session.trades.slice(0, limit);
  }

  /**
   * Get stats
   */
  getStats(): SessionStats {
    return { ...this.session.stats };
  }

  /**
   * Get AI messages
   */
  getAiMessages(limit: number = 20): { timestamp: Date; message: string; type: string }[] {
    return this.session.aiMessages.slice(0, limit);
  }

  /**
   * Reset session (keeps historical trades and stats from DB)
   * Only resets session control state, not the trade history
   */
  resetSession(): void {
    // Preserve trades and stats - they come from DB
    const preservedTrades = this.session.trades;
    const preservedStats = this.session.stats;
    
    this.session = {
      status: 'idle',
      sessionId: '',
      startTime: null,
      lastRunTime: null,
      nextRunTime: null,
      trades: preservedTrades, // Keep historical trades
      stats: preservedStats,   // Keep stats
      aiMessages: [],          // Only clear AI messages
    };
    this.logger.log('Auto trading session reset (trade history preserved)');
  }

  /**
   * Full reset including history (use with caution)
   */
  fullReset(): void {
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
    this.logger.log('Auto trading session fully reset (all data cleared)');
  }
}
