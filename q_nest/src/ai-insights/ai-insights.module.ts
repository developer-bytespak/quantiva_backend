import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiInsightsService } from './ai-insights.service';
import { OpenAIProvider } from './providers/openai.provider';
import { GeminiProvider } from './providers/gemini.provider';

@Module({
  imports: [ConfigModule],
  providers: [AiInsightsService, OpenAIProvider, GeminiProvider],
  exports: [AiInsightsService],
})
export class AiInsightsModule {}
