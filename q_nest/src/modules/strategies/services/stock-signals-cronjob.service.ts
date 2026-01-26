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
  private isMarketDataSyncing = false; // Prevent concurrent market data sync

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
   * Scheduled job that runs every 5 minutes
   * Syncs stock market data from Alpaca API and stores in database
   * This ensures frontend reads fresh data from DB without live API calls
   */
  @Cron('*/5 * * * *') // Every 5 minutes
  async syncStockMarketData(): Promise<void> {
    if (this.isMarketDataSyncing) {
      this.logger.warn('Previous market data sync still running, skipping this execution');
      return;
    }

    this.isMarketDataSyncing = true;
    const startTime = Date.now();
    this.logger.log('Starting stock market data sync cronjob');

    try {
      const result = await this.stockTrendingService.syncMarketDataFromAlpaca();
      const duration = Date.now() - startTime;
      
      if (result.success) {
        this.logger.log(
          `Stock market data sync completed: ${result.updated} stocks updated in ${duration}ms`,
        );
      } else {
        this.logger.warn(
          `Stock market data sync completed with issues: ${result.errors.length} errors in ${duration}ms`,
        );
      }
    } catch (error: any) {
      this.logger.error(`Fatal error in stock market data sync: ${error.message}`, error.stack);
    } finally {
      this.isMarketDataSyncing = false;
    }
  }

  /**
   * Manual trigger for market data sync (for testing/debugging)
   */
  async triggerMarketDataSync(): Promise<{
    success: boolean;
    updated: number;
    errors: string[];
  }> {
    this.logger.log('Manual stock market data sync triggered');
    return this.stockTrendingService.syncMarketDataFromAlpaca();
  }

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

      // Step 2: Fetch stocks to process (use rotation strategy to process all stocks over time)
      // Process 50 stocks per run (every 10 minutes) to avoid overwhelming the system
      // This ensures all ~500 stocks get processed over ~100 minutes (10 runs)
      const stocksToProcess = await this.getStocksToProcess(50);
      if (stocksToProcess.length === 0) {
        this.logger.warn('No stocks found to process, skipping signal generation');
        return;
      }

      this.logger.log(`Processing ${stocksToProcess.length} stocks (rotating through all active stocks)`);

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
      for (let i = 0; i < stocksToProcess.length; i += this.BATCH_SIZE) {
        const batch = stocksToProcess.slice(i, i + this.BATCH_SIZE);
        const batchNum = Math.floor(i / this.BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(stocksToProcess.length / this.BATCH_SIZE);

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
        if (i + this.BATCH_SIZE < stocksToProcess.length) {
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
    // Check if a signal already exists for this strategy+asset within the last 10 minutes
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const existingSignal = await this.prisma.strategy_signals.findFirst({
      where: {
        strategy_id: strategyId,
        asset_id: assetId,
        user_id: null,
        timestamp: { gte: tenMinutesAgo },
      },
    });

    if (existingSignal) {
      this.logger.debug(
        `Skipping signal generation for strategy ${strategyId} on asset ${assetId} - recent signal exists`,
      );
      return;
    }

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

    let signalData: {
      action: string;
      confidence: number;
      final_score: number;
      engine_scores: any;
      position_sizing?: any;
    };

    try {
      // Call Python API to generate signal
      const assetSymbol = asset.symbol || assetId;
      const pythonSignal = await this.pythonApi.generateSignal(strategyId, assetId, {
        strategy_data: strategyData,
        market_data: {
          ...marketData,
          asset_type: 'stock', // Critical: specify stock type
        },
        connection_id: connectionId,
        exchange: exchange,
        asset_symbol: assetSymbol,
        portfolio_value: 10000, // Default portfolio value for system signals
      });

      signalData = {
        action: pythonSignal.action,
        confidence: pythonSignal.confidence,
        final_score: pythonSignal.final_score,
        engine_scores: pythonSignal.engine_scores || {},
        position_sizing: pythonSignal.position_sizing,
      };

      this.logger.debug(
        `Python API signal generated for ${asset.symbol}: ${pythonSignal.action}`,
      );
    } catch (error: any) {
      // Fallback: Generate basic signal from price data when Python API fails
      this.logger.warn(
        `Python API failed for ${asset.symbol}, using fallback signal generation: ${error.message}`,
      );

      signalData = this.generateFallbackSignal(marketData);
      this.logger.debug(
        `Fallback signal generated for ${asset.symbol}: ${signalData.action}`,
      );
    }

    // Store signal in database (without LLM for now - we'll generate LLM in batch later)
    const signal = await this.prisma.strategy_signals.create({
      data: {
        strategy_id: strategyId,
        user_id: null, // System-generated signal
        asset_id: assetId,
        timestamp: new Date(),
        final_score: signalData.final_score,
        action: signalData.action,
        confidence: signalData.confidence,
        sentiment_score: signalData.engine_scores?.sentiment?.score || 0,
        trend_score: signalData.engine_scores?.trend?.score || 0,
        fundamental_score: signalData.engine_scores?.fundamental?.score || 0,
        liquidity_score: signalData.engine_scores?.liquidity?.score || 0,
        event_risk_score: signalData.engine_scores?.event_risk?.score || 0,
        engine_metadata: signalData.engine_scores || {},
      },
    });

    // Store signal details
    const stopLossValue = strategy.stop_loss_value ? Number(strategy.stop_loss_value) : 5;
    const takeProfitValue = strategy.take_profit_value ? Number(strategy.take_profit_value) : 10;

    await this.prisma.signal_details.create({
      data: {
        signal_id: signal.signal_id,
        entry_price: marketData.price,
        position_size: signalData.position_sizing?.position_size || 1,
        position_value: signalData.position_sizing?.position_size 
          ? signalData.position_sizing.position_size * marketData.price 
          : marketData.price,
        stop_loss: marketData.price * (1 - stopLossValue / 100),
        take_profit_1: marketData.price * (1 + takeProfitValue / 100),
        metadata: {},
      },
    });

    this.logger.debug(
      `Stored signal for strategy ${strategy.name} on stock ${asset.symbol}: ${signalData.action}`,
    );
  }

  /**
   * Generate fallback signal based on price data when Python API fails
   * Uses simple price change logic to determine action
   */
  private generateFallbackSignal(marketData: any): {
    action: string;
    confidence: number;
    final_score: number;
    engine_scores: any;
  } {
    const priceChange = Number(marketData.price_change_24h || 0);
    const volume = Number(marketData.volume || 0);
    
    // Simple logic based on 24h price change
    let action: string;
    let confidence: number;
    let finalScore: number;

    if (priceChange > 3) {
      // Strong positive momentum
      action = 'BUY';
      confidence = Math.min(0.7 + (priceChange / 20), 0.85);
      finalScore = 0.6 + (priceChange / 30);
    } else if (priceChange > 1) {
      // Moderate positive momentum
      action = 'BUY';
      confidence = 0.55 + (priceChange / 15);
      finalScore = 0.4 + (priceChange / 20);
    } else if (priceChange < -3) {
      // Strong negative momentum - could be opportunity or warning
      action = 'HOLD';
      confidence = 0.5;
      finalScore = 0.1;
    } else if (priceChange < -1) {
      // Moderate negative momentum
      action = 'HOLD';
      confidence = 0.45;
      finalScore = 0.2;
    } else {
      // Neutral / low volatility
      action = 'HOLD';
      confidence = 0.5;
      finalScore = 0.3;
    }

    // Volume boost - higher volume = higher confidence
    if (volume > 1000000) {
      confidence = Math.min(confidence + 0.1, 0.9);
    }

    return {
      action,
      confidence: Number(confidence.toFixed(2)),
      final_score: Number(Math.max(0, Math.min(1, finalScore)).toFixed(2)),
      engine_scores: {
        sentiment: { score: 0 },
        trend: { score: priceChange > 0 ? 0.5 : -0.5 },
        fundamental: { score: 0 },
        liquidity: { score: volume > 500000 ? 0.5 : 0.2 },
        event_risk: { score: 0 },
      },
    };
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
   * Returns immediately and runs signal generation in background to avoid HTTP timeout
   */
  async triggerManualGeneration(options?: { connectionId?: string }): Promise<{
    message: string;
    status: string;
  }> {
    if (this.isRunning) {
      this.logger.log('Stock signal generation already in progress');
      return {
        message: 'Stock signal generation already in progress. Please wait for it to complete.',
        status: 'in_progress',
      };
    }

    this.logger.log('Manual stock signals generation triggered - running in background');
    
    // Run in background (don't await) to avoid HTTP timeout
    // The method sets isRunning=true at start and isRunning=false at end
    this.generateStockSignals(options).catch(err => {
      this.logger.error(`Background stock signal generation failed: ${err.message}`);
    });

    return {
      message: 'Stock signal generation started in background. Signals will appear within 1-2 minutes.',
      status: 'started',
    };
  }

  /**
   * Get stocks to process for signal generation
   * Uses rotation strategy: prioritizes stocks with oldest or no signals
   * Processes a limited number per run (50) to avoid overwhelming the system
   * Over time, all ~500 stocks will be processed
   */
  private async getStocksToProcess(limit: number = 50): Promise<Array<{
    asset_id: string;
    symbol: string;
    name: string;
    display_name: string;
    logo_url: string | null;
    asset_type: string;
    sector: string | null;
    price_usd: number;
    price_change_24h: number;
    price_change_24h_usd: number;
    market_cap: number | null;
    volume_24h: number;
    high_24h: number;
    low_24h: number;
    market_volume: number;
    market_cap_rank: number | null;
    poll_timestamp: Date;
  }>> {
    try {
      // Get stocks with their latest signal timestamp (if any)
      // Prioritize stocks that haven't been processed recently or never processed
      const stocks = await this.prisma.$queryRaw<Array<{
        asset_id: string;
        symbol: string;
        name: string;
        display_name: string;
        logo_url: string | null;
        asset_type: string;
        sector: string | null;
        price_usd: number;
        price_change_24h: number;
        price_change_24h_usd: number;
        market_cap: number | null;
        volume_24h: number;
        high_24h: number;
        low_24h: number;
        market_volume: number;
        market_cap_rank: number | null;
        poll_timestamp: Date;
        last_signal_time: Date | null;
      }>>`
        WITH stock_signals AS (
          SELECT 
            asset_id,
            MAX(timestamp) as last_signal_time
          FROM strategy_signals
          WHERE user_id IS NULL
          GROUP BY asset_id
        )
        SELECT DISTINCT ON (a.asset_id)
          a.asset_id,
          a.symbol,
          a.name,
          a.display_name,
          a.logo_url,
          a.asset_type,
          a.sector,
          COALESCE(mr.price_usd, 0) as price_usd,
          COALESCE(mr.change_percent_24h, 0) as price_change_24h,
          COALESCE(mr.change_24h, 0) as price_change_24h_usd,
          COALESCE(mr.market_cap, NULL) as market_cap,
          COALESCE(mr.volume_24h, 0) as volume_24h,
          COALESCE(ta.high_24h, 0) as high_24h,
          COALESCE(ta.low_24h, 0) as low_24h,
          COALESCE(ta.market_volume, 0) as market_volume,
          a.market_cap_rank,
          COALESCE(ta.poll_timestamp, NOW()) as poll_timestamp,
          ss.last_signal_time
        FROM assets a
        LEFT JOIN market_rankings mr ON mr.asset_id = a.asset_id
          AND mr.rank_timestamp = (
            SELECT MAX(rank_timestamp) 
            FROM market_rankings 
            WHERE asset_id = a.asset_id
          )
        LEFT JOIN trending_assets ta ON ta.asset_id = a.asset_id
          AND ta.poll_timestamp = (
            SELECT MAX(poll_timestamp) 
            FROM trending_assets 
            WHERE asset_id = a.asset_id
          )
        LEFT JOIN stock_signals ss ON ss.asset_id = a.asset_id
        WHERE a.asset_type = 'stock'
          AND a.is_active = true
        ORDER BY 
          a.asset_id,
          COALESCE(ss.last_signal_time, '1970-01-01'::timestamp) ASC, -- Oldest signals first (or never processed)
          a.market_cap_rank ASC NULLS LAST -- Then by market cap
        LIMIT ${limit}
      `;

      if (!stocks || stocks.length === 0) {
        this.logger.warn('No stocks found to process, falling back to trending stocks');
        // Fallback to trending stocks if query returns nothing
        return this.stockTrendingService.getTopTrendingStocks(limit);
      }

      this.logger.log(`Selected ${stocks.length} stocks to process (prioritizing those without recent signals)`);

      // Transform to match expected format
      return stocks.map((stock) => ({
        asset_id: stock.asset_id,
        symbol: stock.symbol,
        name: stock.name,
        display_name: stock.display_name || stock.name || stock.symbol,
        logo_url: stock.logo_url,
        asset_type: stock.asset_type,
        sector: stock.sector,
        price_usd: Number(stock.price_usd || 0),
        price_change_24h: Number(stock.price_change_24h || 0),
        price_change_24h_usd: Number(stock.price_change_24h_usd || 0),
        market_cap: stock.market_cap ? Number(stock.market_cap) : null,
        volume_24h: Number(stock.volume_24h || 0),
        high_24h: Number(stock.high_24h || 0),
        low_24h: Number(stock.low_24h || 0),
        market_volume: Number(stock.market_volume || 0),
        market_cap_rank: stock.market_cap_rank,
        poll_timestamp: stock.poll_timestamp,
      }));
    } catch (error: any) {
      this.logger.error(`Failed to get stocks to process: ${error.message}`);
      // Fallback to trending stocks if query fails
      return this.stockTrendingService.getTopTrendingStocks(limit);
    }
  }
}
