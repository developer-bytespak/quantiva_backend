import { registerAs } from '@nestjs/config';

export default registerAs('stream', () => ({
  // STT Configuration
  stt: {
    provider: process.env.STT_PROVIDER || 'openai', // 'openai', 'deepgram', 'assemblyai'
    openai: {
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.STT_OPENAI_MODEL || 'whisper-1',
    },
    deepgram: {
      apiKey: process.env.DEEPGRAM_API_KEY,
      model: process.env.STT_DEEPGRAM_MODEL || 'nova-2',
    },
    assemblyai: {
      apiKey: process.env.ASSEMBLYAI_API_KEY,
    },
  },

  // TTS Configuration
  tts: {
    provider: process.env.TTS_PROVIDER || 'openai', // 'openai', 'elevenlabs', 'aws-polly'
    openai: {
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.TTS_OPENAI_MODEL || 'tts-1',
      voice: process.env.TTS_OPENAI_VOICE || 'alloy',
    },
    elevenlabs: {
      apiKey: process.env.ELEVENLABS_API_KEY,
      voiceId: process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL',
    },
    aws: {
      region: process.env.AWS_REGION || 'us-east-1',
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      voiceId: process.env.AWS_POLLY_VOICE_ID || 'Joanna',
    },
  },

  // LLM Configuration
  llm: {
    provider: process.env.LLM_PROVIDER || 'openai', // 'openai', 'anthropic', 'local'
    openai: {
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.LLM_OPENAI_MODEL || 'gpt-4o-mini',
      maxTokens: parseInt(process.env.LLM_MAX_TOKENS || '500', 10),
      temperature: parseFloat(process.env.LLM_TEMPERATURE || '0.7'),
    },
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.LLM_ANTHROPIC_MODEL || 'claude-3-sonnet-20240229',
    },
    pythonUrl: process.env.LLM_PYTHON_URL || 'http://127.0.0.1:8000/api/v1/llm/chat',
  },

  // Session and Rate Limiting
  session: {
    maxConcurrentStreams: parseInt(
      process.env.MAX_CONCURRENT_STREAMS || '5',
      10,
    ),
    maxAudioChunkSize: parseInt(
      process.env.MAX_AUDIO_CHUNK_SIZE || '65536',
      10,
    ), // 64KB
    sessionTimeout: parseInt(process.env.SESSION_TIMEOUT || '300000', 10), // 5 minutes
    bufferSize: parseInt(process.env.AUDIO_BUFFER_SIZE || '10', 10), // Keep last 10 chunks
  },

  // Rate Limiting
  rateLimit: {
    ttl: parseInt(process.env.RATE_LIMIT_TTL || '60000', 10), // 1 minute
    limit: parseInt(process.env.RATE_LIMIT_MAX || '10', 10), // 10 requests per minute
  },
}));
