import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ISTTAdapter } from '../interfaces/stream.interface';
import axios from 'axios';
import FormData from 'form-data';

@Injectable()
export class STTAdapter implements ISTTAdapter {
  private readonly logger = new Logger(STTAdapter.name);
  private readonly provider: string;
  private readonly config: any;

  constructor(private readonly configService: ConfigService) {
    this.provider = this.configService.get<string>('stream.stt.provider');
    this.config = this.configService.get(`stream.stt.${this.provider}`);
  }

  async transcribe(
    audioBuffer: Buffer,
    options?: any,
  ): Promise<{ text: string; confidence?: number }> {
    try {
      switch (this.provider) {
        case 'openai':
          return await this.transcribeOpenAI(audioBuffer, options);
        case 'deepgram':
          return await this.transcribeDeepgram(audioBuffer, options);
        case 'assemblyai':
          return await this.transcribeAssemblyAI(audioBuffer, options);
        default:
          throw new Error(`Unsupported STT provider: ${this.provider}`);
      }
    } catch (error) {
      this.logger.error(`STT transcription failed: ${error.message}`, error.stack);
      throw error;
    }
  }

  private async transcribeOpenAI(
    audioBuffer: Buffer,
    options?: any,
  ): Promise<{ text: string; confidence?: number }> {
    const formData = new FormData();
    formData.append('file', audioBuffer, {
      filename: 'audio.webm',
      contentType: 'audio/webm',
    });
    formData.append('model', this.config.model || 'whisper-1');
    formData.append('language', options?.language || 'en');

    const response = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      formData,
      {
        headers: {
          ...formData.getHeaders(),
          Authorization: `Bearer ${this.config.apiKey}`,
        },
      },
    );

    return {
      text: response.data.text,
      confidence: 1.0, // OpenAI doesn't provide confidence scores
    };
  }

  private async transcribeDeepgram(
    audioBuffer: Buffer,
    options?: any,
  ): Promise<{ text: string; confidence?: number }> {
    const response = await axios.post(
      `https://api.deepgram.com/v1/listen?model=${this.config.model || 'nova-2'}&smart_format=true`,
      audioBuffer,
      {
        headers: {
          Authorization: `Token ${this.config.apiKey}`,
          'Content-Type': 'audio/webm',
        },
      },
    );

    const transcript = response.data.results?.channels?.[0]?.alternatives?.[0];
    return {
      text: transcript?.transcript || '',
      confidence: transcript?.confidence || 0,
    };
  }

  private async transcribeAssemblyAI(
    audioBuffer: Buffer,
    options?: any,
  ): Promise<{ text: string; confidence?: number }> {
    // AssemblyAI requires uploading file first, then requesting transcription
    // For simplicity, using synchronous approach with base64
    const base64Audio = audioBuffer.toString('base64');
    
    const response = await axios.post(
      'https://api.assemblyai.com/v2/transcript',
      {
        audio_data: base64Audio,
      },
      {
        headers: {
          Authorization: this.config.apiKey,
          'Content-Type': 'application/json',
        },
      },
    );

    const transcriptId = response.data.id;

    // Poll for completion
    let result;
    let attempts = 0;
    while (attempts < 30) {
      const statusResponse = await axios.get(
        `https://api.assemblyai.com/v2/transcript/${transcriptId}`,
        {
          headers: {
            Authorization: this.config.apiKey,
          },
        },
      );

      if (statusResponse.data.status === 'completed') {
        result = statusResponse.data;
        break;
      } else if (statusResponse.data.status === 'error') {
        throw new Error('AssemblyAI transcription failed');
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
      attempts++;
    }

    return {
      text: result?.text || '',
      confidence: result?.confidence || 0,
    };
  }

  async *transcribeStream(
    audioChunks: AsyncIterable<Buffer>,
    options?: any,
  ): AsyncIterable<{ text: string; isFinal: boolean; confidence?: number }> {
    // For MVP, we'll accumulate chunks and transcribe periodically
    // Production implementation should use streaming APIs where available
    const chunks: Buffer[] = [];
    
    for await (const chunk of audioChunks) {
      chunks.push(chunk);
      
      // Transcribe every N chunks or when we detect silence
      if (chunks.length >= 10) {
        const combined = Buffer.concat(chunks);
        const result = await this.transcribe(combined, options);
        
        yield {
          text: result.text,
          isFinal: false,
          confidence: result.confidence,
        };
        
        chunks.length = 0; // Clear buffer
      }
    }
    
    // Final transcription
    if (chunks.length > 0) {
      const combined = Buffer.concat(chunks);
      const result = await this.transcribe(combined, options);
      
      yield {
        text: result.text,
        isFinal: true,
        confidence: result.confidence,
      };
    }
  }
}
