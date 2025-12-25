import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import {
  AIProvider,
  AIGenerationRequest,
  AIGenerationResponse,
} from '../interfaces/ai-provider.interface';

/**
 * OpenAI Provider
 * Primary AI provider using gpt-4o-mini model
 */
@Injectable()
export class OpenAIProvider implements AIProvider {
  readonly name = 'openai' as const;
  private readonly logger = new Logger(OpenAIProvider.name);
  private client: OpenAI | null = null;
  private readonly model = 'gpt-4o-mini'; // Cost-effective model

  constructor(private configService: ConfigService) {
    this.initializeClient();
  }

  private initializeClient(): void {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    if (apiKey) {
      try {
        this.client = new OpenAI({ apiKey });
        this.logger.log('OpenAI client initialized successfully');
      } catch (error) {
        this.logger.error('Failed to initialize OpenAI client', error);
        this.client = null;
      }
    } else {
      this.logger.warn('OPENAI_API_KEY not configured');
    }
  }

  isAvailable(): boolean {
    return this.client !== null;
  }

  async generate(request: AIGenerationRequest): Promise<AIGenerationResponse> {
    if (!this.client) {
      throw new Error('OpenAI client not initialized');
    }

    const startTime = Date.now();

    try {
      const completion = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: 'user',
            content: request.prompt,
          },
        ],
        max_tokens: request.maxTokens,
        temperature: request.temperature ?? 0.7,
      });

      const latencyMs = Date.now() - startTime;
      const content = completion.choices[0]?.message?.content || '';

      if (!content) {
        throw new Error('OpenAI returned empty content');
      }

      return {
        content,
        provider: this.name,
        tokensUsed: completion.usage?.total_tokens,
        latencyMs,
      };
    } catch (error: any) {
      const latencyMs = Date.now() - startTime;
      this.logger.error(
        `OpenAI generation failed after ${latencyMs}ms: ${error.message}`,
      );
      throw error;
    }
  }
}
