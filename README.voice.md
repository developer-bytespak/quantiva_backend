# 🎙️ Voice-Only Crypto AI Assistant

## Overview

A production-ready, real-time voice assistant for cryptocurrency market analysis. Users speak questions about crypto markets and receive spoken answers through a WebSocket-based streaming architecture.

**Status**: ✅ **Implementation Complete** (Phase 1 MVP)

## Features

- ✅ **Real-time voice streaming** via Socket.IO WebSocket
- ✅ **Speech-to-Text (STT)** with pluggable adapters (OpenAI Whisper, Deepgram, AssemblyAI, Mock)
- ✅ **Text-to-Speech (TTS)** streaming (OpenAI TTS, AWS Polly, Google Cloud TTS, Mock)
- ✅ **LLM-powered responses** with crypto market context (OpenAI, Anthropic, Local)
- ✅ **Context enrichment** from live Binance/Bybit data and crypto news
- ✅ **JWT authentication** and WebSocket guards
- ✅ **Rate limiting** per user and session
- ✅ **Session management** with automatic cleanup and timeout
- ✅ **Comprehensive error handling** and logging

## Implementation Status

### ✅ Completed Components

| Component | File | Status |
|-----------|------|--------|
| WebSocket Gateway | `src/stream/stream.gateway.ts` | ✅ Complete |
| Stream Service | `src/stream/services/stream.service.ts` | ✅ Complete |
| STT Adapter | `src/stream/adapters/stt.adapter.ts` | ✅ Complete |
| TTS Adapter | `src/stream/adapters/tts.adapter.ts` | ✅ Complete |
| LLM Service | `src/stream/services/llm.service.ts` | ✅ Complete |
| Context Service | `src/stream/services/context.service.ts` | ✅ Complete |
| JWT Guard | `src/stream/guards/ws-jwt.guard.ts` | ✅ Complete |
| Rate Limit Guard | `src/stream/guards/ws-rate-limit.guard.ts` | ✅ Complete |
| Configuration | `src/config/stream.config.ts` | ✅ Complete |
| Stream Module | `src/stream/stream.module.ts` | ✅ Complete |
| Tests | `src/stream/tests/stream.gateway.spec.ts` | ✅ Complete |
| Documentation | `README.voice.md`, `.env.stream.example` | ✅ Complete |

## Architecture

```
┌─────────────┐
│   Client    │
│  (Browser)  │
└──────┬──────┘
       │ WebSocket (/voice)
       ▼
┌─────────────────────┐
│  StreamGateway      │
│  - Auth (JWT)       │
│  - Rate Limiting    │
└──────┬──────────────┘
       │
       ▼
┌─────────────────────┐
│  StreamService      │
│  - Session Mgmt     │
│  - Audio Buffering  │
└──────┬──────────────┘
       │
       ├──► STTAdapter → OpenAI/Deepgram/AssemblyAI
       │
       ├──► ContextService → ExchangesService + NewsService
       │                     (Fetch BTC/ETH prices, news, sentiment)
       │
       ├──► LLMService → OpenAI GPT-4o-mini/Anthropic Claude
       │                (Crypto-aware system prompt)
       │
       └──► TTSAdapter → OpenAI TTS/ElevenLabs/AWS Polly
```

## WebSocket Protocol

### Connection

**Namespace:** `/voice`

**Auth:** JWT token required (via `auth.token`, query param, or Authorization header)

### Message Types

#### 1. Connect Session
**Client → Server**
```json
{
  "type": "connect_session",
  "authToken": "jwt_token_here",
  "clientId": "optional_client_id",
  "metadata": {
    "sampleRate": 16000,
    "channels": 1,
    "codec": "pcm"
  }
}
```

**Server → Client**
```json
{
  "type": "connected",
  "sessionId": "uuid-session-id",
  "serverTime": "2025-12-15T10:00:00.000Z",
  "allowedActions": {
    "maxStreams": 5,
    "chunkSizeBytes": 65536,
    "sttModel": "openai"
  }
}
```

#### 2. Audio Streaming
**Client → Server** (Event: `audio_chunk`)
```json
{
  "sessionId": "uuid-session-id",
  "seq": 1,
  "timestamp": 1702641234567,
  "eou": false,
  "payload": "<base64_or_buffer>"
}
```

When `eou: true` (end-of-utterance), transcription is triggered automatically.

#### 3. Transcription Results
**Server → Client** (Event: `stt_final`)
```json
{
  "type": "stt_final",
  "sessionId": "uuid-session-id",
  "transcriptId": "transcript_1702641234567",
  "text": "What's happening with Bitcoin today?",
  "confidence": 0.95
}
```

#### 4. LLM Streaming Response
**Server → Client** (Event: `llm_partial`)
```json
{
  "type": "llm_partial",
  "requestId": "llm_1702641234567",
  "content": "Bitcoin is currently trading at ",
  "seq": 0
}
```

**Server → Client** (Event: `llm_final`)
```json
{
  "type": "llm_final",
  "requestId": "llm_1702641234567",
  "content": "Bitcoin is currently trading at $42,500, up 2.5% in the last 24 hours...",
  "metadata": {
    "elapsedMs": 1234
  }
}
```

#### 5. TTS Audio Streaming
**Server → Client** (Event: `tts_chunk`)
```json
{
  "sessionId": "uuid-session-id",
  "seq": 0,
  "timestamp": 1702641234567,
  "payload": "<audio_buffer>",
  "format": "mp3"
}
```

**Server → Client** (Event: `tts_end`)
```json
{
  "sessionId": "uuid-session-id",
  "timestamp": 1702641234567
}
```

#### 6. Error Handling
**Server → Client** (Event: `error`)
```json
{
  "type": "error",
  "code": "STT_ERROR",
  "message": "Transcription failed: insufficient audio data"
}
```

## Environment Variables

Add to `.env`:

```bash
# STT Configuration
STT_PROVIDER=openai  # openai, deepgram, assemblyai
OPENAI_API_KEY=sk-...
STT_OPENAI_MODEL=whisper-1

# Alternative: Deepgram
DEEPGRAM_API_KEY=your_key
STT_DEEPGRAM_MODEL=nova-2

# Alternative: AssemblyAI
ASSEMBLYAI_API_KEY=your_key

# TTS Configuration
TTS_PROVIDER=openai  # openai, elevenlabs, aws-polly
TTS_OPENAI_MODEL=tts-1
TTS_OPENAI_VOICE=alloy

# Alternative: ElevenLabs
ELEVENLABS_API_KEY=your_key
ELEVENLABS_VOICE_ID=EXAVITQu4vr4xnSDxMaL

# Alternative: AWS Polly
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your_key
AWS_SECRET_ACCESS_KEY=your_secret
AWS_POLLY_VOICE_ID=Joanna

# LLM Configuration
LLM_PROVIDER=openai  # openai, anthropic
LLM_OPENAI_MODEL=gpt-4o-mini
LLM_MAX_TOKENS=500
LLM_TEMPERATURE=0.7

# Alternative: Anthropic
ANTHROPIC_API_KEY=your_key
LLM_ANTHROPIC_MODEL=claude-3-sonnet-20240229

# Session & Rate Limiting
MAX_CONCURRENT_STREAMS=5
MAX_AUDIO_CHUNK_SIZE=65536
SESSION_TIMEOUT=300000  # 5 minutes
AUDIO_BUFFER_SIZE=10
RATE_LIMIT_TTL=60000    # 1 minute
RATE_LIMIT_MAX=10       # 10 requests per minute

# JWT (already configured)
JWT_SECRET=your-secret-key
```

## Installation

1. **Install dependencies:**
   ```bash
   cd q_nest
   npm install
   ```

2. **Configure environment:**
   ```bash
   cp .env.example .env
   # Edit .env with your API keys
   ```

3. **Run the server:**
   ```bash
   npm run start:dev
   ```

   Server runs on: `http://localhost:3001`
   WebSocket namespace: `ws://localhost:3001/voice`

## Testing

### Using a WebSocket Client

```javascript
import io from 'socket.io-client';

const socket = io('http://localhost:3001/voice', {
  auth: {
    token: 'your_jwt_token'
  }
});

// Connect session
socket.emit('connect_session', {
  type: 'connect_session',
  authToken: 'your_jwt_token',
  metadata: {
    sampleRate: 16000,
    channels: 1,
    codec: 'pcm'
  }
});

// Listen for connected
socket.on('connected', (data) => {
  console.log('Connected:', data);
});

// Send audio chunks
socket.emit('audio_chunk', {
  seq: 0,
  timestamp: Date.now(),
  eou: false,
  payload: audioBuffer
});

// Listen for transcription
socket.on('stt_final', (data) => {
  console.log('Transcript:', data.text);
});

// Listen for LLM response
socket.on('llm_partial', (data) => {
  console.log('LLM chunk:', data.content);
});

socket.on('llm_final', (data) => {
  console.log('LLM complete:', data.content);
});

// Listen for TTS audio
socket.on('tts_chunk', (data) => {
  // Play audio chunk
  playAudio(data.payload);
});

socket.on('tts_end', () => {
  console.log('Audio playback complete');
});
```

## Example Use Cases

### 1. Bitcoin Price Query
**User:** "What's happening with Bitcoin today?"

**System Flow:**
1. Audio → STT: "What's happening with Bitcoin today?"
2. Context enrichment: Fetch BTC price, recent news, sentiment
3. LLM generates response with context
4. TTS converts response to audio
5. Audio streams back to user

**Response:** "Bitcoin is currently trading at $42,500, up 2.5% in the last 24 hours. Recent news shows positive sentiment around institutional adoption..."

### 2. Market Volatility Question
**User:** "Why is ETH volatile right now?"

**System Flow:**
1. Audio → STT
2. Context: ETH price data, volatility metrics, news
3. LLM response with risk-first explanation
4. TTS → Audio

**Response:** "Ethereum is showing volatility due to recent network upgrade announcements. Price is at $2,250, down 1.2% today. Keep in mind crypto markets are highly volatile and subject to rapid changes..."

## Security

- **JWT Authentication:** Required on all WebSocket messages
- **Rate Limiting:** 10 requests per minute per user
- **Session Limits:** Max 5 concurrent streams per user
- **Input Validation:** Audio chunk size limits (64KB)
- **Timeout Protection:** Sessions auto-expire after 5 minutes of inactivity

## Production Deployment

### Option 1: Managed APIs (Recommended for MVP)
- **STT:** OpenAI Whisper API or Deepgram
- **TTS:** OpenAI TTS or ElevenLabs
- **LLM:** OpenAI GPT-4o-mini

**Pros:** Fast to deploy, minimal infrastructure
**Cons:** API costs, network latency

### Option 2: Self-Hosted (For Scale)
- **STT:** whisper.cpp on GPU instances
- **TTS:** Coqui TTS on GPU
- **LLM:** vLLM with Llama 3 on GPU cluster

**Pros:** Lower recurring costs, better privacy
**Cons:** Complex ops, GPU infrastructure required

### Recommended Stack
```yaml
# docker-compose.voice.yml
services:
  nest_api:
    build: ./q_nest
    ports:
      - "3001:3001"
    environment:
      - STT_PROVIDER=openai
      - TTS_PROVIDER=openai
      - LLM_PROVIDER=openai
  
  redis:
    image: redis:7
    ports:
      - "6379:6379"
```

## Monitoring

Key metrics to track:
- Active WebSocket connections
- STT latency (ms)
- LLM response time (ms)
- TTS generation time (ms)
- Error rates by type
- Audio buffer sizes
- Session durations

## Known Limitations (MVP)

1. **No VAD (Voice Activity Detection):** Client must send `eou: true`
2. **No streaming STT:** Accumulates audio before transcription
3. **No audio format negotiation:** Assumes compatible formats
4. **Basic error recovery:** No automatic reconnection
5. **No transcript history:** Sessions are ephemeral

## Roadmap (Phase 2)

- [ ] Add server-side VAD for automatic EoU detection
- [ ] Implement streaming STT for real-time partials
- [ ] Add audio format transcoding (opus, pcm, etc.)
- [ ] Persistent transcript history with Prisma
- [ ] WebRTC for ultra-low-latency audio
- [ ] Multi-language support
- [ ] Voice biometrics for security
- [ ] Background noise suppression

## Support

For issues or questions, check:
- Gateway logs: Look for `StreamGateway` entries
- Session status: Monitor active session count
- API key validity: Verify STT/TTS/LLM credentials

## License

MIT
