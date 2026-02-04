import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';
import { PythonApiService } from '../../../kyc/integrations/python-api.service';
import { PreBuiltStrategiesService } from './pre-built-strategies.service';
import { StrategyExecutionService } from './strategy-execution.service';
import { ExchangesService } from '../../exchanges/exchanges.service';
import { ConnectionStatus, StrategyType } from '@prisma/client';

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
  async generatePreBuiltSignals(options?: { connectionId?: string }): Promise<void> {
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

      // Step 3: Get first available connection for OHLCV data (or use provided override)
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
              exchange: conn.exchange.name.toLowerCase() || 'binance',
            };
            this.logger.log(`Using overridden connection ${options.connectionId} for OHLCV data`);
          } else {
            this.logger.warn(`Connection ${options.connectionId} not found or has no exchange; falling back to first available`);
            connectionInfo = await this.getFirstAvailableConnection();
          }
        } catch (err: any) {
          this.logger.warn(`Error fetching override connection ${options.connectionId}: ${err.message}`);
          connectionInfo = await this.getFirstAvailableConnection();
        }
      } else {
        connectionInfo = await this.getFirstAvailableConnection();
      }

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

      // Step 6: Process active custom (user) strategies
      await this.processActiveCustomStrategies(trendingAssets, connectionInfo);

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
   * Process all active custom (user) strategies
   * This runs after pre-built strategies to reuse the same cached market data
   */
  private async processActiveCustomStrategies(
    trendingAssets: any[],
    connectionInfo: { connectionId: string | null; exchange: string } | null,
  ): Promise<void> {
    try {
      // Get all active user strategies
      const customStrategies = await this.prisma.strategies.findMany({
        where: {
          type: StrategyType.user,
          is_active: true,
          user_id: { not: null },
          // Note: target_assets can be null - we'll use all trending assets in that case
        },
        include: {
          user: {
            select: {
              user_id: true,
              email: true,
            },
          },
        },
      });

      this.logger.log(`[CustomStrategies] Query completed. Found ${customStrategies.length} strategies`);
      
      if (customStrategies.length === 0) {
        this.logger.log('[CustomStrategies] No active custom strategies found, skipping');
        return;
      }

      // Log each strategy for debugging
      for (const s of customStrategies) {
        this.logger.log(`[CustomStrategies] Found: "${s.name}" (${s.strategy_id}), assets: ${JSON.stringify(s.target_assets)}`);
      }

      this.logger.log(`Processing ${customStrategies.length} active custom strategies`);

      // Build a map of symbol -> asset from trending assets for quick lookup
      const trendingAssetsMap = new Map<string, any>();
      for (const asset of trendingAssets) {
        trendingAssetsMap.set(asset.symbol, asset);
      }

      let customSignalsGenerated = 0;
      let customErrors = 0;

      for (const strategy of customStrategies) {
        try {
          const targetAssets = (strategy.target_assets as string[]) || [];
          
          // If no target assets specified, use ALL trending assets (same as pre-built)
          const assetsToProcess = targetAssets.length > 0
            ? targetAssets
            : trendingAssets.map(a => a.symbol);
          
          this.logger.log(`Processing custom strategy "${strategy.name}" with ${assetsToProcess.length} assets${targetAssets.length === 0 ? ' (using all trending)' : ''}`);

          // Get user-specific connection if available
          const userConnectionInfo = await this.getUserConnection(strategy.user_id, strategy.asset_type || 'crypto');

          // Process each target asset (or all trending if none specified)
          for (const symbol of assetsToProcess) {
            try {
              // First check if asset exists in our trending assets (already has fresh sentiment data)
              let asset = trendingAssetsMap.get(symbol);
              
              if (!asset) {
                // Look up the asset in the database
                asset = await this.prisma.assets.findFirst({
                  where: { symbol },
                });

                if (!asset) {
                  // Create the asset if it doesn't exist
                  asset = await this.prisma.assets.create({
                    data: {
                      symbol,
                      name: symbol,
                      display_name: symbol,
                      asset_type: strategy.asset_type || 'crypto',
                    },
                  });
                }

                // Run sentiment analysis for this asset since it wasn't in trending
                await this.runSentimentAnalysis(asset);
              }

              // Execute the strategy for this asset
              await this.executeCustomStrategyForAsset(
                strategy,
                asset,
                userConnectionInfo || connectionInfo,
              );
              customSignalsGenerated++;
            } catch (error: any) {
              customErrors++;
              this.logger.warn(
                `Error processing ${symbol} for custom strategy ${strategy.name}: ${error.message}`,
              );
            }
          }
        } catch (error: any) {
          this.logger.error(
            `Error processing custom strategy ${strategy.name}: ${error.message}`,
          );
        }
      }

      this.logger.log(
        `Custom strategies processed: ${customSignalsGenerated} signals generated, ${customErrors} errors`,
      );
    } catch (error: any) {
      this.logger.error(`Error processing custom strategies: ${error.message}`);
      // Don't throw - continue with the rest of the cronjob
    }
  }

  /**
   * Execute a custom strategy for a single asset
   */
  private async executeCustomStrategyForAsset(
    strategy: any,
    asset: any,
    connectionInfo: { connectionId: string | null; exchange: string } | null,
  ): Promise<void> {
    // Get market data
    const marketData = await this.getMarketData(asset.asset_id, asset.asset_type);

    // Use provided connection info or default
    const connectionId = connectionInfo?.connectionId || null;
    const exchange = connectionInfo?.exchange || 'binance';

    // Prepare strategy data
    const strategyData = {
      user_id: strategy.user_id,
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
      const assetSymbol = asset.symbol || asset.asset_id;
      const pythonSignal = await this.pythonApi.generateSignal(strategy.strategy_id, asset.asset_id, {
        strategy_data: strategyData,
        market_data: marketData,
        connection_id: connectionId,
        exchange: exchange,
        asset_symbol: assetSymbol,
      });

      // Store signal in database with user_id
      const signal = await this.prisma.strategy_signals.create({
        data: {
          strategy_id: strategy.strategy_id,
          user_id: strategy.user_id, // Associate with user
          asset_id: asset.asset_id,
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
        `Generated signal for custom strategy ${strategy.name} on asset ${asset.symbol}: ${pythonSignal.action}`,
      );
    } catch (error: any) {
      this.logger.error(
        `Error executing custom strategy ${strategy.strategy_id} on asset ${asset.asset_id}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Get user-specific exchange connection
   */
  private async getUserConnection(
    userId: string,
    assetType: string,
  ): Promise<{ connectionId: string | null; exchange: string } | null> {
    try {
      const exchangeName = assetType === 'stock' ? 'alpaca' : 'binance';
      
      const connection = await this.prisma.user_exchange_connections.findFirst({
        where: {
          user_id: userId,
          status: ConnectionStatus.active,
          exchange: {
            name: { contains: exchangeName, mode: 'insensitive' },
          },
        },
        include: { exchange: true },
      });

      if (connection) {
        return {
          connectionId: connection.connection_id,
          exchange: connection.exchange?.name?.toLowerCase() || exchangeName,
        };
      }

      return null;
    } catch (error: any) {
      this.logger.warn(`Error getting user connection for ${userId}: ${error.message}`);
      return null;
    }
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
    this.logger.log('Manual pre-built signals generation triggered');
    await this.generatePreBuiltSignals(options);
    return {
      message: 'Manual generation completed',
      processed: 0, // Would need to track this in the method
      errors: 0,
    };
  }
}
