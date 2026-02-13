import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { PythonApiService } from '../../../kyc/integrations/python-api.service';
import { SignalsService } from '../../signals/signals.service';
import { SignalAction } from '@prisma/client';
import { ExchangesService } from '../../exchanges/exchanges.service';

@Injectable()
export class StrategyExecutionService {
  private readonly logger = new Logger(StrategyExecutionService.name);

  constructor(
    private prisma: PrismaService,
    private pythonApi: PythonApiService,
    private signalsService: SignalsService,
    @Inject(forwardRef(() => ExchangesService))
    private exchangesService: ExchangesService,
  ) {}

  /**
   * Execute strategy on an asset
   */
  async executeStrategy(
    strategyId: string,
    assetId: string,
    generateLLM: boolean = false,
  ): Promise<any> {
    // Get strategy
    const strategy = await this.prisma.strategies.findUnique({
      where: {
        strategy_id: strategyId,
      },
    });

    if (!strategy) {
      throw new Error(`Strategy ${strategyId} not found`);
    }

    // Get asset
    const asset = await this.prisma.assets.findUnique({
      where: {
        asset_id: assetId,
      },
    });

    if (!asset) {
      throw new Error(`Asset ${assetId} not found`);
    }

    // Get market data
    const marketData = await this.getMarketData(assetId, asset.asset_type);

    // Get user's active connection for OHLCV data fetching
    let connectionId: string | null = null;
    let exchange: string = 'binance';
    try {
      if (strategy.user_id) {
        const activeConnection = await this.exchangesService.getActiveConnection(strategy.user_id);
        connectionId = activeConnection.connection_id;
        exchange = activeConnection.exchange?.name?.toLowerCase() || 'binance';
        this.logger.debug(`Using connection ${connectionId} for exchange ${exchange}`);
      }
    } catch (error: any) {
      this.logger.warn(
        `Could not get active connection for user ${strategy.user_id}: ${error.message}. OHLCV data may not be available.`,
      );
    }

    // Prepare strategy data
    // Normalize null/undefined to empty arrays for Python parser
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
      this.logger.log(`🎯 Executing strategy ${strategyId} for asset ${assetId} (${asset?.symbol})`);
      
      // Call Python API to generate signal
      // Pass asset symbol for OHLCV fetching (Python services need symbol, not UUID)
      const assetSymbol = asset.symbol || assetId;
      this.logger.log(`📡 Calling Python API with: strategyId=${strategyId}, assetId=${assetId}, symbol=${assetSymbol}`);
      
      const pythonSignal = await this.pythonApi.generateSignal(
        strategyId,
        assetId,
        {
          strategy_data: strategyData,
          market_data: marketData,
          connection_id: connectionId,
          exchange: exchange,
          asset_symbol: assetSymbol, // Pass symbol for OHLCV fetching
        },
      );

      this.logger.log(`✅ Python signal received: action=${pythonSignal.action}, score=${pythonSignal.final_score}, confidence=${pythonSignal.confidence}`);

      // Store signal in database
      const signal = await this.signalsService.create({
        strategy_id: strategyId,
        user_id: strategy.user_id || undefined,
        asset_id: assetId,
        timestamp: new Date(),
        final_score: pythonSignal.final_score,
        action: pythonSignal.action as SignalAction,
        confidence: pythonSignal.confidence,
        sentiment_score: pythonSignal.engine_scores?.sentiment?.score || 0,
        trend_score: pythonSignal.engine_scores?.trend?.score || 0,
        fundamental_score: pythonSignal.engine_scores?.fundamental?.score || 0,
        liquidity_score: pythonSignal.engine_scores?.liquidity?.score || 0,
        event_risk_score: pythonSignal.engine_scores?.event_risk?.score || 0,
      });

      this.logger.log(`💾 Signal stored in database: signal_id=${signal.signal_id}`);

      // Store signal details if position sizing is available
      if (pythonSignal.position_sizing) {
        const stopLossValue = strategy.stop_loss_value
          ? Number(strategy.stop_loss_value)
          : null;
        const takeProfitValue = strategy.take_profit_value
          ? Number(strategy.take_profit_value)
          : null;

        await this.signalsService.createDetail(signal.signal_id, {
          entry_price: marketData.price,
          position_size: pythonSignal.position_sizing.position_size,
          position_value:
            pythonSignal.position_sizing.position_size * marketData.price,
          stop_loss: stopLossValue
            ? marketData.price * (1 - stopLossValue / 100)
            : undefined,
          take_profit_1: takeProfitValue
            ? marketData.price * (1 + takeProfitValue / 100)
            : undefined,
          metadata: pythonSignal.metadata,
        });
      }

      // Generate LLM explanation SYNCHRONOUSLY (wait for it) - only if generateLLM is true
      let explanation = null;
      // Note: LLM generation is controlled by the caller (executeStrategyOnAssets)
      // This method will generate LLM if generateLLM parameter is true
      // For now, we'll skip LLM here and let executeStrategyOnAssets handle it

      // Generate LLM explanation if requested
      if (generateLLM) {
        try {
          // Use asset symbol instead of UUID for LLM
          const assetSymbol = asset.symbol || assetId;
          
          // Handle null values - provide defaults
          const finalScore = pythonSignal.final_score ?? 0;
          const confidence = pythonSignal.confidence ?? 0;
          
          // Only generate if we have valid action
          if (pythonSignal.action) {
            const llmResponse = await this.pythonApi.post('/api/v1/llm/explain-signal', {
              signal_data: {
                action: pythonSignal.action,
                final_score: finalScore,
                confidence: confidence,
              },
              engine_scores: pythonSignal.engine_scores || {},
              asset_id: assetSymbol, // Use symbol instead of UUID
              asset_type: asset.asset_type || 'crypto',
            });

            // Store explanation
            explanation = await this.prisma.signal_explanations.create({
              data: {
                signal_id: signal.signal_id,
                llm_model: llmResponse.data.model,
                text: llmResponse.data.explanation,
                explanation_status: 'generated',
                error_message: null,
                retry_count: 0,
              },
            });
          } else {
            this.logger.warn(
              `Skipping LLM explanation for signal ${signal.signal_id}: no action`,
            );
            explanation = await this.prisma.signal_explanations.create({
              data: {
                signal_id: signal.signal_id,
                explanation_status: 'skipped',
                error_message: 'No action in signal',
                text: 'Unable to generate explanation: signal has no action.',
                retry_count: 0,
              },
            });
          }
        } catch (error: any) {
          this.logger.error(
            `Failed to generate LLM explanation for signal ${signal.signal_id}: ${error.message}`,
          );
          // Create failed explanation record
          explanation = await this.prisma.signal_explanations.create({
            data: {
              signal_id: signal.signal_id,
              explanation_status: 'failed',
              error_message: error.message,
              text: 'Unable to generate explanation.',
              retry_count: 0,
            },
          });
        }
      }

      // Return signal WITH explanation
      return {
        ...signal,
        explanation: explanation ? {
          text: explanation.text,
          llm_model: explanation.llm_model,
          explanation_status: explanation.explanation_status,
        } : null,
      };
    } catch (error: any) {
      this.logger.error(`❌ Error executing strategy ${strategyId} on asset ${assetId}:`);
      this.logger.error(`   Asset Symbol: ${asset?.symbol || 'unknown'}`);
      this.logger.error(`   Error Message: ${error.message}`);
      this.logger.error(`   Error Type: ${error.constructor.name}`);
      if (error.response) {
        this.logger.error(`   HTTP Status: ${error.response.status}`);
        this.logger.error(`   Response Data: ${JSON.stringify(error.response.data)}`);
      }
      if (error.stack) {
        this.logger.error(`   Stack Trace: ${error.stack.split('\n').slice(0, 3).join('\n')}`);
      }
      throw error;
    }
  }

  /**
   * Execute strategy on multiple assets with parallel processing
   * Only generates LLM explanations for top 5 signals (by final_score or confidence)
   * to avoid hitting Gemini free tier rate limits
   */
  async executeStrategyOnAssets(
    strategyId: string,
    assetIds: string[],
  ): Promise<any[]> {
    const LLM_LIMIT = 5; // Only generate LLM for top 5 signals
    const CONCURRENCY_LIMIT = 3; // Process 3 assets in parallel to speed up

    this.logger.log(
      `Executing strategy ${strategyId} on ${assetIds.length} assets (concurrency: ${CONCURRENCY_LIMIT})`,
    );

    // Step 1: Generate all signals without LLM - in parallel with concurrency limit
    const results: any[] = [];
    
    // Process in batches for controlled parallelism
    for (let i = 0; i < assetIds.length; i += CONCURRENCY_LIMIT) {
      const batch = assetIds.slice(i, i + CONCURRENCY_LIMIT);
      this.logger.log(`Processing batch ${Math.floor(i / CONCURRENCY_LIMIT) + 1}/${Math.ceil(assetIds.length / CONCURRENCY_LIMIT)}: ${batch.length} assets`);
      
      const batchPromises = batch.map(async (assetId) => {
        try {
          const result = await this.executeStrategy(strategyId, assetId, false);
          return result;
        } catch (error: any) {
          this.logger.warn(
            `Error executing strategy ${strategyId} on asset ${assetId}: ${error.message}`,
          );
          return {
            asset_id: assetId,
            error: error.message,
          };
        }
      });
      
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }

    this.logger.log(
      `Generated ${results.length} signals (${results.filter((r) => r.signal_id).length} successful)`,
    );

    // Step 2: Identify top 5 signals for LLM generation
    // Sort by: action priority (BUY > SELL > HOLD), then by final_score, then by confidence
    // Include all signals even if final_score is null (use 0 as default)
    const signalsWithScores = results
      .filter((r) => r.signal_id && r.action) // Only signals with valid action
      .map((r) => {
        // Calculate sort score: prioritize action type, then scores
        const actionPriority = r.action === 'BUY' ? 3 : r.action === 'SELL' ? 2 : 1;
        const finalScore = r.final_score ?? 0;
        const confidence = r.confidence ?? 0;
        // Use sum of engine scores as fallback if final_score is null
        const engineScoreSum = 
          (Number(r.sentiment_score || 0) +
           Number(r.trend_score || 0) +
           Number(r.fundamental_score || 0) +
           Number(r.liquidity_score || 0) +
           Number(r.event_risk_score || 0)) / 5;
        const effectiveScore = finalScore !== null && finalScore !== undefined ? finalScore : engineScoreSum;
        const sortScore = actionPriority * 1000 + effectiveScore * 0.7 + confidence * 0.3;
        
        return {
          ...r,
          sortScore,
        };
      })
      .sort((a, b) => (b.sortScore || 0) - (a.sortScore || 0))
      .slice(0, LLM_LIMIT);

    this.logger.log(
      `Generating LLM explanations for top ${signalsWithScores.length} signals out of ${results.length} total`,
    );

    // Step 3: Generate LLM explanations for top signals
    for (const signal of signalsWithScores) {
      try {
        // Get asset info
        const asset = await this.prisma.assets.findUnique({
          where: { asset_id: signal.asset_id },
        });

        if (!asset) {
          this.logger.warn(`Asset ${signal.asset_id} not found for LLM generation`);
          continue;
        }

        // Use asset symbol instead of UUID
        const assetSymbol = asset.symbol || signal.asset_id;
        
        // Handle null values
        const finalScore = signal.final_score ?? 0;
        const confidence = signal.confidence ?? 0;

        // Construct engine_scores from individual score fields if not present
        let engineScores = signal.engine_scores;
        if (!engineScores || Object.keys(engineScores).length === 0) {
          engineScores = {
            sentiment: { score: Number(signal.sentiment_score || 0) },
            trend: { score: Number(signal.trend_score || 0) },
            fundamental: { score: Number(signal.fundamental_score || 0) },
            liquidity: { score: Number(signal.liquidity_score || 0) },
            event_risk: { score: Number(signal.event_risk_score || 0) },
          };
        }

        if (signal.action) {
          const llmResponse = await this.pythonApi.post('/api/v1/llm/explain-signal', {
            signal_data: {
              action: signal.action,
              final_score: finalScore,
              confidence: confidence,
            },
            engine_scores: engineScores,
            asset_id: assetSymbol, // Use symbol instead of UUID
            asset_type: asset.asset_type || 'crypto',
          });

          // Check if explanation already exists
          const existingExplanation = await this.prisma.signal_explanations.findFirst({
            where: { signal_id: signal.signal_id },
            orderBy: { created_at: 'desc' },
          });

          let explanation;
          if (existingExplanation) {
            // Update existing explanation
            explanation = await this.prisma.signal_explanations.update({
              where: { explanation_id: existingExplanation.explanation_id },
              data: {
                llm_model: llmResponse.data.model,
                text: llmResponse.data.explanation,
                explanation_status: 'generated',
                error_message: null,
              },
            });
          } else {
            // Create new explanation
            explanation = await this.prisma.signal_explanations.create({
              data: {
                signal_id: signal.signal_id,
                llm_model: llmResponse.data.model,
                text: llmResponse.data.explanation,
                explanation_status: 'generated',
                error_message: null,
                retry_count: 0,
              },
            });
          }

          // Update the result with explanation
          const resultIndex = results.findIndex((r) => r.signal_id === signal.signal_id);
          if (resultIndex !== -1) {
            results[resultIndex] = {
              ...results[resultIndex],
              explanation: {
                text: explanation.text,
                llm_model: explanation.llm_model,
                explanation_status: explanation.explanation_status,
              },
            };
          }
        }
      } catch (error: any) {
        this.logger.error(
          `Failed to generate LLM explanation for signal ${signal.signal_id}: ${error?.message || error}`,
        );

        // Safely create or update a failed explanation record without letting
        // database errors bubble up and abort the overall generate-signals flow.
        try {
          const existingExplanation = await this.prisma.signal_explanations.findFirst({
            where: { signal_id: signal.signal_id },
            orderBy: { created_at: 'desc' },
          });

          if (existingExplanation) {
            await this.prisma.signal_explanations.update({
              where: { explanation_id: existingExplanation.explanation_id },
              data: {
                explanation_status: 'failed',
                error_message: error?.message || String(error),
                text: 'Unable to generate explanation.',
              },
            });
          } else {
            await this.prisma.signal_explanations.create({
              data: {
                signal_id: signal.signal_id,
                explanation_status: 'failed',
                error_message: error?.message || String(error),
                text: 'Unable to generate explanation.',
                retry_count: 0,
              },
            });
          }
        } catch (dbError: any) {
          this.logger.error(
            `Failed to record failed explanation for signal ${signal.signal_id}: ${dbError?.message || dbError}`,
          );
        }
      }
    }

    return results;
  }

  /**
   * Get market data for asset
   * Supports both crypto (trending_assets) and stocks (market_rankings)
   */
  private async getMarketData(assetId: string, assetType: string | null): Promise<any> {
    // For stocks, check market_rankings first
    if (assetType === 'stock') {
      const marketRanking = await this.prisma.market_rankings.findFirst({
        where: {
          asset_id: assetId,
        },
        orderBy: {
          rank_timestamp: 'desc',
        },
      });

      if (marketRanking) {
        return {
          price: Number(marketRanking.price || 0),
          volume_24h: Number(marketRanking.volume_24h || 0),
          market_cap: Number(marketRanking.market_cap || 0),
          asset_type: 'stock',
        };
      }
    }

    // For crypto or fallback, check trending_assets
    const trendingAsset = await this.prisma.trending_assets.findFirst({
      where: {
        asset_id: assetId,
      },
      orderBy: {
        poll_timestamp: 'desc',
      },
    });

    return {
      price: trendingAsset ? Number(trendingAsset.price_usd || 0) : 0,
      volume_24h: trendingAsset ? Number(trendingAsset.market_volume || 0) : 0,
      asset_type: assetType || 'crypto',
    };
  }

  /**
   * Queue LLM explanation job (async)
   */
  private async queueLLMExplanation(
    signalId: string,
    signalData: any,
    assetId: string,
    assetType: string,
  ): Promise<void> {
    // Create pending explanation record
    await this.prisma.signal_explanations.create({
      data: {
        signal_id: signalId,
        explanation_status: 'pending',
        retry_count: 0,
      },
    });

    // Process explanation asynchronously (in real implementation, use job queue)
    // For now, process immediately
    this.processLLMExplanation(signalId, signalData, assetId, assetType).catch(
      (error) => {
        this.logger.error(
          `Error processing LLM explanation for signal ${signalId}: ${error.message}`,
        );
      },
    );
  }

  /**
   * Process LLM explanation
   */
  private async processLLMExplanation(
    signalId: string,
    signalData: any,
    assetId: string,
    assetType: string,
  ): Promise<void> {
    try {
      // Call Python LLM API
      const response = await this.pythonApi.post('/api/v1/llm/explain-signal', {
        signal_data: {
          action: signalData.action,
          final_score: signalData.final_score,
          confidence: signalData.confidence,
        },
        engine_scores: signalData.engine_scores || {},
        asset_id: assetId,
        asset_type: assetType,
      });

      // Update explanation record
      await this.prisma.signal_explanations.updateMany({
        where: {
          signal_id: signalId,
        },
        data: {
          llm_model: response.data.model,
          text: response.data.explanation,
          explanation_status: 'generated',
          error_message: null,
        },
      });
    } catch (error: any) {
      // Update with error
      const explanation = await this.prisma.signal_explanations.findFirst({
        where: {
          signal_id: signalId,
        },
      });

      if (explanation) {
        const retryCount = explanation.retry_count + 1;
        const maxRetries = 3;

        if (retryCount < maxRetries) {
          // Retry
          await this.prisma.signal_explanations.updateMany({
            where: {
              signal_id: signalId,
            },
            data: {
              explanation_status: 'pending',
              retry_count: retryCount,
              error_message: error.message,
            },
          });

          // Retry after delay
          setTimeout(() => {
            this.processLLMExplanation(signalId, signalData, assetId, assetType);
          }, 2000 * retryCount); // Exponential backoff
        } else {
          // Max retries reached, mark as failed
          await this.prisma.signal_explanations.updateMany({
            where: {
              signal_id: signalId,
            },
            data: {
              explanation_status: 'failed',
              error_message: error.message,
              text: 'Unable to generate explanation. Please try again later.',
            },
          });
        }
      }
    }
  }
}

