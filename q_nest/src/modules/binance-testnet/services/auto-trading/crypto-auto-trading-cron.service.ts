import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CryptoAutoTradingExecutionService } from './crypto-auto-trading-execution.service';
import { CryptoAutoTradingSessionService } from './crypto-auto-trading-session.service';
import { BinanceTestnetService } from '../binance-testnet.service';

@Injectable()
export class CryptoAutoTradingCronService implements OnModuleInit {
  private readonly logger = new Logger(CryptoAutoTradingCronService.name);
  private isExecuting = false;

  constructor(
    private executionService: CryptoAutoTradingExecutionService,
    private sessionService: CryptoAutoTradingSessionService,
    private binanceTestnetService: BinanceTestnetService,
  ) {}

  async onModuleInit() {
    this.logger.log('Crypto Auto Trading Cron Service initialized');
    this.logger.log('Scheduled to run every 6 hours: 30 */6 * * * (offset from stocks)');
    
    // Load trade history from database first
    await this.sessionService.loadHistoryFromDatabase();
    
    // Auto-start trading session on module init
    await this.autoStartSession();
  }

  /**
   * Auto-start the trading session if Binance testnet is configured
   */
  private async autoStartSession(): Promise<void> {
    try {
      if (!this.binanceTestnetService.isConfigured()) {
        this.logger.warn('Binance testnet not configured, crypto auto trading will not start');
        return;
      }

      const accountBalance = await this.binanceTestnetService.getAccountBalance();
      const usdtBalance = accountBalance.balances.find((b: any) => b.asset === 'USDT')?.free || 0;
      const startingBalance = typeof usdtBalance === 'string' ? parseFloat(usdtBalance) : usdtBalance;

      if (startingBalance < 100) {
        this.logger.warn(`USDT balance $${startingBalance.toFixed(2)} below $100 threshold, crypto auto trading will not start`);
        return;
      }

      this.sessionService.startSession(startingBalance);
      this.logger.log(`Crypto auto trading auto-started with USDT balance: $${startingBalance.toFixed(2)}`);
    } catch (error: any) {
      this.logger.error(`Failed to auto-start crypto trading: ${error?.message}`);
    }
  }

  /**
   * Main cron job - runs every 6 hours at minute 30 (offset from stocks which runs at minute 0)
   * Executes automated trades for all active crypto strategies
   * Crypto markets are 24/7, so no market hours check needed
   */
  @Cron('30 */6 * * *') // Every 6 hours at minute 30
  async handleAutomatedTrading() {
    if (this.isExecuting) {
      this.logger.warn('Previous crypto execution still in progress, skipping');
      return;
    }

    if (!this.sessionService.isTradeAllowed()) {
      this.logger.debug('Crypto auto trading not active, skipping cron execution');
      return;
    }

    this.isExecuting = true;
    this.logger.log('Starting scheduled crypto auto-trading execution');

    try {
      // Add AI messages for visual effect
      this.sessionService.addAiMessage('Scheduled crypto trading cycle initiated', 'info');
      this.sessionService.addRandomTrainingMessages(2);

      const result = await this.executionService.executeAutomatedTrades();

      if (result.success) {
        this.logger.log(`Crypto auto trading completed: ${result.tradesExecuted} trades executed`);
        this.sessionService.addAiMessage(
          `Crypto trading cycle complete: ${result.tradesExecuted} trades`,
          'success'
        );
      } else {
        this.logger.warn(`Crypto auto trading completed with errors: ${result.errors.join(', ')}`);
        this.sessionService.addAiMessage(
          `Crypto trading cycle completed with ${result.errors.length} errors`,
          'warning'
        );
      }
    } catch (error: any) {
      this.logger.error(`Crypto auto trading cron failed: ${error?.message}`);
      this.sessionService.addAiMessage(`Execution error: ${error?.message}`, 'warning');
    } finally {
      this.isExecuting = false;
    }
  }

  /**
   * Health check cron - runs every 30 minutes
   * Adds AI messages if trading is active (for visual activity)
   * Crypto markets are 24/7, so this always runs
   */
  @Cron('*/30 * * * *') // Every 30 minutes
  async handleHealthCheck() {
    if (!this.sessionService.isTradeAllowed()) {
      return;
    }

    // Add some AI activity messages
    const messages = [
      'Monitoring crypto market conditions 24/7...',
      'Analyzing real-time order book data...',
      'Tracking whale wallet movements...',
      'Scanning for arbitrage opportunities...',
      'Evaluating DeFi protocol metrics...',
      'Processing on-chain analytics...',
      'Monitoring funding rates...',
      'Analyzing social sentiment from crypto Twitter...',
    ];

    const randomMessage = messages[Math.floor(Math.random() * messages.length)];
    this.sessionService.addAiMessage(randomMessage, 'info');
  }

  /**
   * Balance check cron - runs every 2 hours
   * Updates balance and checks if still above threshold
   */
  @Cron('0 */2 * * *') // Every 2 hours
  async handleBalanceCheck() {
    if (!this.sessionService.isTradeAllowed()) {
      return;
    }

    try {
      const accountBalance = await this.binanceTestnetService.getAccountBalance();
      const usdtBalance = accountBalance.balances.find((b: any) => b.asset === 'USDT')?.free || 0;
      const balance = typeof usdtBalance === 'string' ? parseFloat(usdtBalance) : usdtBalance;
      
      this.sessionService.updateBalance(balance);
      this.sessionService.addAiMessage(`USDT balance: $${balance.toFixed(2)}`, 'info');
    } catch (error: any) {
      this.logger.warn(`Failed to check balance: ${error?.message}`);
    }
  }

  /**
   * Manual trigger for testing
   */
  async triggerManualExecution(): Promise<{ success: boolean; tradesExecuted: number; errors: string[] }> {
    if (this.isExecuting) {
      return { success: false, tradesExecuted: 0, errors: ['Execution already in progress'] };
    }

    this.isExecuting = true;
    this.logger.log('Manual crypto execution triggered');

    try {
      this.sessionService.addAiMessage('Manual crypto trading execution triggered', 'info');
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
