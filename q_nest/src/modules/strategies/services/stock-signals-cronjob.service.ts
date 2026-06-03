import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';
import { PythonApiService } from '../../../kyc/integrations/python-api.service';
import { PreBuiltStrategiesService } from './pre-built-strategies.service';
import { StockTrendingService } from './stock-trending.service';
import { StrategyExecutionService } from './strategy-execution.service';
import { ExchangesService } from '../../exchanges/exchanges.service';
import { SignalsService } from '../../signals/signals.service';
import { ConnectionStatus } from '@prisma/client';

// Heartbeat counters: tally what each cron run evaluated even though
// we only persist BUY signals. Mutated inside processStock -> executeStrategyForStock.
interface RunHeartbeat {
  buy: number;
  hold: number;
  sell: number;
  failed: number;
}

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
    @Inject(forwardRef(() => SignalsService))
    private signalsService: SignalsService,
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
   * Processes ALL stock strategies (both pre-built admin strategies and custom user strategies)
   * Fetches stocks, runs sentiment analysis, and generates signals
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
      // Step 1: Get ALL stock strategies (both pre-built and custom user strategies)
      const allStrategies = await this.prisma.strategies.findMany({
        where: {
          asset_type: 'stock',
          is_active: true,
        },
      });
      
      const stockStrategies = allStrategies;
      const preBuiltCount = stockStrategies.filter(s => s.type === 'admin').length;
      const customCount = stockStrategies.filter(s => s.type === 'user').length;
      this.logger.log(`Found ${stockStrategies.length} active stock strategies: ${preBuiltCount} pre-built + ${customCount} custom`);

      if (stockStrategies.length === 0) {
        this.logger.warn('No active stock strategies found, skipping signal generation');
        return;
      }

      // Step 2: Fetch stocks to process (use rotation strategy to process all stocks over time)
      // Process 50 stocks per run (every 10 minutes) to avoid overwhelming the system
      // This ensures all ~500 stocks get processed over ~100 minutes (10 runs)
      // Option B: at ~2,150 eligible stocks, 50/tick = ~7 hour full cycle.
      // Bumped to 100 to halve cycle time to ~3.5 hours. Python concurrency
      // is throttled by BATCH_SIZE below, so 100 here doesn't slam Python.
      const stocksToProcess = await this.getStocksToProcess(100);
      if (stocksToProcess.length === 0) {
        this.logger.warn('No stocks found to process, skipping signal generation');
        return;
      }

      this.logger.log(`Processing ${stocksToProcess.length} stocks (rotating through all active stocks)`);

      // Step 3: For system stock signals, never pass user connection_id so Python
      // uses the system candles endpoint (Alpaca from env) for OHLCV and trend score.
      const connectionInfo = { connectionId: null as string | null, exchange: 'alpaca' as string };

      // Step 4: Process each stock through sentiment analysis and signal generation
      let processedCount = 0;
      let errorCount = 0;
      const heartbeat: RunHeartbeat = { buy: 0, hold: 0, sell: 0, failed: 0 };

      // Process stocks in batches
      for (let i = 0; i < stocksToProcess.length; i += this.BATCH_SIZE) {
        const batch = stocksToProcess.slice(i, i + this.BATCH_SIZE);
        const batchNum = Math.floor(i / this.BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(stocksToProcess.length / this.BATCH_SIZE);

        this.logger.log(`Processing batch ${batchNum}/${totalBatches} (${batch.length} stocks)`);

        await Promise.allSettled(
          batch.map(async (stock) => {
            try {
              await this.processStock(stock, stockStrategies, connectionInfo, heartbeat);
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
      // Heartbeat: how the engine decided on each (strategy, stock) pair this run.
      // Only `buy` rows are persisted to strategy_signals; the rest are visible only here.
      this.logger.log(
        `Engine heartbeat: BUY=${heartbeat.buy} HOLD=${heartbeat.hold} SELL=${heartbeat.sell} failed=${heartbeat.failed} (HOLD/SELL not persisted)`,
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
    heartbeat?: RunHeartbeat,
  ): Promise<void> {
    try {
      // Option B: which Option-B indexes does this stock belong to?
      // Legacy strategies (target_index_code = NULL) still run against every
      // rotated stock unchanged. Option-B strategies only run if the stock is
      // a member of the strategy's target index.
      const stockIndexCodes = await this.getIndexCodesForStock(stock.asset_id);

      // Step 1: Run sentiment analysis (this also fetches news)
      await this.runSentimentAnalysis(stock);

      // Step 2: Generate signals for each stock strategy whose universe
      // matches this stock.
      for (const strategy of strategies) {
        if (
          strategy.target_index_code &&
          !stockIndexCodes.has(strategy.target_index_code)
        ) {
          // Stock isn't in this strategy's target index → skip (no heartbeat
          // increment, since we never even asked the engine).
          continue;
        }

        try {
          await this.executeStrategyForStock(
            strategy.strategy_id,
            stock.asset_id,
            connectionInfo,
            heartbeat,
          );
        } catch (error: any) {
          if (heartbeat) heartbeat.failed++;
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
   * Returns the set of index codes this stock is a member of.
   * Used by Option B to gate per-strategy execution by index membership.
   */
  private async getIndexCodesForStock(assetId: string): Promise<Set<string>> {
    try {
      const rows = await this.prisma.index_membership.findMany({
        where: { asset_id: assetId },
        select: { index: { select: { code: true } } },
      });
      return new Set(rows.map((r) => r.index.code));
    } catch (error: any) {
      this.logger.warn(`Failed to look up index codes for asset ${assetId}: ${error.message}`);
      return new Set();
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
    heartbeat?: RunHeartbeat,
  ): Promise<void> {
    // Get strategy details first to determine type and user_id
    const strategy = await this.prisma.strategies.findUnique({
      where: { strategy_id: strategyId },
    });

    if (!strategy) {
      throw new Error(`Strategy ${strategyId} not found`);
    }

    // Get asset details
    const asset = await this.prisma.assets.findUnique({
      where: { asset_id: assetId },
    });

    if (!asset) {
      throw new Error(`Asset ${assetId} not found`);
    }

    // Get market data
    const marketData = await this.getMarketData(assetId, 'stock');

    // Use provided connection info or default
    const connectionId = connectionInfo?.connectionId || null;
    const exchange = connectionInfo?.exchange || 'alpaca';

    // Prepare strategy data
    const strategyData = {
      user_id: strategy.type === 'user' ? strategy.user_id : null, // Preserve user_id for custom strategies
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
      // No more fake fallback. Previously this path called
      // `generateFallbackSignal` which fabricated hardcoded engine scores
      // (trend=0.5 / fund=0 / sent=0 / ev=0 / liq=0.2) and a price-momentum
      // `action`. Those fake rows polluted strategy_signals, masked real
      // engine bugs, and tricked user strategies into "firing" on
      // never-computed fundamentals. If Python can't score this stock right
      // now (timeout, 5xx, engine error), skip it — the next cron tick will
      // retry. Heartbeat marks the miss for the run summary.
      this.logger.warn(
        `Python signal failed for ${asset.symbol} (${strategy.name}): ${error.message} — skipping (no fake fallback).`,
      );
      if (heartbeat) heartbeat.failed++;
      return;
    }

    // Upsert/delete: DB row mirrors the engine's CURRENT opinion.
    //   BUY  → insert new OR refresh existing (same signal_id)
    //   HOLD/SELL → delete existing BUY for this (strategy, asset) if any
    const stopLossValue = strategy.stop_loss_value ? Number(strategy.stop_loss_value) : 5;
    const takeProfitValue = strategy.take_profit_value ? Number(strategy.take_profit_value) : 10;
    const result = await this.signalsService.upsertOrDeleteFromEngine({
      strategy_id: strategyId,
      asset_id: assetId,
      user_id: strategy.type === 'user' ? strategy.user_id : null,
      action: signalData.action,
      final_score: signalData.final_score,
      confidence: signalData.confidence,
      engine_scores: signalData.engine_scores,
      engine_metadata: { ...(signalData.engine_scores || {}), _writer: 'stock-signals-cronjob' },
      entry_price: marketData.price,
      position_size: signalData.position_sizing?.position_size || 1,
      stop_loss: marketData.price * (1 - stopLossValue / 100),
      take_profit_1: marketData.price * (1 + takeProfitValue / 100),
    });

    if (heartbeat) {
      if (signalData.action === 'BUY') heartbeat.buy++;
      else if (signalData.action === 'SELL') heartbeat.sell++;
      else heartbeat.hold++;
    }
    if (result.deleted) {
      this.logger.debug(
        `Engine flipped on ${asset.symbol} (${strategy.name}) — deleted stale BUY`,
      );
    } else {
      this.logger.debug(
        `Stock signal for ${strategy.name} on ${asset.symbol}: ${signalData.action} (created=${result.created} updated=${result.updated})`,
      );
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
   * Get stocks to process for signal generation.
   *
   * Two hard requirements, both learned the hard way:
   *   1. ONLY stocks with live market data (price_usd > 0). Of ~6.7k active
   *      stock rows, only ~540 (the S&P set) actually have an Alpaca/market
   *      feed. The rest have no price → Python can't score them → wasted calls
   *      and zero signals. We INNER JOIN on the market feed to drop them.
   *   2. TRUE rotation by last_signal_time. The old query used
   *      `DISTINCT ON (a.asset_id)`, which forces `ORDER BY a.asset_id` first,
   *      so the rotation sort was dead — it always returned the same lowest-UUID
   *      stocks and never reached GOOGL/MSFT/etc. We dedupe market/trending rows
   *      in CTEs instead, leaving the outer ORDER BY free to rotate by oldest
   *      signal first.
   *
   * ~540 tradeable stocks / 50 per run / 10-min cadence ≈ 110-min full cycle.
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
        WITH latest_market AS (
          SELECT DISTINCT ON (asset_id)
            asset_id, price_usd, change_percent_24h, change_24h, market_cap, volume_24h
          FROM market_rankings
          ORDER BY asset_id, rank_timestamp DESC
        ),
        latest_trending AS (
          SELECT DISTINCT ON (asset_id)
            asset_id, high_24h, low_24h, market_volume, poll_timestamp
          FROM trending_assets
          ORDER BY asset_id, poll_timestamp DESC
        ),
        stock_signals AS (
          SELECT asset_id, MAX(timestamp) as last_signal_time
          FROM strategy_signals
          WHERE user_id IS NULL
          GROUP BY asset_id
        )
        SELECT
          a.asset_id,
          a.symbol,
          a.name,
          a.display_name,
          a.logo_url,
          a.asset_type,
          a.sector,
          lm.price_usd,
          COALESCE(lm.change_percent_24h, 0) as price_change_24h,
          COALESCE(lm.change_24h, 0) as price_change_24h_usd,
          lm.market_cap,
          COALESCE(lm.volume_24h, 0) as volume_24h,
          COALESCE(lt.high_24h, 0) as high_24h,
          COALESCE(lt.low_24h, 0) as low_24h,
          COALESCE(lt.market_volume, 0) as market_volume,
          a.market_cap_rank,
          COALESCE(lt.poll_timestamp, NOW()) as poll_timestamp,
          ss.last_signal_time
        FROM assets a
        -- INNER JOIN drops the ~6.2k stocks with no live price feed.
        INNER JOIN latest_market lm ON lm.asset_id = a.asset_id AND lm.price_usd > 0
        LEFT JOIN latest_trending lt ON lt.asset_id = a.asset_id
        LEFT JOIN stock_signals ss ON ss.asset_id = a.asset_id
        WHERE a.asset_type = 'stock'
          AND a.is_active = true
          AND a.signal_eligible = true                                -- Option B: skip ineligible stocks (junk tail)
        ORDER BY
          COALESCE(ss.last_signal_time, '1970-01-01'::timestamp) ASC, -- oldest / never processed first → real rotation
          a.market_cap_rank ASC NULLS LAST                            -- tie-break by market cap
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
