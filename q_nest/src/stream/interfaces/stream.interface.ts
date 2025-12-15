export interface IConnectMessage {
  type: 'connect';
  authToken: string;
  clientId?: string;
  sessionId?: string;
  metadata?: {
    sampleRate?: number;
    channels?: number;
    codec?: 'pcm' | 'opus';
    modelHint?: string;
  };
}

export interface IConnectedMessage {
  type: 'connected';
  sessionId: string;
  serverTime: string;
  allowedActions: {
    maxStreams: number;
    chunkSizeBytes: number;
    sttModel: string;
  };
}

export interface IAudioChunk {
  sessionId: string;
  seq: number;
  timestamp: number;
  eou?: boolean; // End of utterance
  payload: Buffer;
}

export interface ISTTPartialMessage {
  type: 'stt_partial';
  sessionId: string;
  seq: number;
  text: string;
  confidence?: number;
  isFinal: boolean;
}

export interface ISTTFinalMessage {
  type: 'stt_final';
  sessionId: string;
  transcriptId: string;
  text: string;
  confidence?: number;
  segments?: Array<{
    startMs: number;
    endMs: number;
    text: string;
  }>;
}

export interface ILLMRequestMessage {
  type: 'llm_request';
  sessionId: string;
  transcriptId?: string;
  prompt?: string;
  context?: any;
  requestId: string;
}

export interface ILLMPartialMessage {
  type: 'llm_partial';
  requestId: string;
  content: string;
  seq: number;
}

export interface ILLMFinalMessage {
  type: 'llm_final';
  requestId: string;
  content: string;
  metadata?: {
    usage?: any;
    model?: string;
    elapsedMs?: number;
  };
}

export interface ITTSChunk {
  sessionId: string;
  seq: number;
  timestamp: number;
  eou?: boolean;
  payload: Buffer;
}

export interface IErrorMessage {
  type: 'error';
  code: string;
  message: string;
  details?: any;
}

export interface IStreamSession {
  sessionId: string;
  userId: string;
  clientId: string;
  socketId: string;
  createdAt: Date;
  lastActivity: Date;
  audioBuffer: Buffer[];
  currentTranscript: string;
  metadata: any;
}

export interface ISTTAdapter {
  transcribe(
    audioBuffer: Buffer,
    options?: any,
  ): Promise<{ text: string; confidence?: number }>;
  transcribeStream?(
    audioChunks: AsyncIterable<Buffer>,
    options?: any,
  ): AsyncIterable<{ text: string; isFinal: boolean; confidence?: number }>;
}

export interface ITTSAdapter {
  synthesize(
    text: string,
    options?: any,
  ): Promise<{ audio: Buffer; format: string }>;
  synthesizeStream?(
    text: string,
    options?: any,
  ): AsyncIterable<{ audio: Buffer; format: string }>;
}

export interface ILLMAdapter {
  chat(
    prompt: string,
    context?: any,
    options?: any,
  ): Promise<{ content: string; metadata?: any }>;
  chatStream?(
    prompt: string,
    context?: any,
    options?: any,
  ): AsyncIterable<{ content: string; done: boolean; metadata?: any }>;
}
