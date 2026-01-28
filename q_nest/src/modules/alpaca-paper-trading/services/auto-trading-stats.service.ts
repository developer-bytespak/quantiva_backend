import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AlpacaPaperTradingService } from '../alpaca-paper-trading.service';
import { AutoTradingSessionService } from './auto-trading-session.service';

export interface StrategyPerformance {
  strategyId: string;
  strategyName: string;
  totalTrades: number;
  successfulTrades: number;
  failedTrades: number;
  totalVolume: number;
  avgConfidence: number;
  winRate: number;
  lastTradeTime: Date | null;
}

export interface DailyStats {
  date: string;
  trades: number;
  volume: number;
  profitLoss: number;
}

export interface AutoTradingStats {
  // Account metrics
  currentBalance: number;
  buyingPower: number;
  portfolioValue: number;
  dailyChange: number;
  dailyChangePercent: number;
  
  // Session metrics
  sessionStartTime: Date | null;
  sessionDuration: string;
  status: string;
  
  // Trade metrics
  totalTrades: number;
  todayTrades: number;
  successfulTrades: number;
  failedTrades: number;
  totalVolume: number;
  avgTradeSize: number;
  winRate: number;
  
  // Timing
  lastTradeTime: Date | null;
  nextScheduledRun: Date | null;
  
  // Performance by strategy
  strategyPerformance: StrategyPerformance[];
  
  // Daily breakdown (last 7 days)
  dailyStats: DailyStats[];
  
  // Position summary
  openPositions: number;
  totalPositionValue: number;
}

@Injectable()
export class AutoTradingStatsService {
  private readonly logger = new Logger(AutoTradingStatsService.name);

  constructor(
    private prisma: PrismaService,
    private alpacaService: AlpacaPaperTradingService,
    private sessionService: AutoTradingSessionService,
  ) {}

  /**
   * Get comprehensive stats for the dashboard
   */
  async getStats(): Promise<AutoTradingStats> {
    const session = this.sessionService.getSession();
    const sessionStats = this.sessionService.getStats();

    // Get account data from Alpaca
    let accountData = {
      currentBalance: sessionStats.currentBalance,
      buyingPower: 0,
      portfolioValue: sessionStats.currentBalance,
      dailyChange: sessionStats.profitLoss,
      dailyChangePercent: sessionStats.profitLossPercent,
    };

    try {
      const balance = await this.alpacaService.getAccountBalance();
      accountData = {
        currentBalance: balance.equity,
        buyingPower: balance.buyingPower,
        portfolioValue: balance.portfolioValue,
        dailyChange: balance.dailyChange,
        dailyChangePercent: balance.dailyChangePercent,
      };
      
      // Update session with fresh balance
      this.sessionService.updateBalance(balance.equity);
    } catch (error: any) {
      this.logger.warn(`Failed to get Alpaca account data: ${error?.message}`);
    }

    // Get positions count
    let openPositions = 0;
    let totalPositionValue = 0;
    try {
      const positions = await this.alpacaService.getPositions();
      openPositions = positions.length;
      totalPositionValue = positions.reduce(
        (sum, p) => sum + parseFloat(p.market_value || '0'),
        0
      );
    } catch (error: any) {
      this.logger.warn(`Failed to get positions: ${error?.message}`);
    }

    // Get strategy performance from database
    const strategyPerformance = await this.getStrategyPerformance();

    // Get daily stats
    const dailyStats = await this.getDailyStats();

    // Calculate session duration
    const sessionDuration = session.startTime
      ? this.formatDuration(new Date().getTime() - session.startTime.getTime())
      : 'Not started';

    return {
      ...accountData,
      sessionStartTime: session.startTime,
      sessionDuration,
      status: session.status,
      totalTrades: sessionStats.totalTrades,
      todayTrades: sessionStats.todayTrades,
      successfulTrades: sessionStats.successfulTrades,
      failedTrades: sessionStats.failedTrades,
      totalVolume: sessionStats.totalVolume,
      avgTradeSize: sessionStats.totalTrades > 0 
        ? sessionStats.totalVolume / sessionStats.totalTrades 
        : 0,
      winRate: sessionStats.winRate,
      lastTradeTime: sessionStats.lastTradeTime,
      nextScheduledRun: session.nextRunTime,
      strategyPerformance,
      dailyStats,
      openPositions,
      totalPositionValue,
    };
  }

  /**
   * Get performance breakdown by strategy
   */
  private async getStrategyPerformance(): Promise<StrategyPerformance[]> {
    try {
      // Get all admin strategies
      const strategies = await this.prisma.strategies.findMany({
        where: {
          type: 'admin',
          is_active: true,
        },
        select: {
          strategy_id: true,
          name: true,
        },
      });

      // Get auto-trade signals grouped by strategy (last 30 days)
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const signals = await this.prisma.strategy_signals.findMany({
        where: {
          strategy_id: {
            in: strategies.map(s => s.strategy_id),
          },
          timestamp: {
            gte: thirtyDaysAgo,
          },
          engine_metadata: {
            path: ['auto_trade'],
            equals: true,
          },
        },
        select: {
          strategy_id: true,
          confidence: true,
          timestamp: true,
          engine_metadata: true,
        },
      });

      // Aggregate by strategy
      const performanceMap = new Map<string, StrategyPerformance>();

      for (const strategy of strategies) {
        performanceMap.set(strategy.strategy_id, {
          strategyId: strategy.strategy_id,
          strategyName: strategy.name || 'Unknown',
          totalTrades: 0,
          successfulTrades: 0,
          failedTrades: 0,
          totalVolume: 0,
          avgConfidence: 0,
          winRate: 0,
          lastTradeTime: null,
        });
      }

      for (const signal of signals) {
        const perf = performanceMap.get(signal.strategy_id!);
        if (perf) {
          perf.totalTrades++;
          perf.successfulTrades++; // Assume all recorded signals are successful
          
          const metadata = signal.engine_metadata as any;
          if (metadata?.trade_amount) {
            perf.totalVolume += metadata.trade_amount;
          }
          
          if (signal.confidence) {
            perf.avgConfidence = 
              (perf.avgConfidence * (perf.totalTrades - 1) + Number(signal.confidence)) / 
              perf.totalTrades;
          }

          if (!perf.lastTradeTime || signal.timestamp! > perf.lastTradeTime) {
            perf.lastTradeTime = signal.timestamp;
          }
        }
      }

      // Calculate win rates
      for (const perf of performanceMap.values()) {
        perf.winRate = perf.totalTrades > 0 
          ? (perf.successfulTrades / perf.totalTrades) * 100 
          : 0;
      }

      return Array.from(performanceMap.values())
        .sort((a, b) => b.totalTrades - a.totalTrades);
    } catch (error: any) {
      this.logger.error(`Failed to get strategy performance: ${error?.message}`);
      return [];
    }
  }

  /**
   * Get daily stats for the last 7 days
   */
  private async getDailyStats(): Promise<DailyStats[]> {
    try {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      const signals = await this.prisma.strategy_signals.findMany({
        where: {
          timestamp: {
            gte: sevenDaysAgo,
          },
          engine_metadata: {
            path: ['auto_trade'],
            equals: true,
          },
        },
        select: {
          timestamp: true,
          engine_metadata: true,
        },
        orderBy: {
          timestamp: 'asc',
        },
      });

      // Group by date
      const dailyMap = new Map<string, DailyStats>();

      // Initialize all 7 days
      for (let i = 0; i < 7; i++) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split('T')[0];
        dailyMap.set(dateStr, {
          date: dateStr,
          trades: 0,
          volume: 0,
          profitLoss: 0, // Would need actual P&L tracking
        });
      }

      for (const signal of signals) {
        if (!signal.timestamp) continue;
        const dateStr = signal.timestamp.toISOString().split('T')[0];
        const daily = dailyMap.get(dateStr);
        if (daily) {
          daily.trades++;
          const metadata = signal.engine_metadata as any;
          if (metadata?.trade_amount) {
            daily.volume += metadata.trade_amount;
          }
        }
      }

      return Array.from(dailyMap.values())
        .sort((a, b) => a.date.localeCompare(b.date));
    } catch (error: any) {
      this.logger.error(`Failed to get daily stats: ${error?.message}`);
      return [];
    }
  }

  /**
   * Format duration in human readable format
   */
  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days}d ${hours % 24}h ${minutes % 60}m`;
    }
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    }
    if (minutes > 0) {
      return `${minutes}m`;
    }
    return `${seconds}s`;
  }

  /**
   * Get quick summary for polling endpoint
   */
  async getQuickSummary(): Promise<{
    status: string;
    todayTrades: number;
    totalTrades: number;
    currentBalance: number;
    profitLoss: number;
    profitLossPercent: number;
    lastTradeTime: Date | null;
    nextRunTime: Date | null;
    isExecuting: boolean;
  }> {
    const session = this.sessionService.getSession();
    const stats = this.sessionService.getStats();

    let currentBalance = stats.currentBalance;
    try {
      const balance = await this.alpacaService.getAccountBalance();
      currentBalance = balance.equity;
    } catch (error) {
      // Use cached balance
    }

    return {
      status: session.status,
      todayTrades: stats.todayTrades,
      totalTrades: stats.totalTrades,
      currentBalance,
      profitLoss: currentBalance - stats.startingBalance,
      profitLossPercent: stats.startingBalance > 0 
        ? ((currentBalance - stats.startingBalance) / stats.startingBalance) * 100 
        : 0,
      lastTradeTime: stats.lastTradeTime,
      nextRunTime: session.nextRunTime,
      isExecuting: false, // Will be set by controller
    };
  }
}
