import {
  Controller,
  Get,
  Post,
  Logger,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { AlpacaPaperTradingService } from '../alpaca-paper-trading.service';
import { AutoTradingSessionService } from './auto-trading-session.service';
import { AutoTradingExecutionService } from './auto-trading-execution.service';
import { AutoTradingCronService } from './auto-trading-cron.service';
import { AutoTradingStatsService } from './auto-trading-stats.service';

@Controller('alpaca-paper-trading/auto-trading')
export class AutoTradingController {
  private readonly logger = new Logger(AutoTradingController.name);

  constructor(
    private readonly alpacaService: AlpacaPaperTradingService,
    private readonly sessionService: AutoTradingSessionService,
    private readonly executionService: AutoTradingExecutionService,
    private readonly cronService: AutoTradingCronService,
    private readonly statsService: AutoTradingStatsService,
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
      this.logger.error(`Failed to get status: ${error?.message}`);
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
      this.logger.error(`Failed to get stats: ${error?.message}`);
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
      this.logger.error(`Failed to get summary: ${error?.message}`);
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
      this.logger.error(`Failed to get trades: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to get trades',
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
      this.logger.error(`Failed to get messages: ${error?.message}`);
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
      const currentStatus = this.sessionService.getStatus();
      if (currentStatus === 'running') {
        return {
          success: false,
          message: 'Auto trading is already running',
          data: { status: currentStatus },
        };
      }

      // Get current balance from Alpaca
      const balance = await this.alpacaService.getAccountBalance();
      const startingBalance = balance.equity;

      // Check minimum balance
      if (startingBalance < 10000) {
        return {
          success: false,
          message: `Balance $${startingBalance.toFixed(2)} is below minimum $10,000 threshold`,
          data: { currentBalance: startingBalance },
        };
      }

      // Start the session
      this.sessionService.startSession(startingBalance);

      this.logger.log(`Auto trading started with balance: $${startingBalance}`);

      return {
        success: true,
        message: 'Auto trading started',
        data: {
          status: 'running',
          startingBalance,
          nextRunTime: this.sessionService.getSession().nextRunTime,
        },
      };
    } catch (error: any) {
      this.logger.error(`Failed to start auto trading: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to start auto trading',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Pause auto-trading session
   */
  @Post('pause')
  async pauseTrading() {
    try {
      const currentStatus = this.sessionService.getStatus();
      if (currentStatus !== 'running') {
        return {
          success: false,
          message: `Cannot pause: current status is ${currentStatus}`,
          data: { status: currentStatus },
        };
      }

      this.sessionService.pauseSession();
      this.logger.log('Auto trading paused');

      return {
        success: true,
        message: 'Auto trading paused',
        data: { status: 'paused' },
      };
    } catch (error: any) {
      this.logger.error(`Failed to pause auto trading: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to pause auto trading',
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
      const currentStatus = this.sessionService.getStatus();
      if (currentStatus !== 'paused') {
        return {
          success: false,
          message: `Cannot resume: current status is ${currentStatus}`,
          data: { status: currentStatus },
        };
      }

      this.sessionService.resumeSession();
      this.logger.log('Auto trading resumed');

      return {
        success: true,
        message: 'Auto trading resumed',
        data: { 
          status: 'running',
          nextRunTime: this.sessionService.getSession().nextRunTime,
        },
      };
    } catch (error: any) {
      this.logger.error(`Failed to resume auto trading: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to resume auto trading',
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
      this.logger.log('Auto trading stopped');

      return {
        success: true,
        message: 'Auto trading stopped',
        data: { status: 'stopped' },
      };
    } catch (error: any) {
      this.logger.error(`Failed to stop auto trading: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to stop auto trading',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Reset session (clear all data and return to idle)
   */
  @Post('reset')
  async resetSession() {
    try {
      this.sessionService.resetSession();
      this.logger.log('Auto trading session reset');

      return {
        success: true,
        message: 'Session reset to idle',
        data: { status: 'idle' },
      };
    } catch (error: any) {
      this.logger.error(`Failed to reset session: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to reset session',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Execute trades manually (for testing)
   * This bypasses the cron schedule and executes immediately
   */
  @Post('execute-now')
  async executeNow() {
    try {
      const currentStatus = this.sessionService.getStatus();
      if (currentStatus !== 'running') {
        return {
          success: false,
          message: `Cannot execute: auto trading is ${currentStatus}. Start trading first.`,
          data: { status: currentStatus },
        };
      }

      if (this.cronService.isCurrentlyExecuting()) {
        return {
          success: false,
          message: 'Execution already in progress',
          data: { isExecuting: true },
        };
      }

      this.logger.log('Manual execution triggered');
      this.sessionService.addAiMessage('Manual execution triggered', 'info');

      const result = await this.cronService.triggerManualExecution();

      return {
        success: result.success,
        message: result.success 
          ? `Executed ${result.tradesExecuted} trades`
          : `Execution completed with errors: ${result.errors.join(', ')}`,
        data: {
          tradesExecuted: result.tradesExecuted,
          errors: result.errors,
        },
      };
    } catch (error: any) {
      this.logger.error(`Failed to execute manual trades: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to execute trades',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Execute a single trade manually (for testing)
   */
  @Post('execute-single')
  async executeSingle() {
    try {
      const currentStatus = this.sessionService.getStatus();
      if (currentStatus !== 'running') {
        return {
          success: false,
          message: `Cannot execute: auto trading is ${currentStatus}. Start trading first.`,
          data: { status: currentStatus },
        };
      }

      this.sessionService.addAiMessage('Single trade execution triggered', 'info');

      const result = await this.executionService.executeManualTrade();

      return {
        success: result.success,
        message: result.success 
          ? `Trade executed: ${result.trade?.action} ${result.trade?.symbol}`
          : result.error,
        data: result.trade,
      };
    } catch (error: any) {
      this.logger.error(`Failed to execute single trade: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to execute trade',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
