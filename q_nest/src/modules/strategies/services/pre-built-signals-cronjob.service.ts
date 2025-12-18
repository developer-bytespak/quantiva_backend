import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';
import { PythonApiService } from '../../../kyc/integrations/python-api.service';
import { PreBuiltStrategiesService } from './pre-built-strategies.service';
import { StrategyExecutionService } from './strategy-execution.service';
import { ExchangesService } from '../../exchanges/exchanges.service';
import { ConnectionStatus } from '@prisma/client';

@Injectable()
export class PreBuiltSignalsCronjobService {
  private readonly logger = new Logger(PreBuiltSignalsCronjobService.name);
  private readonly BATCH_SIZE = 3; // Process 3 assets at a time
  private readonly LLM_LIMIT = 10; // Generate LLM for top 10 signals per strategy
  private isRunning = false; // Prevent concurrent executions

  constructor(
    private prisma: PrismaService,
    private pythonApi: PythonApiService,
    private preBuiltStrategiesService: PreBuiltStrategiesService,
    private strategyExecutionService: StrategyExecutionService,
    @Inject(forwardRef(() => ExchangesService))
    private exchangesService: ExchangesService,
  ) {}

  /**
   * Scheduled job that runs every 10 minutes
   * Fetches trending assets, runs sentiment analysis, and generates signals for all 4 pre-built strategies
   */
  @Cron('*/10 * * * *') // Every 10 minutes
  async generatePreBuiltSignals(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Previous signal generation job still running, skipping this execution');
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();
    this.logger.log('Starting pre-built signals generation cronjob');

    try {
      // Step 1: Get all 4 pre-built strategies
      const strategies = await this.preBuiltStrategiesService.getPreBuiltStrategies();
      if (strategies.length === 0) {
        this.logger.warn('No pre-built strategies found, skipping signal generation');
        return;
      }

      this.logger.log(`Found ${strategies.length} pre-built strategies`);

      // Step 2: Fetch trending assets
      const trendingAssets = await this.preBuiltStrategiesService.getTopTrendingAssets(50);
      if (trendingAssets.length === 0) {
        this.logger.warn('No trending assets found, skipping signal generation');
        return;
      }

      this.logger.log(`Processing ${trendingAssets.length} trending assets`);

      // Step 3: Get first available connection for OHLCV data
      const connectionInfo = await this.getFirstAvailableConnection();

      // Step 4: Process each asset through sentiment analysis and signal generation
      let processedCount = 0;
      let errorCount = 0;

      // Process assets in batches
      for (let i = 0; i < trendingAssets.length; i += this.BATCH_SIZE) {
        const batch = trendingAssets.slice(i, i + this.BATCH_SIZE);
        const batchNum = Math.floor(i / this.BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(trendingAssets.length / this.BATCH_SIZE);

        this.logger.log(`Processing batch ${batchNum}/${totalBatches} (${batch.length} assets)`);

        await Promise.allSettled(
          batch.map(async (asset) => {
            try {
              await this.processAsset(asset, strategies, connectionInfo);
              processedCount++;
            } catch (error: any) {
              errorCount++;
              this.logger.error(
                `Error processing asset ${asset.symbol} (${asset.asset_id}): ${error.message}`,
              );
            }
          }),
        );

        // Small delay between batches to avoid overwhelming APIs
        if (i + this.BATCH_SIZE < trendingAssets.length) {
          await this.sleep(500);
        }
      }

      // Step 5: Generate LLM explanations for top N signals per strategy
      await this.generateLLMExplanationsForTopSignals(strategies);

      const duration = Date.now() - startTime;
      this.logger.log(
        `Pre-built signals generation completed: ${processedCount} processed, ${errorCount} errors, ${duration}ms`,
      );
    } catch (error: any) {
      this.logger.error(`Fatal error in pre-built signals generation: ${error.message}`, error.stack);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Process a single asset: run sentiment analysis and generate signals for all strategies
   */
  private async processAsset(
    asset: any,
    strategies: any[],
    connectionInfo: { connectionId: string | null; exchange: string } | null,
  ): Promise<void> {
    try {
      // Step 1: Run sentiment analysis (this also fetches news)
      await this.runSentimentAnalysis(asset);

      // Step 2: Generate signals for each pre-built strategy
      for (const strategy of strategies) {
        try {
          // Use executeStrategy but with system-level execution (no user_id)
          // We'll need to modify executeStrategy to accept connection info directly
          await this.executeStrategyForAsset(
            strategy.strategy_id,
            asset.asset_id,
            connectionInfo,
          );
        } catch (error: any) {
          this.logger.warn(
            `Error generating signal for strategy ${strategy.name} on asset ${asset.symbol}: ${error.message}`,
          );
          // Continue with other strategies
        }
      }
    } catch (error: any) {
      this.logger.error(`Error processing asset ${asset.symbol}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Run sentiment analysis for an asset
   */
  private async runSentimentAnalysis(asset: any): Promise<void> {
    try {
      if (!asset.symbol || !asset.asset_type) {
        this.logger.warn(`Skipping sentiment for asset ${asset.asset_id}: missing symbol or asset_type`);
        return;
      }

      // Call Python API to analyze sentiment
      await this.pythonApi.post('/api/v1/sentiment/analyze', {
        asset_id: asset.symbol,
        asset_type: asset.asset_type,
      });

      this.logger.debug(`Sentiment analysis completed for ${asset.symbol}`);
    } catch (error: any) {
      this.logger.warn(`Error running sentiment analysis for ${asset.symbol}: ${error.message}`);
      // Don't throw - continue with signal generation even if sentiment fails
    }
  }

  /**
   * Execute strategy on an asset (system-level, no user_id)
   */
  private async executeStrategyForAsset(
    strategyId: string,
    assetId: string,
    connectionInfo: { connectionId: string | null; exchange: string } | null,
  ): Promise<void> {
    // Get strategy
    const strategy = await this.prisma.strategies.findUnique({
      where: { strategy_id: strategyId },
    });

    if (!strategy) {
      throw new Error(`Strategy ${strategyId} not found`);
    }

    // Get asset
    const asset = await this.prisma.assets.findUnique({
      where: { asset_id: assetId },
    });

    if (!asset) {
      throw new Error(`Asset ${assetId} not found`);
    }

    // Get market data
    const marketData = await this.getMarketData(assetId, asset.asset_type);

    // Use provided connection info or default
    const connectionId = connectionInfo?.connectionId || null;
    const exchange = connectionInfo?.exchange || 'binance';

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
        `Generated signal for strategy ${strategy.name} on asset ${asset.symbol}: ${pythonSignal.action}`,
      );
    } catch (error: any) {
      this.logger.error(
        `Error executing strategy ${strategyId} on asset ${assetId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Generate LLM explanations for top N signals per strategy
   */
  private async generateLLMExplanationsForTopSignals(strategies: any[]): Promise<void> {
    this.logger.log('Generating LLM explanations for top signals');

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
            return { ...s, sortScore };
          })
          .sort((a, b) => (b.sortScore || 0) - (a.sortScore || 0))
          .slice(0, this.LLM_LIMIT);

        this.logger.log(
          `Generating LLM explanations for top ${signalsWithScores.length} signals of strategy ${strategy.name}`,
        );

        // Generate LLM explanations
        for (const signal of signalsWithScores) {
          try {
            const asset = signal.asset;
            if (!asset) {
              this.logger.warn(`Asset not found for signal ${signal.signal_id}`);
              continue;
            }

            const assetSymbol = asset.symbol || signal.asset_id;

            // Construct engine_scores from signal fields
            const engineScores = {
              sentiment: { score: Number(signal.sentiment_score || 0) },
              trend: { score: Number(signal.trend_score || 0) },
              fundamental: { score: Number(signal.fundamental_score || 0) },
              liquidity: { score: Number(signal.liquidity_score || 0) },
              event_risk: { score: Number(signal.event_risk_score || 0) },
            };

            const finalScore = Number(signal.final_score || 0);
            const confidence = Number(signal.confidence || 0);

            if (signal.action) {
              const llmResponse = await this.pythonApi.post('/api/v1/llm/explain-signal', {
                signal_data: {
                  action: signal.action,
                  final_score: finalScore,
                  confidence: confidence,
                },
                engine_scores: engineScores,
                asset_id: assetSymbol,
                asset_type: asset.asset_type || 'crypto',
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
            }
          } catch (error: any) {
            this.logger.error(
              `Failed to generate LLM explanation for signal ${signal.signal_id}: ${error.message}`,
            );
            // Create failed explanation record
            try {
              await this.prisma.signal_explanations.create({
                data: {
                  signal_id: signal.signal_id,
                  explanation_status: 'failed',
                  error_message: error.message,
                  text: 'Unable to generate explanation.',
                  retry_count: 0,
                },
              });
            } catch (dbError: any) {
              this.logger.error(
                `Failed to record failed explanation for signal ${signal.signal_id}: ${dbError.message}`,
              );
            }
          }
        }
      } catch (error: any) {
        this.logger.error(
          `Error generating LLM explanations for strategy ${strategy.name}: ${error.message}`,
        );
      }
    }
  }

  /**
   * Get first available connection from database for OHLCV data
   */
  private async getFirstAvailableConnection(): Promise<{
    connectionId: string | null;
    exchange: string;
  } | null> {
    try {
      const connection = await this.prisma.user_exchange_connections.findFirst({
        where: {
          status: ConnectionStatus.active,
        },
        include: {
          exchange: true,
        },
        orderBy: {
          created_at: 'desc',
        },
      });

      if (connection && connection.exchange) {
        return {
          connectionId: connection.connection_id,
          exchange: connection.exchange.name.toLowerCase() || 'binance',
        };
      }

      this.logger.debug('No active connection found, proceeding without OHLCV data');
      return null;
    } catch (error: any) {
      this.logger.warn(`Error fetching connection: ${error.message}`);
      return null;
    }
  }

  /**
   * Get market data for asset
   */
  private async getMarketData(assetId: string, assetType: string | null): Promise<any> {
    const trendingAsset = await this.prisma.trending_assets.findFirst({
      where: { asset_id: assetId },
      orderBy: { poll_timestamp: 'desc' },
    });

    return {
      price: trendingAsset ? Number(trendingAsset.price_usd || 0) : 0,
      volume_24h: trendingAsset ? Number(trendingAsset.market_volume || 0) : 0,
      asset_type: assetType || 'crypto',
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
  async triggerManualGeneration(): Promise<{
    message: string;
    processed: number;
    errors: number;
  }> {
    this.logger.log('Manual pre-built signals generation triggered');
    await this.generatePreBuiltSignals();
    return {
      message: 'Manual generation completed',
      processed: 0, // Would need to track this in the method
      errors: 0,
    };
  }
}
