import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { StreamGateway } from '../stream.gateway';
import { StreamService } from '../services/stream.service';
import { LLMService } from '../services/llm.service';
import { ContextService } from '../services/context.service';
import { STTAdapter } from '../adapters/stt.adapter';
import { TTSAdapter } from '../adapters/tts.adapter';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { io as ioc, Socket } from 'socket.io-client';

describe('StreamGateway (e2e)', () => {
  let app: INestApplication;
  let gateway: StreamGateway;
  let clientSocket: Socket;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      providers: [
        StreamGateway,
        {
          provide: StreamService,
          useValue: {
            createSession: jest.fn().mockReturnValue({
              sessionId: 'test-session-id',
              userId: 'test-user',
              clientId: 'test-client',
              socketId: 'test-socket',
              createdAt: new Date(),
              lastActivity: new Date(),
              audioBuffer: [],
              currentTranscript: '',
              metadata: {},
            }),
            processAudioChunk: jest.fn(),
            transcribeAudio: jest.fn().mockResolvedValue({
              text: 'What is Bitcoin?',
              confidence: 0.95,
            }),
            processQuery: jest.fn().mockImplementation(async function* () {
              yield { content: 'Bitcoin is a cryptocurrency', done: false };
              yield { content: '', done: true };
            }),
            synthesizeSpeech: jest.fn().mockImplementation(async function* () {
              yield { audio: Buffer.from('mock-audio'), format: 'mp3' };
            }),
            destroySession: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: any) => {
              const config = {
                'stream.session.maxConcurrentStreams': 5,
                'stream.session.maxAudioChunkSize': 65536,
                'stream.stt.provider': 'openai',
              };
              return config[key] || defaultValue;
            }),
          },
        },
        {
          provide: JwtService,
          useValue: {
            verifyAsync: jest.fn().mockResolvedValue({ sub: 'test-user' }),
          },
        },
      ],
    }).compile();

    gateway = moduleFixture.get<StreamGateway>(StreamGateway);
  });

  afterAll(async () => {
    if (clientSocket) {
      clientSocket.close();
    }
  });

  it('should be defined', () => {
    expect(gateway).toBeDefined();
  });

  it('should create a session on connect', async () => {
    const mockClient: any = {
      id: 'test-socket-id',
      data: { userId: 'test-user' },
    };

    const result = await gateway.handleConnect(mockClient, {
      type: 'connect',
      authToken: 'mock-token',
      clientId: 'test-client',
    });

    expect(result).toHaveProperty('type', 'connected');
    expect(result).toHaveProperty('sessionId');
  });

  it('should handle audio chunks', async () => {
    const mockClient: any = {
      id: 'test-socket-id',
      data: { userId: 'test-user', sessionId: 'test-session' },
      emit: jest.fn(),
    };

    const audioData = {
      sessionId: 'test-session',
      seq: 0,
      timestamp: Date.now(),
      eou: false,
      payload: Buffer.from('mock-audio-data'),
    };

    await gateway.handleAudioChunk(mockClient, audioData);

    // Should not throw error
    expect(true).toBe(true);
  });
});
