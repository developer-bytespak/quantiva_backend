import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';
import { PythonApiService } from '../../../kyc/integrations/python-api.service';
import { PreBuiltStrategiesService } from './pre-built-strategies.service';
import { StockTrendingService } from './stock-trending.service';
import { StrategyExecutionService } from './strategy-execution.service';
import { ExchangesService } from '../../exchanges/exchanges.service';
import { ConnectionStatus } from '@prisma/client';

@Injectable()
export class StockSignalsCronjobService {
  private readonly logger = new Logger(StockSignalsCronjobService.name);
  private readonly BATCH_SIZE = 3; // Process 3 stocks at a time
  private readonly LLM_LIMIT = 10; // Generate LLM for top 10 signals per strategy
  private isRunning = false; // Prevent concurrent executions

  constructor(
    private prisma: PrismaService,
    private pythonApi: PythonApiService,
    private preBuiltStrategiesService: PreBuiltStrategiesService,
    private stockTrendingService: StockTrendingService,
    private strategyExecutionService: StrategyExecutionService,
    @Inject(forwardRef(() => ExchangesService))
    private exchangesService: ExchangesService,
  ) {}

  /**
   * Scheduled job that runs every 10 minutes
   * Fetches trending stocks, runs sentiment analysis, and generates signals for stock-specific strategies
   */
  @Cron('*/10 * * * *') // Every 10 minutes
  async generateStockSignals(options?: { connectionId?: string }): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Previous stock signal generation job still running, skipping this execution');
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();
    this.logger.log('Starting stock signals generation cronjob');

    try {
      // Step 1: Get stock-specific pre-built strategies
      const allStrategies = await this.preBuiltStrategiesService.getPreBuiltStrategies();
      const stockStrategies = allStrategies.filter(s => 
        s.name.includes('Stock') || 
        s.name === 'Conservative Growth (Stocks)' ||
        s.name === 'Tech Momentum (Stocks)' ||
        s.name === 'Value Investing (Stocks)' ||
        s.name === 'Dividend Income (Stocks)'
      );

      if (stockStrategies.length === 0) {
        this.logger.warn('No stock-specific strategies found, skipping signal generation');
        return;
      }

      this.logger.log(`Found ${stockStrategies.length} stock-specific strategies`);

      // Step 2: Fetch trending stocks from database
      const trendingStocks = await this.stockTrendingService.getTopTrendingStocks(50);
      if (trendingStocks.length === 0) {
        this.logger.warn('No trending stocks found, skipping signal generation');
        return;
      }

      this.logger.log(`Processing ${trendingStocks.length} trending stocks`);

      // Step 3: Get Alpaca connection for OHLCV data (or use provided override)
      let connectionInfo = null;
      if (options?.connectionId) {
        try {
          const conn = await this.prisma.user_exchange_connections.findUnique({
            where: { connection_id: options.connectionId },
            include: { exchange: true },
          });
          if (conn && conn.exchange) {
            connectionInfo = {
              connectionId: conn.connection_id,
              exchange: conn.exchange.name.toLowerCase() || 'alpaca',
            };
            this.logger.log(`Using overridden connection ${options.connectionId} for OHLCV data`);
          } else {
            this.logger.warn(`Connection ${options.connectionId} not found or has no exchange; falling back to first available`);
            connectionInfo = await this.getFirstAlpacaConnection();
          }
        } catch (err: any) {
          this.logger.warn(`Error fetching override connection ${options.connectionId}: ${err.message}`);
          connectionInfo = await this.getFirstAlpacaConnection();
        }
      } else {
        connectionInfo = await this.getFirstAlpacaConnection();
      }

      // Step 4: Process each stock through sentiment analysis and signal generation
      let processedCount = 0;
      let errorCount = 0;

      // Process stocks in batches
      for (let i = 0; i < trendingStocks.length; i += this.BATCH_SIZE) {
        const batch = trendingStocks.slice(i, i + this.BATCH_SIZE);
        const batchNum = Math.floor(i / this.BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(trendingStocks.length / this.BATCH_SIZE);

        this.logger.log(`Processing batch ${batchNum}/${totalBatches} (${batch.length} stocks)`);

        await Promise.allSettled(
          batch.map(async (stock) => {
            try {
              await this.processStock(stock, stockStrategies, connectionInfo);
              processedCount++;
            } catch (error: any) {
              errorCount++;
              this.logger.error(
                `Error processing stock ${stock.symbol} (${stock.asset_id}): ${error.message}`,
              );
            }
          }),
        );

        // Small delay between batches to avoid overwhelming APIs
        if (i + this.BATCH_SIZE < trendingStocks.length) {
          await this.sleep(500);
        }
      }

      // Step 5: Generate LLM explanations for top N signals per strategy
      await this.generateLLMExplanationsForTopSignals(stockStrategies);

      const duration = Date.now() - startTime;
      this.logger.log(
        `Stock signals generation completed: ${processedCount} processed, ${errorCount} errors, ${duration}ms`,
      );
    } catch (error: any) {
      this.logger.error(`Fatal error in stock signals generation: ${error.message}`, error.stack);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Process a single stock: run sentiment analysis and generate signals for all strategies
   */
  private async processStock(
    stock: any,
    strategies: any[],
    connectionInfo: { connectionId: string | null; exchange: string } | null,
  ): Promise<void> {
    try {
      // Step 1: Run sentiment analysis (this also fetches news)
      await this.runSentimentAnalysis(stock);

      // Step 2: Generate signals for each stock strategy
      for (const strategy of strategies) {
        try {
          await this.executeStrategyForStock(
            strategy.strategy_id,
            stock.asset_id,
            connectionInfo,
          );
        } catch (error: any) {
          this.logger.warn(
            `Error generating signal for strategy ${strategy.name} on stock ${stock.symbol}: ${error.message}`,
          );
          // Continue with other strategies
        }
      }
    } catch (error: any) {
      this.logger.error(`Error processing stock ${stock.symbol}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Run sentiment analysis for a stock
   */
  private async runSentimentAnalysis(stock: any): Promise<void> {
    try {
      if (!stock.symbol || !stock.asset_type) {
        this.logger.warn(`Skipping sentiment for stock ${stock.asset_id}: missing symbol or asset_type`);
        return;
      }

      // Call Python API to analyze sentiment (with asset_type='stock')
      await this.pythonApi.post('/api/v1/sentiment/analyze', {
        asset_id: stock.symbol,
        asset_type: 'stock',
      });

      this.logger.debug(`Sentiment analysis completed for ${stock.symbol}`);
    } catch (error: any) {
      this.logger.warn(`Error running sentiment analysis for ${stock.symbol}: ${error.message}`);
      // Don't throw - continue with signal generation even if sentiment fails
    }
  }

  /**
   * Execute strategy on a stock (system-level, no user_id)
   */
  private async executeStrategyForStock(
    strategyId: string,
    assetId: string,
    connectionInfo: { connectionId: string | null; exchange: string } | null,
  ): Promise<void> {
    // Get strategy and asset details
    const strategy = await this.prisma.strategies.findUnique({
      where: { strategy_id: strategyId },
    });

    const asset = await this.prisma.assets.findUnique({
      where: { asset_id: assetId },
    });

    if (!strategy || !asset) {
      throw new Error('Strategy or asset not found');
    }

    // Get market data
    const marketData = await this.getMarketData(assetId, 'stock');

    // Use provided connection info or default
    const connectionId = connectionInfo?.connectionId || null;
    const exchange = connectionInfo?.exchange || 'alpaca';

    // Prepare strategy data
    const strategyData = {
      user_id: null, // System-level execution
      entry_rules: strategy.entry_rules || [],
      exit_rules: strategy.exit_rules || [],
      indicators: strategy.indicators || [],
      timeframe: strategy.timeframe,
      engine_weights:
        strategy.engine_weights || {
          sentiment: 0.35,
          trend: 0.25,
          fundamental: 0.15,
          event_risk: 0.15,
          liquidity: 0.1,
        },
      stop_loss_value: strategy.stop_loss_value,
      take_profit_value: strategy.take_profit_value,
    };

    try {
      // Call Python API to generate signal
      const assetSymbol = asset.symbol || assetId;
      const pythonSignal = await this.pythonApi.generateSignal(strategyId, assetId, {
        strategy_data: strategyData,
        market_data: marketData,
        connection_id: connectionId,
        exchange: exchange,
        asset_symbol: assetSymbol,
        asset_type: 'stock', // Critical: specify stock type
        portfolio_value: 10000, // Default portfolio value for system signals
      });

      // Store signal in database (without LLM for now - we'll generate LLM in batch later)
      const signal = await this.prisma.strategy_signals.create({
        data: {
          strategy_id: strategyId,
          user_id: null, // System-generated signal
          asset_id: assetId,
          timestamp: new Date(),
          final_score: pythonSignal.final_score,
          action: pythonSignal.action,
          confidence: pythonSignal.confidence,
          sentiment_score: pythonSignal.engine_scores?.sentiment?.score || 0,
          trend_score: pythonSignal.engine_scores?.trend?.score || 0,
          fundamental_score: pythonSignal.engine_scores?.fundamental?.score || 0,
          liquidity_score: pythonSignal.engine_scores?.liquidity?.score || 0,
          event_risk_score: pythonSignal.engine_scores?.event_risk?.score || 0,
          engine_metadata: pythonSignal.engine_scores || {},
        },
      });

      // Store signal details if position sizing is available
      if (pythonSignal.position_sizing) {
        const stopLossValue = strategy.stop_loss_value ? Number(strategy.stop_loss_value) : null;
        const takeProfitValue = strategy.take_profit_value ? Number(strategy.take_profit_value) : null;

        await this.prisma.signal_details.create({
          data: {
            signal_id: signal.signal_id,
            entry_price: marketData.price,
            position_size: pythonSignal.position_sizing.position_size,
            position_value: pythonSignal.position_sizing.position_size * marketData.price,
            stop_loss: stopLossValue ? marketData.price * (1 - stopLossValue / 100) : null,
            take_profit_1: takeProfitValue ? marketData.price * (1 + takeProfitValue / 100) : null,
            metadata: pythonSignal.metadata || {},
          },
        });
      }

      this.logger.debug(
        `Generated signal for strategy ${strategy.name} on stock ${asset.symbol}: ${pythonSignal.action}`,
      );
    } catch (error: any) {
      this.logger.error(
        `Error executing strategy ${strategyId} on stock ${assetId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Generate LLM explanations for top N signals per strategy
   */
  private async generateLLMExplanationsForTopSignals(strategies: any[]): Promise<void> {
    this.logger.log('Generating LLM explanations for top stock signals');

    for (const strategy of strategies) {
      try {
        // Get all signals for this strategy (without explanations)
        const signals = await this.prisma.strategy_signals.findMany({
          where: {
            strategy_id: strategy.strategy_id,
            user_id: null, // Only system-generated signals
            explanations: {
              none: {}, // Signals without explanations
            },
          },
          include: {
            asset: true,
          },
          orderBy: {
            timestamp: 'desc',
          },
          take: 100, // Fetch enough to find top N
        });

        if (signals.length === 0) {
          this.logger.debug(`No signals found for strategy ${strategy.name}`);
          continue;
        }

        // Sort signals by priority: action (BUY > SELL > HOLD), then final_score, then confidence
        const signalsWithScores = signals
          .filter((s) => s.action)
          .map((s) => {
            const actionPriority = s.action === 'BUY' ? 3 : s.action === 'SELL' ? 2 : 1;
            const finalScore = Number(s.final_score || 0);
            const confidence = Number(s.confidence || 0);
            const sortScore = actionPriority * 1000 + finalScore * 0.7 + confidence * 0.3;
            return { signal: s, sortScore };
          })
          .sort((a, b) => b.sortScore - a.sortScore);

        // Take top N
        const topSignals = signalsWithScores.slice(0, this.LLM_LIMIT).map((s) => s.signal);

        this.logger.log(`Generating LLM for ${topSignals.length} top signals for ${strategy.name}`);

        // Generate LLM explanations
        for (const signal of topSignals) {
          try {
            const asset = signal.asset;
            if (!asset) continue;

            const assetSymbol = asset.symbol || signal.asset_id;
            const finalScore = Number(signal.final_score || 0);
            const confidence = Number(signal.confidence || 0);
            const engineScores = (signal.engine_metadata as any) || {};

            const llmResponse = await this.pythonApi.post('/api/v1/llm/explain-signal', {
              signal_data: {
                action: signal.action,
                final_score: finalScore,
                confidence: confidence,
              },
              engine_scores: engineScores,
              asset_id: assetSymbol,
              asset_type: 'stock', // Critical: specify stock type for LLM context
            });

            // Store explanation
            await this.prisma.signal_explanations.create({
              data: {
                signal_id: signal.signal_id,
                llm_model: llmResponse.data.model,
                text: llmResponse.data.explanation,
                explanation_status: 'generated',
                error_message: null,
                retry_count: 0,
              },
            });

            this.logger.debug(`Generated LLM explanation for signal ${signal.signal_id}`);
          } catch (error: any) {
            this.logger.warn(`Error generating LLM for signal ${signal.signal_id}: ${error.message}`);
            // Continue with other signals
          }
        }
      } catch (error: any) {
        this.logger.error(`Error processing LLM for strategy ${strategy.name}: ${error.message}`);
        // Continue with other strategies
      }
    }
  }

  /**
   * Get first available Alpaca connection from database
   */
  private async getFirstAlpacaConnection(): Promise<{
    connectionId: string | null;
    exchange: string;
  } | null> {
    try {
      const connection = await this.prisma.user_exchange_connections.findFirst({
        where: {
          status: ConnectionStatus.active,
          exchange: {
            name: 'Alpaca',
          },
        },
        include: { exchange: true },
      });

      if (connection && connection.exchange) {
        this.logger.log(`Using Alpaca connection ${connection.connection_id} for OHLCV data`);
        return {
          connectionId: connection.connection_id,
          exchange: 'alpaca',
        };
      }

      this.logger.warn('No active Alpaca connection found');
      return null;
    } catch (error: any) {
      this.logger.error(`Error finding Alpaca connection: ${error.message}`);
      return null;
    }
  }

  /**
   * Get market data for stock
   */
  private async getMarketData(assetId: string, assetType: string | null): Promise<any> {
    // Fetch from trending_assets table
    const trendingData = await this.prisma.trending_assets.findFirst({
      where: { asset_id: assetId },
      orderBy: { poll_timestamp: 'desc' },
    });

    if (trendingData) {
      return {
        price: Number(trendingData.price_usd || 0),
        volume: Number(trendingData.volume_24h || 0),
        market_cap: Number(trendingData.market_cap || 0),
        price_change_24h: Number(trendingData.price_change_24h || 0),
      };
    }

    // Fallback: basic placeholder data
    return {
      price: 100,
      volume: 1000000,
      market_cap: 100000000,
      price_change_24h: 0,
    };
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Manual trigger for testing/debugging
   */
  async triggerManualGeneration(options?: { connectionId?: string }): Promise<{
    message: string;
    processed: number;
    errors: number;
  }> {
    this.logger.log('Manual stock signals generation triggered');
    await this.generateStockSignals(options);
    return {
      message: 'Manual stock generation completed',
      processed: 0, // Would need to track this in the method
      errors: 0,
    };
  }
}
