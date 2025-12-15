import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ITTSAdapter } from '../interfaces/stream.interface';
import axios from 'axios';

@Injectable()
export class TTSAdapter implements ITTSAdapter {
  private readonly logger = new Logger(TTSAdapter.name);
  private readonly provider: string;
  private readonly config: any;

  constructor(private readonly configService: ConfigService) {
    this.provider = this.configService.get<string>('stream.tts.provider');
    this.config = this.configService.get(`stream.tts.${this.provider}`);
  }

  async synthesize(
    text: string,
    options?: any,
  ): Promise<{ audio: Buffer; format: string }> {
    try {
      switch (this.provider) {
        case 'openai':
          return await this.synthesizeOpenAI(text, options);
        case 'elevenlabs':
          return await this.synthesizeElevenLabs(text, options);
        case 'aws-polly':
          return await this.synthesizeAWSPolly(text, options);
        default:
          throw new Error(`Unsupported TTS provider: ${this.provider}`);
      }
    } catch (error) {
      this.logger.error(`TTS synthesis failed: ${error.message}`, error.stack);
      throw error;
    }
  }

  private async synthesizeOpenAI(
    text: string,
    options?: any,
  ): Promise<{ audio: Buffer; format: string }> {
    const response = await axios.post(
      'https://api.openai.com/v1/audio/speech',
      {
        model: this.config.model || 'tts-1',
        voice: this.config.voice || 'alloy',
        input: text,
        response_format: 'mp3',
      },
      {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        responseType: 'arraybuffer',
      },
    );

    return {
      audio: Buffer.from(response.data),
      format: 'mp3',
    };
  }

  private async synthesizeElevenLabs(
    text: string,
    options?: any,
  ): Promise<{ audio: Buffer; format: string }> {
    const response = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${this.config.voiceId}`,
      {
        text,
        model_id: 'eleven_monolingual_v1',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.5,
        },
      },
      {
        headers: {
          'xi-api-key': this.config.apiKey,
          'Content-Type': 'application/json',
        },
        responseType: 'arraybuffer',
      },
    );

    return {
      audio: Buffer.from(response.data),
      format: 'mp3',
    };
  }

  private async synthesizeAWSPolly(
    text: string,
    options?: any,
  ): Promise<{ audio: Buffer; format: string }> {
    // Note: This requires AWS SDK, which should be installed separately
    // For now, throwing error with installation instructions
    throw new Error(
      'AWS Polly requires @aws-sdk/client-polly to be installed. Run: npm install @aws-sdk/client-polly',
    );
  }

  async *synthesizeStream(
    text: string,
    options?: any,
  ): AsyncIterable<{ audio: Buffer; format: string }> {
    // For MVP, we'll synthesize the entire text and yield it in chunks
    // Production implementation should use streaming APIs where available
    const result = await this.synthesize(text, options);
    
    // Split audio into chunks for streaming (8KB chunks)
    const chunkSize = 8192;
    for (let i = 0; i < result.audio.length; i += chunkSize) {
      yield {
        audio: result.audio.slice(i, i + chunkSize),
        format: result.format,
      };
    }
  }
}
