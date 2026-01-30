import {
  Controller,
  Get,
  Post,
  Logger,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Public } from '../../../../common/decorators/public.decorator';
import { BinanceTestnetService } from '../binance-testnet.service';
import { CryptoAutoTradingSessionService } from './crypto-auto-trading-session.service';
import { CryptoAutoTradingExecutionService } from './crypto-auto-trading-execution.service';
import { CryptoAutoTradingCronService } from './crypto-auto-trading-cron.service';
import { CryptoAutoTradingStatsService } from './crypto-auto-trading-stats.service';

@Controller('binance-testnet/auto-trading')
export class CryptoAutoTradingController {
  private readonly logger = new Logger(CryptoAutoTradingController.name);

  constructor(
    private readonly binanceTestnetService: BinanceTestnetService,
    private readonly sessionService: CryptoAutoTradingSessionService,
    private readonly executionService: CryptoAutoTradingExecutionService,
    private readonly cronService: CryptoAutoTradingCronService,
    private readonly statsService: CryptoAutoTradingStatsService,
  ) {}

  /**
   * Get current auto-trading status (for polling)
   * Frontend should poll this every 3 seconds
   */
  @Get('status')
  async getStatus() {
    try {
      // Ensure history is loaded from database
      await this.sessionService.loadHistoryFromDatabase();
      
      const session = this.sessionService.getSession();
      const recentTrades = this.sessionService.getRecentTrades(10);
      const aiMessages = this.sessionService.getAiMessages(15);

      return {
        success: true,
        data: {
          status: session.status,
          sessionId: session.sessionId,
          startTime: session.startTime,
          lastRunTime: session.lastRunTime,
          nextRunTime: session.nextRunTime,
          isExecuting: this.cronService.isCurrentlyExecuting(),
          stats: session.stats,
          recentTrades,
          aiMessages,
        },
      };
    } catch (error: any) {
      this.logger.error(`Failed to get crypto auto-trading status: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to get status',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get comprehensive stats for the dashboard
   */
  @Get('stats')
  async getStats() {
    try {
      const stats = await this.statsService.getStats();
      return {
        success: true,
        data: stats,
      };
    } catch (error: any) {
      this.logger.error(`Failed to get crypto stats: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to get stats',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get quick summary (lightweight endpoint for fast polling)
   */
  @Get('summary')
  async getSummary() {
    try {
      const summary = await this.statsService.getQuickSummary();
      return {
        success: true,
        data: {
          ...summary,
          isExecuting: this.cronService.isCurrentlyExecuting(),
        },
      };
    } catch (error: any) {
      this.logger.error(`Failed to get crypto summary: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to get summary',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get recent trades
   */
  @Get('trades')
  async getRecentTrades() {
    try {
      const trades = this.sessionService.getRecentTrades(50);
      return {
        success: true,
        data: trades,
        count: trades.length,
      };
    } catch (error: any) {
      this.logger.error(`Failed to get crypto trades: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to get trades',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Clear trade history and reset stats
   */
  @Public()
  @Post('clear-history')
  clearHistory() {
    this.sessionService.clearHistory();
    return {
      success: true,
      message: 'Trade history cleared',
    };
  }

  /**
   * Get OCO orders (to verify stop-loss/take-profit logic)
   * Only returns active (EXECUTING) OCO orders, not completed ones
   */
  @Get('oco-orders')
  async getOcoOrders() {
    try {
      const ocoOrders = await this.binanceTestnetService.getOcoOrders(undefined, 50);
      
      // Filter to only active OCO orders (EXECUTING status, not ALL_DONE)
      const activeOcoOrders = ocoOrders.filter(
        (order: any) => order.listOrderStatus === 'EXECUTING'
      );
      
      return {
        success: true,
        message: 'OCO orders show entry with attached TP (limit) and SL (stop) legs',
        data: {
          total: activeOcoOrders.length,
          orders: activeOcoOrders,
        },
      };
    } catch (error: any) {
      this.logger.error(`Failed to get OCO orders: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to get OCO orders',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get AI messages
   */
  @Get('messages')
  async getAiMessages() {
    try {
      const messages = this.sessionService.getAiMessages(30);
      return {
        success: true,
        data: messages,
        count: messages.length,
      };
    } catch (error: any) {
      this.logger.error(`Failed to get AI messages: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to get messages',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Start auto-trading session
   */
  @Post('start')
  async startTrading() {
    try {
      // Check if already running
      if (this.sessionService.getStatus() === 'running') {
        return {
          success: true,
          message: 'Crypto auto trading already running',
          data: { status: 'running' },
        };
      }

      // Get current USDT balance
      const accountBalance = await this.binanceTestnetService.getAccountBalance();
      const usdtBalance = accountBalance.balances.find((b: any) => b.asset === 'USDT')?.free || 0;
      const balance = typeof usdtBalance === 'string' ? parseFloat(usdtBalance) : usdtBalance;

      if (balance < 100) {
        throw new HttpException(
          `USDT balance ($${balance.toFixed(2)}) below $100 minimum threshold`,
          HttpStatus.BAD_REQUEST,
        );
      }

      this.sessionService.startSession(balance);

      return {
        success: true,
        message: 'Crypto auto trading started',
        data: {
          status: 'running',
          balance,
        },
      };
    } catch (error: any) {
      this.logger.error(`Failed to start crypto auto trading: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to start trading',
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Pause auto-trading session
   */
  @Post('pause')
  async pauseTrading() {
    try {
      this.sessionService.pauseSession();
      return {
        success: true,
        message: 'Crypto auto trading paused',
        data: { status: 'paused' },
      };
    } catch (error: any) {
      this.logger.error(`Failed to pause crypto trading: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to pause trading',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Resume auto-trading session
   */
  @Post('resume')
  async resumeTrading() {
    try {
      this.sessionService.resumeSession();
      return {
        success: true,
        message: 'Crypto auto trading resumed',
        data: { status: 'running' },
      };
    } catch (error: any) {
      this.logger.error(`Failed to resume crypto trading: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to resume trading',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Stop auto-trading session
   */
  @Post('stop')
  async stopTrading() {
    try {
      this.sessionService.stopSession();
      return {
        success: true,
        message: 'Crypto auto trading stopped',
        data: { status: 'stopped' },
      };
    } catch (error: any) {
      this.logger.error(`Failed to stop crypto trading: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to stop trading',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Reset auto-trading session
   */
  @Post('reset')
  async resetTrading() {
    try {
      this.sessionService.resetSession();
      return {
        success: true,
        message: 'Crypto auto trading session reset',
        data: { status: 'idle' },
      };
    } catch (error: any) {
      this.logger.error(`Failed to reset crypto trading: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to reset trading',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Trigger manual execution of all strategies (for testing)
   */
  @Post('execute-now')
  async executeNow() {
    try {
      if (!this.sessionService.isTradeAllowed()) {
        // Auto-start if not running
        const accountBalance = await this.binanceTestnetService.getAccountBalance();
        const usdtBalance = accountBalance.balances.find((b: any) => b.asset === 'USDT')?.free || 0;
        const balance = typeof usdtBalance === 'string' ? parseFloat(usdtBalance) : usdtBalance;
        
        if (balance >= 100) {
          this.sessionService.startSession(balance);
        } else {
          throw new HttpException(
            'Crypto auto trading not active and USDT balance below threshold',
            HttpStatus.BAD_REQUEST,
          );
        }
      }

      const result = await this.cronService.triggerManualExecution();
      
      return {
        success: result.success,
        message: result.success 
          ? `Executed ${result.tradesExecuted} crypto trades`
          : `Execution failed: ${result.errors.join(', ')}`,
        data: result,
      };
    } catch (error: any) {
      this.logger.error(`Failed to execute crypto trades: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to execute trades',
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Execute a single trade (for testing)
   */
  @Post('execute-single')
  async executeSingle() {
    try {
      if (!this.sessionService.isTradeAllowed()) {
        // Auto-start if not running
        const accountBalance = await this.binanceTestnetService.getAccountBalance();
        const usdtBalance = accountBalance.balances.find((b: any) => b.asset === 'USDT')?.free || 0;
        const balance = typeof usdtBalance === 'string' ? parseFloat(usdtBalance) : usdtBalance;
        
        if (balance >= 100) {
          this.sessionService.startSession(balance);
        } else {
          throw new HttpException(
            'Crypto auto trading not active and USDT balance below threshold',
            HttpStatus.BAD_REQUEST,
          );
        }
      }

      const result = await this.executionService.executeManualTrade();
      
      return {
        success: result.success,
        message: result.success 
          ? `Crypto trade executed: ${result.trade?.action} ${result.trade?.symbol}`
          : `Trade failed: ${result.error}`,
        data: result,
      };
    } catch (error: any) {
      this.logger.error(`Failed to execute single crypto trade: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to execute trade',
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get testnet connection status
   */
  @Get('connection')
  async getConnectionStatus() {
    try {
      const status = this.binanceTestnetService.getStatus();
      const connected = status.configured ? await this.binanceTestnetService.verifyConnection() : false;
      
      return {
        success: true,
        data: {
          ...status,
          connected,
          exchange: 'binance-testnet',
          type: 'crypto',
        },
      };
    } catch (error: any) {
      this.logger.error(`Failed to get connection status: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to get connection status',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
