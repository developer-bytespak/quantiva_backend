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
    try {
      this.logger.log('🚀 Crypto Auto Trading Cron Service initialized');
      this.logger.log('📅 Scheduled to run every 6 hours: 30 */6 * * * (offset from stocks)');
      
      // Load trade history from database first
      this.logger.log('📖 Loading trade history from database...');
      await this.sessionService.loadHistoryFromDatabase();
      this.logger.log('✓ Trade history loaded');
      
      // Auto-start trading session on module init with retry
      this.logger.log('🔄 Attempting to auto-start trading session...');
      await this.autoStartSessionWithRetry();
    } catch (error: any) {
      this.logger.error('❌ CRITICAL ERROR in onModuleInit:', error?.message || error);
      this.logger.error('Stack:', error?.stack);
      // Don't throw - let the app continue even if auto-start fails
    }
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
        this.logger.error(`Crypto auto-start attempt ${attempts}/${maxAttempts} failed: ${error?.message}`);
        if (attempts < maxAttempts) {
          this.logger.log(`Retrying in ${retryDelay/1000} seconds...`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }
    }
    this.logger.error('Failed to auto-start crypto trading after all attempts');
  }

  /**
   * Auto-start the trading session if Binance testnet is configured
   */
  private async autoStartSession(): Promise<void> {
    if (!this.binanceTestnetService.isConfigured()) {
      this.logger.warn('⚠️  Binance testnet not configured - crypto auto trading disabled');
      this.logger.warn('   Set TESTNET_API_KEY and TESTNET_API_SECRET in .env');
      return;
    }

    this.logger.log('✓ Binance testnet credentials configured');
    
    const accountBalance = await this.binanceTestnetService.getAccountBalance();
    const usdtBalance = accountBalance.balances.find((b: any) => b.asset === 'USDT')?.free || 0;
    const startingBalance = typeof usdtBalance === 'string' ? parseFloat(usdtBalance) : usdtBalance;
    
    this.logger.log(`Current USDT balance: $${startingBalance.toFixed(2)}`);

    // Lower threshold to $10 to allow more flexibility on testnet
    const minBalance = 10;
    if (startingBalance < minBalance) {
      this.logger.warn(`⚠️  USDT balance $${startingBalance.toFixed(2)} below $${minBalance} threshold`);
      this.logger.warn('   Crypto auto trading will not start until balance is increased');
      return;
    }

    this.sessionService.startSession(startingBalance);
    this.logger.log(`✓ Crypto auto trading STARTED with USDT balance: $${startingBalance.toFixed(2)}`);
    this.logger.log('✓ Next run scheduled in 6 hours');
  }

  /**
   * Main cron job - runs every 6 hours at minute 30 (offset from stocks which runs at minute 0)
   * Executes automated trades for all active crypto strategies
   * Crypto markets are 24/7, so no market hours check needed
   */
  @Cron('30 */6 * * *') // Every 6 hours at minute 30
  async handleAutomatedTrading() {
    const now = new Date().toISOString();
    this.logger.log(`========================================`);
    this.logger.log(`🪙 CRYPTO AUTO-TRADING CRON TRIGGERED: ${now}`);
    this.logger.log(`========================================`);

    if (this.isExecuting) {
      this.logger.warn('⚠️  Previous crypto execution still in progress, skipping');
      return;
    }

    const sessionStatus = this.sessionService.getStatus();
    this.logger.log(`Session status: ${sessionStatus}`);
    
    if (!this.sessionService.isTradeAllowed()) {
      this.logger.warn('⚠️  Crypto auto trading not active (session not running)');
      this.logger.warn('   The session may have stopped or failed to start');
      this.logger.warn('   Check logs above for auto-start errors or restart the service');
      return;
    }

    this.isExecuting = true;
    this.logger.log('✓ Starting scheduled crypto auto-trading execution');

    try {
      // Add AI messages for visual effect
      this.sessionService.addAiMessage('Scheduled crypto trading cycle initiated', 'info');
      this.sessionService.addRandomTrainingMessages(2);

      const result = await this.executionService.executeAutomatedTrades();

      if (result.success) {
        this.logger.log(`✓ Crypto auto trading completed: ${result.tradesExecuted} trades executed`);
        this.sessionService.addAiMessage(
          `Crypto trading cycle complete: ${result.tradesExecuted} trades`,
          'success'
        );
      } else {
        this.logger.warn(`⚠️  Crypto auto trading completed with errors: ${result.errors.join(', ')}`);
        this.sessionService.addAiMessage(
          `Crypto trading cycle completed with ${result.errors.length} errors`,
          'warning'
        );
      }
    } catch (error: any) {
      this.logger.error(`❌ Crypto auto trading cron failed: ${error?.message}`);
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
