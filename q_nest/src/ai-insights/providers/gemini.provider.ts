import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import {
  AIProvider,
  AIGenerationRequest,
  AIGenerationResponse,
} from '../interfaces/ai-provider.interface';

/**
 * Gemini Provider
 * Fallback AI provider using Google's Gemini (free tier)
 */
@Injectable()
export class GeminiProvider implements AIProvider {
  readonly name = 'gemini' as const;
  private readonly logger = new Logger(GeminiProvider.name);
  private client: GoogleGenerativeAI | null = null;
  private readonly model = 'gemini-1.5-flash'; // Fast, free model

  constructor(private configService: ConfigService) {
    this.initializeClient();
  }

  private initializeClient(): void {
    const apiKey = this.configService.get<string>('GEMINI_API_KEY');
    if (apiKey) {
      try {
        this.client = new GoogleGenerativeAI(apiKey);
        this.logger.log('Gemini client initialized successfully');
      } catch (error) {
        this.logger.error('Failed to initialize Gemini client', error);
        this.client = null;
      }
    } else {
      this.logger.warn('GEMINI_API_KEY not configured');
    }
  }

  isAvailable(): boolean {
    return this.client !== null;
  }

  async generate(request: AIGenerationRequest): Promise<AIGenerationResponse> {
    if (!this.client) {
      throw new Error('Gemini client not initialized');
    }

    const startTime = Date.now();

    try {
      const model = this.client.getGenerativeModel({ model: this.model });

      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
        generationConfig: {
          maxOutputTokens: request.maxTokens,
          temperature: request.temperature ?? 0.7,
        },
      });

      const latencyMs = Date.now() - startTime;
      const content = result.response.text();

      if (!content) {
        throw new Error('Gemini returned empty content');
      }

      return {
        content,
        provider: this.name,
        latencyMs,
        // Gemini doesn't provide token usage in free tier
      };
    } catch (error: any) {
      const latencyMs = Date.now() - startTime;
      this.logger.error(
        `Gemini generation failed after ${latencyMs}ms: ${error.message}`,
      );
      throw error;
    }
  }
}
