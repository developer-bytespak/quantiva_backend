import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  IStreamSession,
  IAudioChunk,
  ISTTFinalMessage,
} from '../interfaces/stream.interface';
import { STTAdapter } from '../adapters/stt.adapter';
import { TTSAdapter } from '../adapters/tts.adapter';
import { LLMService } from './llm.service';
import { ContextService } from './context.service';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class StreamService {
  private readonly logger = new Logger(StreamService.name);
  private readonly sessions = new Map<string, IStreamSession>();
  private readonly maxConcurrentStreams: number;
  private readonly sessionTimeout: number;
  private readonly bufferSize: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly sttAdapter: STTAdapter,
    private readonly ttsAdapter: TTSAdapter,
    private readonly llmService: LLMService,
    private readonly contextService: ContextService,
  ) {
    this.maxConcurrentStreams = this.configService.get<number>(
      'stream.session.maxConcurrentStreams',
      5,
    );
    this.sessionTimeout = this.configService.get<number>(
      'stream.session.sessionTimeout',
      300000,
    );
    this.bufferSize = this.configService.get<number>(
      'stream.session.bufferSize',
      10,
    );

    // Cleanup inactive sessions periodically
    setInterval(() => this.cleanupSessions(), 60000); // Every minute
  }

  createSession(
    userId: string,
    clientId: string,
    socketId: string,
    metadata?: any,
  ): IStreamSession {
    const sessionId = uuidv4();

    // Check concurrent stream limit
    const userSessions = Array.from(this.sessions.values()).filter(
      (s) => s.userId === userId,
    );

    if (userSessions.length >= this.maxConcurrentStreams) {
      throw new Error(
        `Maximum concurrent streams (${this.maxConcurrentStreams}) exceeded`,
      );
    }

    const session: IStreamSession = {
      sessionId,
      userId,
      clientId,
      socketId,
      createdAt: new Date(),
      lastActivity: new Date(),
      audioBuffer: [],
      currentTranscript: '',
      metadata: metadata || {},
    };

    this.sessions.set(sessionId, session);
    this.logger.log(
      `Session created: ${sessionId} for user ${userId} (socket: ${socketId})`,
    );

    return session;
  }

  getSession(sessionId: string): IStreamSession | undefined {
    return this.sessions.get(sessionId);
  }

  updateSessionActivity(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivity = new Date();
    }
  }

  destroySession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.logger.log(`Session destroyed: ${sessionId}`);
      this.sessions.delete(sessionId);
    }
  }

  async processAudioChunk(
    sessionId: string,
    chunk: IAudioChunk,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Update activity
    session.lastActivity = new Date();

    // Add to buffer
    session.audioBuffer.push(chunk.payload);

    // Keep buffer size limited
    if (session.audioBuffer.length > this.bufferSize) {
      session.audioBuffer.shift();
    }

    this.logger.debug(
      `Audio chunk received for session ${sessionId}: seq=${chunk.seq}, size=${chunk.payload.length}`,
    );
  }

  async transcribeAudio(
    sessionId: string,
  ): Promise<{ text: string; confidence?: number }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (session.audioBuffer.length === 0) {
      return { text: '', confidence: 0 };
    }

    try {
      // Combine all buffered audio chunks
      const combinedAudio = Buffer.concat(session.audioBuffer);

      // Transcribe using STT adapter
      const result = await this.sttAdapter.transcribe(combinedAudio);

      // Update session transcript
      session.currentTranscript = result.text;

      // Clear audio buffer after transcription
      session.audioBuffer = [];

      this.logger.log(
        `Transcription completed for session ${sessionId}: "${result.text}"`,
      );

      return result;
    } catch (error) {
      this.logger.error(
        `Transcription failed for session ${sessionId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  async processQuery(
    sessionId: string,
    transcript: string,
  ): Promise<AsyncIterable<{ content: string; done: boolean }>> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    try {
      // Enrich with crypto context
      const context = await this.contextService.enrichContext(
        transcript,
        session.userId,
      );

      this.logger.log(
        `Processing query for session ${sessionId}: "${transcript}"`,
      );

      // Stream response from LLM
      return this.llmService.chatStream(transcript, context);
    } catch (error) {
      this.logger.error(
        `Query processing failed for session ${sessionId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  async synthesizeSpeech(
    text: string,
  ): Promise<AsyncIterable<{ audio: Buffer; format: string }>> {
    try {
      return this.ttsAdapter.synthesizeStream(text);
    } catch (error) {
      this.logger.error(`TTS synthesis failed: ${error.message}`, error.stack);
      throw error;
    }
  }

  private cleanupSessions(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [sessionId, session] of this.sessions.entries()) {
      const inactiveDuration = now - session.lastActivity.getTime();

      if (inactiveDuration > this.sessionTimeout) {
        this.sessions.delete(sessionId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.log(`Cleaned up ${cleaned} inactive sessions`);
    }
  }

  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  getUserSessions(userId: string): IStreamSession[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.userId === userId,
    );
  }
}
