import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { PythonApiService } from '../../../kyc/integrations/python-api.service';
import { SignalsService } from '../../signals/signals.service';
import { SignalAction } from '@prisma/client';

@Injectable()
export class StrategyExecutionService {
  private readonly logger = new Logger(StrategyExecutionService.name);

  constructor(
    private prisma: PrismaService,
    private pythonApi: PythonApiService,
    private signalsService: SignalsService,
  ) {}

  /**
   * Execute strategy on an asset
   */
  async executeStrategy(strategyId: string, assetId: string): Promise<any> {
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

    // Prepare strategy data
    const strategyData = {
      user_id: strategy.user_id,
      entry_rules: strategy.entry_rules,
      exit_rules: strategy.exit_rules,
      indicators: strategy.indicators,
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
      const pythonSignal = await this.pythonApi.generateSignal(
        strategyId,
        assetId,
        {
          strategy_data: strategyData,
          market_data: marketData,
        },
      );

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

      // Queue LLM explanation job (async, don't wait)
      this.queueLLMExplanation(signal.signal_id, pythonSignal, assetId, asset.asset_type).catch(
        (error) => {
          this.logger.error(
            `Failed to queue LLM explanation for signal ${signal.signal_id}: ${error.message}`,
          );
        },
      );

      return signal;
    } catch (error: any) {
      this.logger.error(
        `Error executing strategy ${strategyId} on asset ${assetId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Get market data for asset
   */
  private async getMarketData(assetId: string, assetType: string | null): Promise<any> {
    // Get latest trending asset data
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

