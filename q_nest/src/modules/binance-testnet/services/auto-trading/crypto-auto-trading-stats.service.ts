import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';
import { BinanceTestnetService } from '../binance-testnet.service';
import { CryptoAutoTradingSessionService } from './crypto-auto-trading-session.service';

export interface CryptoStrategyPerformance {
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

export interface CryptoDailyStats {
  date: string;
  trades: number;
  volume: number;
  profitLoss: number;
}

export interface CryptoAutoTradingStats {
  // Account metrics (USDT)
  currentBalance: number;
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
  strategyPerformance: CryptoStrategyPerformance[];
  
  // Daily breakdown (last 7 days)
  dailyStats: CryptoDailyStats[];
  
  // Position summary
  openPositions: number;
  totalPositionValue: number;
  
  // Crypto-specific
  topHoldings: { symbol: string; value: number; change: number }[];
}

@Injectable()
export class CryptoAutoTradingStatsService {
  private readonly logger = new Logger(CryptoAutoTradingStatsService.name);

  constructor(
    private prisma: PrismaService,
    private binanceTestnetService: BinanceTestnetService,
    private sessionService: CryptoAutoTradingSessionService,
  ) {}

  /**
   * Get comprehensive stats for the dashboard
   */
  async getStats(): Promise<CryptoAutoTradingStats> {
    const session = this.sessionService.getSession();
    const sessionStats = this.sessionService.getStats();

    // Get account data from Binance testnet
    let accountData = {
      currentBalance: sessionStats.currentBalance,
      portfolioValue: sessionStats.currentBalance,
      dailyChange: sessionStats.profitLoss,
      dailyChangePercent: sessionStats.profitLossPercent,
    };

    let openPositions = 0;
    let totalPositionValue = 0;
    let topHoldings: { symbol: string; value: number; change: number }[] = [];

    try {
      const accountBalance = await this.binanceTestnetService.getAccountBalance();
      
      // Calculate total portfolio value from all non-zero balances
      const nonZeroBalances = accountBalance.balances.filter(
        (b: any) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0
      );
      
      // Get USDT balance as base
      const usdtBalance = accountBalance.balances.find((b: any) => b.asset === 'USDT');
      const usdtValue = usdtBalance 
        ? (typeof usdtBalance.free === 'string' ? parseFloat(usdtBalance.free) : usdtBalance.free) + 
          (typeof usdtBalance.locked === 'string' ? parseFloat(usdtBalance.locked) : usdtBalance.locked) 
        : 0;
      
      accountData.currentBalance = usdtValue;
      
      // Update session with fresh balance
      this.sessionService.updateBalance(usdtValue);

      // Calculate positions (non-USDT assets)
      const positions = nonZeroBalances.filter((b: any) => b.asset !== 'USDT');
      openPositions = positions.length;

      // Get prices and calculate position values
      for (const position of positions) {
        try {
          const symbol = `${position.asset}USDT`;
          const ticker = await this.binanceTestnetService.getTickerPrice(symbol);
          const price = typeof ticker.price === 'string' ? parseFloat(ticker.price) : ticker.price;
          const qty = (typeof position.free === 'string' ? parseFloat(position.free) : position.free) + 
                      (typeof position.locked === 'string' ? parseFloat(position.locked) : position.locked);
          const value = qty * price;
          totalPositionValue += value;
          
          // Get 24h change
          const ticker24h = await this.binanceTestnetService.get24hTicker(symbol);
          const change = parseFloat(ticker24h?.priceChangePercent || '0');
          
          topHoldings.push({
            symbol: position.asset,
            value,
            change,
          });
        } catch (error) {
          // Skip if can't get price
        }
      }

      // Sort by value descending
      topHoldings.sort((a, b) => b.value - a.value);
      topHoldings = topHoldings.slice(0, 5); // Top 5 holdings

      accountData.portfolioValue = usdtValue + totalPositionValue;
      
    } catch (error: any) {
      this.logger.warn(`Failed to get Binance testnet account data: ${error?.message}`);
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
      topHoldings,
    };
  }

  /**
   * Get performance breakdown by strategy
   */
  private async getStrategyPerformance(): Promise<CryptoStrategyPerformance[]> {
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

      // Get crypto auto-trade signals grouped by strategy (last 30 days)
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
            path: ['crypto_auto_trade'],
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
      const performanceMap = new Map<string, CryptoStrategyPerformance>();

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

      // Calculate metrics
      for (const signal of signals) {
        const perf = performanceMap.get(signal.strategy_id);
        if (!perf) continue;

        perf.totalTrades++;
        perf.successfulTrades++; // Assume filled for now
        perf.totalVolume += (signal.engine_metadata as any)?.trade_amount || 0;
        perf.avgConfidence += signal.confidence;
        
        if (!perf.lastTradeTime || signal.timestamp > perf.lastTradeTime) {
          perf.lastTradeTime = signal.timestamp;
        }
      }

      // Finalize averages and win rates
      const result: CryptoStrategyPerformance[] = [];
      for (const perf of performanceMap.values()) {
        if (perf.totalTrades > 0) {
          perf.avgConfidence /= perf.totalTrades;
          perf.winRate = (perf.successfulTrades / perf.totalTrades) * 100;
        }
        result.push(perf);
      }

      // Sort by total trades descending
      result.sort((a, b) => b.totalTrades - a.totalTrades);

      return result;
    } catch (error: any) {
      this.logger.error(`Failed to get crypto strategy performance: ${error?.message}`);
      return [];
    }
  }

  /**
   * Get daily stats for the last 7 days
   */
  private async getDailyStats(): Promise<CryptoDailyStats[]> {
    try {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      sevenDaysAgo.setHours(0, 0, 0, 0);

      const signals = await this.prisma.strategy_signals.findMany({
        where: {
          timestamp: {
            gte: sevenDaysAgo,
          },
          engine_metadata: {
            path: ['crypto_auto_trade'],
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
      const dailyMap = new Map<string, CryptoDailyStats>();

      // Initialize all 7 days
      for (let i = 0; i < 7; i++) {
        const date = new Date();
        date.setDate(date.getDate() - (6 - i));
        const dateStr = date.toISOString().split('T')[0];
        dailyMap.set(dateStr, {
          date: dateStr,
          trades: 0,
          volume: 0,
          profitLoss: 0,
        });
      }

      // Aggregate signals
      for (const signal of signals) {
        const dateStr = signal.timestamp.toISOString().split('T')[0];
        const daily = dailyMap.get(dateStr);
        if (daily) {
          daily.trades++;
          daily.volume += (signal.engine_metadata as any)?.trade_amount || 0;
        }
      }

      return Array.from(dailyMap.values());
    } catch (error: any) {
      this.logger.error(`Failed to get daily stats: ${error?.message}`);
      return [];
    }
  }

  /**
   * Format duration string
   */
  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days}d ${hours % 24}h`;
    } else if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * Get quick summary (lightweight endpoint for fast polling)
   */
  async getQuickSummary(): Promise<{
    status: string;
    balance: number;
    todayTrades: number;
    totalTrades: number;
    profitLoss: number;
    profitLossPercent: number;
  }> {
    const session = this.sessionService.getSession();
    const stats = this.sessionService.getStats();

    return {
      status: session.status,
      balance: stats.currentBalance,
      todayTrades: stats.todayTrades,
      totalTrades: stats.totalTrades,
      profitLoss: stats.profitLoss,
      profitLossPercent: stats.profitLossPercent,
    };
  }
}
