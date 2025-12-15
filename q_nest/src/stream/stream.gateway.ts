import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger, UseGuards } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { StreamService } from './services/stream.service';
import { WsJwtGuard } from './guards/ws-jwt.guard';
import { WsRateLimitGuard } from './guards/ws-rate-limit.guard';
import {
  IConnectMessage,
  IConnectedMessage,
  IAudioChunk,
  ISTTPartialMessage,
  ISTTFinalMessage,
  ILLMPartialMessage,
  ILLMFinalMessage,
  IErrorMessage,
} from './interfaces/stream.interface';
import { ConfigService } from '@nestjs/config';

@WebSocketGateway({
  cors: {
    origin: true,
    credentials: true,
  },
  namespace: '/voice',
  transports: ['websocket', 'polling'],
})
export class StreamGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(StreamGateway.name);

  constructor(
    private readonly streamService: StreamService,
    private readonly configService: ConfigService,
  ) {}

  afterInit(server: Server) {
    this.logger.log('WebSocket Gateway initialized on namespace: /voice');
  }

  async handleConnection(client: Socket) {
    this.logger.log(`Client attempting connection: ${client.id}`);
    
    // Note: Authentication is handled in @UseGuards decorator on individual handlers
    // Connection is allowed, but auth is required for sending messages
  }

  async handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);

    // Clean up any active sessions for this socket
    try {
      const sessionId = client.data.sessionId;
      if (sessionId) {
        this.streamService.destroySession(sessionId);
      }
    } catch (error) {
      this.logger.error(`Error cleaning up session: ${error.message}`);
    }
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('connect_session')
  async handleConnect(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: IConnectMessage,
  ): Promise<IConnectedMessage | IErrorMessage> {
    try {
      const userId = client.data.userId;
      const clientId = data.clientId || client.id;

      // Create a new session
      const session = this.streamService.createSession(
        userId,
        clientId,
        client.id,
        data.metadata,
      );

      // Store session ID in client data
      client.data.sessionId = session.sessionId;

      const response: IConnectedMessage = {
        type: 'connected',
        sessionId: session.sessionId,
        serverTime: new Date().toISOString(),
        allowedActions: {
          maxStreams: this.configService.get<number>(
            'stream.session.maxConcurrentStreams',
            5,
          ),
          chunkSizeBytes: this.configService.get<number>(
            'stream.session.maxAudioChunkSize',
            65536,
          ),
          sttModel: this.configService.get<string>('stream.stt.provider', 'openai'),
        },
      };

      this.logger.log(
        `Session connected: ${session.sessionId} for user ${userId}`,
      );

      return response;
    } catch (error) {
      this.logger.error(`Connection failed: ${error.message}`, error.stack);
      return {
        type: 'error',
        code: 'CONNECTION_FAILED',
        message: error.message,
      };
    }
  }

  @UseGuards(WsJwtGuard, WsRateLimitGuard)
  @SubscribeMessage('audio_chunk')
  async handleAudioChunk(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: any,
  ): Promise<void> {
    try {
      const sessionId = client.data.sessionId;
      if (!sessionId) {
        this.emitError(client, 'NO_SESSION', 'No active session found');
        return;
      }

      // Parse binary audio data
      const chunk: IAudioChunk = {
        sessionId: data.sessionId || sessionId,
        seq: data.seq,
        timestamp: data.timestamp || Date.now(),
        eou: data.eou || false,
        payload: Buffer.from(data.payload),
      };

      // Process the audio chunk
      await this.streamService.processAudioChunk(sessionId, chunk);

      // If end-of-utterance, trigger transcription
      if (chunk.eou) {
        await this.handleTranscription(client, sessionId);
      }
    } catch (error) {
      this.logger.error(`Audio chunk processing failed: ${error.message}`);
      this.emitError(client, 'AUDIO_PROCESSING_FAILED', error.message);
    }
  }

  @UseGuards(WsJwtGuard, WsRateLimitGuard)
  @SubscribeMessage('transcribe')
  async handleTranscribeRequest(
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    try {
      const sessionId = client.data.sessionId;
      if (!sessionId) {
        this.emitError(client, 'NO_SESSION', 'No active session found');
        return;
      }

      await this.handleTranscription(client, sessionId);
    } catch (error) {
      this.logger.error(`Transcription request failed: ${error.message}`);
      this.emitError(client, 'TRANSCRIPTION_FAILED', error.message);
    }
  }

  private async handleTranscription(
    client: Socket,
    sessionId: string,
  ): Promise<void> {
    try {
      // Transcribe accumulated audio
      const result = await this.streamService.transcribeAudio(sessionId);

      if (!result.text || result.text.trim().length === 0) {
        this.logger.warn(`Empty transcription for session ${sessionId}`);
        return;
      }

      // Send final transcription
      const finalMessage: ISTTFinalMessage = {
        type: 'stt_final',
        sessionId,
        transcriptId: `transcript_${Date.now()}`,
        text: result.text,
        confidence: result.confidence,
      };

      client.emit('stt_final', finalMessage);

      // Automatically process the query
      await this.handleLLMQuery(client, sessionId, result.text);
    } catch (error) {
      this.logger.error(`Transcription failed: ${error.message}`);
      this.emitError(client, 'STT_ERROR', error.message);
    }
  }

  private async handleLLMQuery(
    client: Socket,
    sessionId: string,
    transcript: string,
  ): Promise<void> {
    try {
      const requestId = `llm_${Date.now()}`;
      let seq = 0;
      let fullResponse = '';

      // Stream LLM response
      const stream = await this.streamService.processQuery(
        sessionId,
        transcript,
      );

      for await (const chunk of stream) {
        if (chunk.done) {
          // Send final message
          const finalMessage: ILLMFinalMessage = {
            type: 'llm_final',
            requestId,
            content: fullResponse,
            metadata: {
              elapsedMs: Date.now() - parseInt(requestId.split('_')[1]),
            },
          };
          client.emit('llm_final', finalMessage);

          // Convert to speech and stream back
          await this.handleTTS(client, sessionId, fullResponse);
        } else {
          fullResponse += chunk.content;

          // Send partial update
          const partialMessage: ILLMPartialMessage = {
            type: 'llm_partial',
            requestId,
            content: chunk.content,
            seq: seq++,
          };
          client.emit('llm_partial', partialMessage);
        }
      }
    } catch (error) {
      this.logger.error(`LLM query failed: ${error.message}`);
      this.emitError(client, 'LLM_ERROR', error.message);
    }
  }

  private async handleTTS(
    client: Socket,
    sessionId: string,
    text: string,
  ): Promise<void> {
    try {
      let seq = 0;

      // Stream TTS audio back to client
      const audioStream = await this.streamService.synthesizeSpeech(text);

      for await (const chunk of audioStream) {
        client.emit('tts_chunk', {
          sessionId,
          seq: seq++,
          timestamp: Date.now(),
          payload: chunk.audio,
          format: chunk.format,
        });
      }

      // Send end marker
      client.emit('tts_end', {
        sessionId,
        timestamp: Date.now(),
      });
    } catch (error) {
      this.logger.error(`TTS failed: ${error.message}`);
      this.emitError(client, 'TTS_ERROR', error.message);
    }
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('disconnect_session')
  async handleDisconnectSession(
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    try {
      const sessionId = client.data.sessionId;
      if (sessionId) {
        this.streamService.destroySession(sessionId);
        client.data.sessionId = null;
        client.emit('session_disconnected', { sessionId });
      }
    } catch (error) {
      this.logger.error(`Session disconnect failed: ${error.message}`);
    }
  }

  private emitError(client: Socket, code: string, message: string): void {
    const errorMessage: IErrorMessage = {
      type: 'error',
      code,
      message,
    };
    client.emit('error', errorMessage);
  }
}
