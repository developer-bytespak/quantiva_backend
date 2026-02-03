import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AutoTradingExecutionService } from './auto-trading-execution.service';
import { AutoTradingSessionService } from './auto-trading-session.service';
import { AlpacaPaperTradingService } from '../alpaca-paper-trading.service';

@Injectable()
export class AutoTradingCronService implements OnModuleInit {
  private readonly logger = new Logger(AutoTradingCronService.name);
  private isExecuting = false;

  constructor(
    private executionService: AutoTradingExecutionService,
    private sessionService: AutoTradingSessionService,
    private alpacaService: AlpacaPaperTradingService,
  ) {}

  async onModuleInit() {
    this.logger.log('Auto Trading Cron Service initialized');
    this.logger.log('Scheduled to run every 6 hours: 0 */6 * * *');
    
    // Load trade history from database first
    await this.sessionService.loadHistoryFromDatabase();
    
    // Auto-start trading session on module init with retry
    await this.autoStartSessionWithRetry();
  }

  /**
   * Auto-start with retry logic
   */
  private async autoStartSessionWithRetry(): Promise<void> {
    let attempts = 0;
    const maxAttempts = 3;
    const retryDelay = 5000; // 5 seconds

    while (attempts < maxAttempts) {
      attempts++;
      try {
        await this.autoStartSession();
        return; // Success, exit
      } catch (error: any) {
        this.logger.error(`Auto-start attempt ${attempts}/${maxAttempts} failed: ${error?.message}`);
        if (attempts < maxAttempts) {
          this.logger.log(`Retrying in ${retryDelay/1000} seconds...`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }
    }
    this.logger.error('Failed to auto-start trading after all attempts');
  }

  /**
   * Auto-start the trading session if Alpaca is configured
   */
  private async autoStartSession(): Promise<void> {
    if (!this.alpacaService.isConfigured()) {
      this.logger.warn('⚠️  Alpaca not configured - auto trading disabled');
      this.logger.warn('   Set ALPACA_API_KEY and ALPACA_SECRET_KEY in .env');
      return;
    }

    this.logger.log('✓ Alpaca credentials configured');
    
    const balance = await this.alpacaService.getAccountBalance();
    const startingBalance = balance.equity;
    
    this.logger.log(`Current Alpaca balance: $${startingBalance.toFixed(2)}`);

    // Lower threshold to $1000 to allow more flexibility
    const minBalance = 1000;
    if (startingBalance < minBalance) {
      this.logger.warn(`⚠️  Balance $${startingBalance.toFixed(2)} below $${minBalance} threshold`);
      this.logger.warn('   Auto trading will not start until balance is increased');
      return;
    }

    this.sessionService.startSession(startingBalance);
    this.logger.log(`✓ Auto trading STARTED with balance: $${startingBalance.toFixed(2)}`);
    this.logger.log('✓ Next run scheduled in 6 hours');
  }

  /**
   * Main cron job - runs every 6 hours
   * Executes automated trades for all active strategies
   */
  @Cron('0 */6 * * *') // Every 6 hours at minute 0
  async handleAutomatedTrading() {
    const now = new Date().toISOString();
    this.logger.log(`========================================`);
    this.logger.log(`🤖 AUTO-TRADING CRON TRIGGERED: ${now}`);
    this.logger.log(`========================================`);

    if (this.isExecuting) {
      this.logger.warn('⚠️  Previous execution still in progress, skipping');
      return;
    }

    const sessionStatus = this.sessionService.getStatus();
    this.logger.log(`Session status: ${sessionStatus}`);
    
    if (!this.sessionService.isTradeAllowed()) {
      this.logger.warn('⚠️  Auto trading not active (session not running)');
      this.logger.warn('   The session may have stopped or failed to start');
      this.logger.warn('   Check logs above for auto-start errors or restart the service');
      return;
    }

    this.isExecuting = true;
    this.logger.log('✓ Starting scheduled auto-trading execution');

    try {
      // Add AI messages for visual effect
      this.sessionService.addAiMessage('Scheduled trading cycle initiated', 'info');
      this.sessionService.addRandomTrainingMessages(2);

      const result = await this.executionService.executeAutomatedTrades();

      if (result.success) {
        this.logger.log(`✓ Auto trading completed: ${result.tradesExecuted} trades executed`);
        this.sessionService.addAiMessage(
          `Trading cycle complete: ${result.tradesExecuted} trades`,
          'success'
        );
      } else {
        this.logger.warn(`⚠️  Auto trading completed with errors: ${result.errors.join(', ')}`);
        this.sessionService.addAiMessage(
          `Trading cycle completed with ${result.errors.length} errors`,
          'warning'
        );
      }
    } catch (error: any) {
      this.logger.error(`❌ Auto trading cron failed: ${error?.message}`);
      this.logger.error(error.stack);
      this.sessionService.addAiMessage(`Execution error: ${error?.message}`, 'warning');
    } finally {
      this.isExecuting = false;
      this.logger.log(`========================================`);
    }
  }

  /**
   * Health check cron - runs every 30 minutes
   * Adds AI messages if trading is active (for visual activity)
   */
  @Cron('*/30 * * * *') // Every 30 minutes
  async handleHealthCheck() {
    if (!this.sessionService.isTradeAllowed()) {
      return;
    }

    // Add some AI activity messages
    const messages = [
      'Monitoring market conditions...',
      'Analyzing real-time data feeds...',
      'Updating risk parameters...',
      'Scanning for opportunities...',
      'Evaluating portfolio exposure...',
    ];

    const randomMessage = messages[Math.floor(Math.random() * messages.length)];
    this.sessionService.addAiMessage(randomMessage, 'info');
  }

  /**
   * Market hours check - runs every hour during market hours
   * Only executes during US market hours (9:30 AM - 4:00 PM EST)
   */
  @Cron('30 9-16 * * 1-5', { timeZone: 'America/New_York' }) // Market hours only
  async handleMarketHoursCheck() {
    if (!this.sessionService.isTradeAllowed()) {
      return;
    }

    this.sessionService.addAiMessage('Market hours active - monitoring positions', 'info');
  }

  /**
   * Manual trigger for testing
   */
  async triggerManualExecution(): Promise<{ success: boolean; tradesExecuted: number; errors: string[] }> {
    if (this.isExecuting) {
      return { success: false, tradesExecuted: 0, errors: ['Execution already in progress'] };
    }

    this.isExecuting = true;
    this.logger.log('Manual execution triggered');

    try {
      this.sessionService.addAiMessage('Manual trading execution triggered', 'info');
      const result = await this.executionService.executeAutomatedTrades();
      return result;
    } finally {
      this.isExecuting = false;
    }
  }

  /**
   * Get execution status
   */
  isCurrentlyExecuting(): boolean {
    return this.isExecuting;
  }
}
