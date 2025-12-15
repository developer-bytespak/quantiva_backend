import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ILLMAdapter } from '../interfaces/stream.interface';
import axios from 'axios';

@Injectable()
export class LLMService implements ILLMAdapter {
  private readonly logger = new Logger(LLMService.name);
  private readonly provider: string;
  private readonly config: any;

  constructor(private readonly configService: ConfigService) {
    this.provider = this.configService.get<string>('stream.llm.provider');
    this.config = this.configService.get(`stream.llm.${this.provider}`);
  }

  async chat(
    prompt: string,
    context?: any,
    options?: any,
  ): Promise<{ content: string; metadata?: any }> {
    try {
      switch (this.provider) {
        case 'python':
          return await this.chatPython(prompt, context, options);
        case 'openai':
          return await this.chatOpenAI(prompt, context, options);
        case 'anthropic':
          return await this.chatAnthropic(prompt, context, options);
        default:
          throw new Error(`Unsupported LLM provider: ${this.provider}`);
      }
    } catch (error) {
      this.logger.error(`LLM chat failed: ${error.message}`, error.stack);
      throw error;
    }
  }

  private async chatOpenAI(
    prompt: string,
    context?: any,
    options?: any,
  ): Promise<{ content: string; metadata?: any }> {
    const systemPrompt = this.buildSystemPrompt(context);

    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: this.config.model || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        max_tokens: this.config.maxTokens || 500,
        temperature: this.config.temperature || 0.7,
        stream: false,
      },
      {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
      },
    );

    return {
      content: response.data.choices[0].message.content,
      metadata: {
        usage: response.data.usage,
        model: response.data.model,
      },
    };
  }

  private async chatAnthropic(
    prompt: string,
    context?: any,
    options?: any,
  ): Promise<{ content: string; metadata?: any }> {
    const systemPrompt = this.buildSystemPrompt(context);

    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: this.config.model || 'claude-3-sonnet-20240229',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }],
      },
      {
        headers: {
          'x-api-key': this.config.apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
      },
    );

    return {
      content: response.data.content[0].text,
      metadata: {
        usage: response.data.usage,
        model: response.data.model,
      },
    };
  }

  async *chatStream(
    prompt: string,
    context?: any,
    options?: any,
  ): AsyncIterable<{ content: string; done: boolean; metadata?: any }> {
    const systemPrompt = this.buildSystemPrompt(context);

    if (this.provider === 'openai') {
      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: this.config.model || 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
          ],
          max_tokens: this.config.maxTokens || 500,
          temperature: this.config.temperature || 0.7,
          stream: true,
        },
        {
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
          },
          responseType: 'stream',
        },
      );

      for await (const chunk of response.data) {
        const lines = chunk.toString().split('\n').filter((line) => line.trim());
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              yield { content: '', done: true };
              return;
            }
            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices?.[0]?.delta?.content || '';
              if (content) {
                yield { content, done: false };
              }
            } catch (e) {
              // Skip invalid JSON
            }
          }
        }
      }
    } else {
      // Fallback to non-streaming
      const result = await this.chat(prompt, context, options);
      yield { content: result.content, done: true, metadata: result.metadata };
    }
  }

  private async chatPython(
    prompt: string,
    context?: any,
    options?: any,
  ): Promise<{ content: string; metadata?: any }> {
    try {
      // Proxy to local Python FastAPI LLM chat endpoint
      const pythonUrl = this.configService.get<string>('stream.llm.pythonUrl') || 'http://127.0.0.1:8000/api/v1/llm/chat';
      const resp = await axios.post(
        pythonUrl,
        { prompt, context },
        { headers: { 'Content-Type': 'application/json' } },
      );

      return { content: resp.data.content || '', metadata: { model: resp.data.model } };
    } catch (err) {
      this.logger.error('Python LLM proxy failed: ' + err.message);
      throw err;
    }
  }

  private buildSystemPrompt(context?: any): string {
    const basePrompt = `You are a helpful crypto market assistant. You provide clear, concise, and accurate information about cryptocurrency markets.

**IMPORTANT GUIDELINES:**
1. Keep responses conversational and under 100 words when possible
2. Use simple language - avoid jargon unless asked
3. Always emphasize risks and volatility in crypto markets
4. Never provide financial advice or recommend specific trades
5. Focus on education and market context
6. If you don't know something, say so clearly
7. Format numbers clearly (e.g., "$50,000" not "50000")
8. When discussing price movements, include percentage changes`;

    if (!context) {
      return basePrompt;
    }

    let enrichedPrompt = basePrompt + '\n\n**CURRENT MARKET CONTEXT:**';

    if (context.prices) {
      enrichedPrompt += '\n\nRecent Prices:\n';
      for (const [symbol, data] of Object.entries(context.prices)) {
        const priceData: any = data;
        enrichedPrompt += `- ${symbol}: $${priceData.price?.toLocaleString() || 'N/A'}`;
        if (priceData.change24h) {
          enrichedPrompt += ` (${priceData.change24h > 0 ? '+' : ''}${priceData.change24h.toFixed(2)}%)`;
        }
        enrichedPrompt += '\n';
      }
    }

    if (context.news && context.news.length > 0) {
      enrichedPrompt += '\n\nRecent News Headlines:\n';
      context.news.slice(0, 3).forEach((item: any, idx: number) => {
        enrichedPrompt += `${idx + 1}. ${item.title}\n`;
      });
    }

    if (context.sentiment) {
      enrichedPrompt += `\n\nMarket Sentiment: ${context.sentiment.overall || 'Neutral'}`;
      if (context.sentiment.score) {
        enrichedPrompt += ` (Score: ${context.sentiment.score}/100)`;
      }
    }

    return enrichedPrompt;
  }
}
