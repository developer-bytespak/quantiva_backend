import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { PythonApiService } from '../../../kyc/integrations/python-api.service';

@Injectable()
export class LLMExplanationProcessorService {
  private readonly logger = new Logger(LLMExplanationProcessorService.name);

  constructor(
    private prisma: PrismaService,
    private pythonApi: PythonApiService,
  ) {}

  /**
   * Generate explanation for a signal
   */
  async generateExplanation(signalId: string): Promise<void> {
    // Get signal
    const signal = await this.prisma.strategy_signals.findUnique({
      where: {
        signal_id: signalId,
      },
      include: {
        asset: true,
      },
    });

    if (!signal) {
      throw new Error(`Signal ${signalId} not found`);
    }

    // Get or create explanation record
    let explanation = await this.prisma.signal_explanations.findFirst({
      where: {
        signal_id: signalId,
      },
    });

    if (!explanation) {
      explanation = await this.prisma.signal_explanations.create({
        data: {
          signal_id: signalId,
          explanation_status: 'pending',
          retry_count: 0,
        },
      });
    }

    // Check retry count
    if (explanation.retry_count >= 3) {
      this.logger.warn(
        `Max retries reached for signal ${signalId}, skipping explanation`,
      );
      return;
    }

    try {
      // Prepare signal data
      const signalData = {
        action: signal.action,
        final_score: signal.final_score,
        confidence: signal.confidence,
      };

      // Prepare engine scores from signal
      const engineScores: any = {};
      if (signal.engine_metadata) {
        const metadata = signal.engine_metadata as any;
        engineScores.sentiment = {
          score: signal.sentiment_score,
          metadata: metadata.sentiment || {},
        };
        engineScores.trend = {
          score: signal.trend_score,
          metadata: metadata.trend || {},
        };
        engineScores.fundamental = {
          score: signal.fundamental_score,
          metadata: metadata.fundamental || {},
        };
        engineScores.liquidity = {
          score: signal.liquidity_score,
          metadata: metadata.liquidity || {},
        };
        engineScores.event_risk = {
          score: signal.event_risk_score,
          metadata: metadata.event_risk || {},
        };
      }

      // Call Python LLM API
      const response = await this.pythonApi.post('/api/v1/llm/explain-signal', {
        signal_data: signalData,
        engine_scores: engineScores,
        asset_id: signal.asset?.symbol || signal.asset_id,
        asset_type: signal.asset?.asset_type || 'crypto',
      });

      // Update explanation record
      await this.prisma.signal_explanations.update({
        where: {
          explanation_id: explanation.explanation_id,
        },
        data: {
          llm_model: response.data.model,
          text: response.data.explanation,
          explanation_status: 'generated',
          error_message: null,
          retry_count: 0,
        },
      });

      this.logger.log(
        `Generated explanation for signal ${signalId} using ${response.data.model}`,
      );
    } catch (error: any) {
      // Update with error and increment retry count
      const retryCount = explanation.retry_count + 1;

      await this.prisma.signal_explanations.update({
        where: {
          explanation_id: explanation.explanation_id,
        },
        data: {
          explanation_status: retryCount >= 3 ? 'failed' : 'pending',
          error_message: error.message,
          retry_count: retryCount,
          text:
            retryCount >= 3
              ? 'Unable to generate explanation. Please try again later.'
              : null,
        },
      });

      if (retryCount >= 3) {
        this.logger.error(
          `Failed to generate explanation for signal ${signalId} after ${retryCount} attempts: ${error.message}`,
        );
      } else {
        this.logger.warn(
          `Error generating explanation for signal ${signalId} (attempt ${retryCount}/3): ${error.message}`,
        );
      }

      throw error;
    }
  }
}

