/**
 * AI Provider Interface
 * Defines the contract for AI providers (OpenAI, Gemini, etc.)
 */

export type AIProviderName = 'openai' | 'gemini';

export interface AIGenerationRequest {
  prompt: string;
  maxTokens: number;
  temperature?: number;
}

export interface AIGenerationResponse {
  content: string;
  provider: AIProviderName;
  tokensUsed?: number;
  latencyMs: number;
}

export interface AIProvider {
  readonly name: AIProviderName;
  
  /**
   * Generate AI content based on prompt
   * @throws Error if generation fails
   */
  generate(request: AIGenerationRequest): Promise<AIGenerationResponse>;
  
  /**
   * Check if provider is available (API key configured, etc.)
   */
  isAvailable(): boolean;
}

export interface CircuitBreakerState {
  isOpen: boolean;
  failureCount: number;
  lastFailureTime: number;
  nextRetryTime: number;
}
