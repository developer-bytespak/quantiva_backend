# 🎙️ Voice Stream - Quick Reference

## 🚀 Quick Start (30 seconds)

```bash
# 1. Setup
cd q_nest
npm install
node setup-voice-stream.js

# 2. Run
npm run build
npm run start:dev

# 3. Test
node test-voice-client.js YOUR_JWT_TOKEN
```

---

## 📡 WebSocket Events

### Client → Server
```javascript
// Connect
socket.emit('message', {
  type: 'connect',
  metadata: { sampleRate: 16000, channels: 1, codec: 'pcm' }
});

// Send audio
socket.emit('message', {
  type: 'audio_chunk',
  sessionId: 'session-id',
  seq: 1,
  timestamp: Date.now(),
  eou: true,  // End of utterance
  payload: audioBuffer
});

// Direct LLM query
socket.emit('message', {
  type: 'llm_request',
  sessionId: 'session-id',
  prompt: 'What is Bitcoin?',
  request_id: 'req-1'
});
```

### Server → Client
```javascript
// Connection established
socket.on('message', (data) => {
  if (data.type === 'connected') {
    console.log('Session:', data.session_id);
  }
});

// Transcription
socket.on('message', (data) => {
  if (data.type === 'stt_final') {
    console.log('Transcript:', data.text);
  }
});

// LLM response (streaming)
socket.on('message', (data) => {
  if (data.type === 'llm_partial') {
    process.stdout.write(data.content);
  }
  if (data.type === 'llm_final') {
    console.log('\nDone:', data.content);
  }
});

// TTS audio
socket.on('message', (data) => {
  if (data.type === 'tts_chunk') {
    playAudio(data.payload);
  }
});

// Errors
socket.on('message', (data) => {
  if (data.type === 'error') {
    console.error('Error:', data.message);
  }
});
```

---

## ⚙️ Environment Variables

### Minimal Config (Mock)
```bash
STREAM_STT_PROVIDER=mock
STREAM_TTS_PROVIDER=mock
STREAM_LLM_PROVIDER=mock
```

### Production Config (OpenAI)
```bash
STREAM_STT_PROVIDER=openai-whisper
STREAM_TTS_PROVIDER=openai
STREAM_LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
```

### Production Config (Mixed)
```bash
STREAM_STT_PROVIDER=deepgram
DEEPGRAM_API_KEY=...
STREAM_TTS_PROVIDER=aws-polly
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
STREAM_LLM_PROVIDER=openai
OPENAI_API_KEY=...
```

---

## 🔧 Common Tasks

### Change STT Provider
```bash
# Edit .env
STREAM_STT_PROVIDER=deepgram
DEEPGRAM_API_KEY=your_key

# Restart
pm2 restart quantiva-voice
```

### Increase Rate Limits
```bash
# Edit .env
STREAM_RATE_LIMIT_MAX=50
STREAM_MAX_CONCURRENT_SESSIONS=10

# Restart
pm2 restart quantiva-voice
```

### Enable Debug Logging
```bash
# Edit .env
STREAM_DEBUG=true

# Restart and tail logs
pm2 restart quantiva-voice
pm2 logs quantiva-voice
```

### Clear Sessions (if stuck)
```bash
# Sessions are in-memory, just restart
pm2 restart quantiva-voice
```

---

## 🐛 Debugging

### Check Active Sessions
```typescript
// Add to stream.service.ts
this.logger.log(`Active sessions: ${this.sessions.size}`);
```

### Test STT Directly
```bash
# OpenAI Whisper
curl -X POST https://api.openai.com/v1/audio/transcriptions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -F file=@audio.mp3 \
  -F model=whisper-1

# Deepgram
curl -X POST https://api.deepgram.com/v1/listen \
  -H "Authorization: Token $DEEPGRAM_API_KEY" \
  -H "Content-Type: audio/wav" \
  --data-binary @audio.wav
```

### Test TTS Directly
```bash
# OpenAI TTS
curl -X POST https://api.openai.com/v1/audio/speech \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"tts-1","input":"Hello","voice":"alloy"}' \
  --output speech.mp3
```

### Test LLM Directly
```bash
# OpenAI
curl -X POST https://api.openai.com/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Hi"}]}'
```

---

## 📊 Monitoring Commands

### Check Server Status
```bash
pm2 status
pm2 monit
```

### View Logs
```bash
pm2 logs quantiva-voice --lines 100
pm2 logs quantiva-voice --err  # Errors only
```

### Check Memory
```bash
pm2 list
# Look at "memory" column
```

### Restart
```bash
pm2 restart quantiva-voice
pm2 reload quantiva-voice  # Zero-downtime
```

---

## 🎯 Testing Scripts

### Test WebSocket Connection
```javascript
const io = require('socket.io-client');
const socket = io('http://localhost:3001', {
  auth: { token: 'YOUR_JWT' }
});

socket.on('connect', () => console.log('✅ Connected'));
socket.on('disconnect', () => console.log('❌ Disconnected'));
socket.on('message', (data) => console.log('📥', data));
```

### Load Test (Simple)
```bash
# Run multiple clients
for i in {1..10}; do
  node test-voice-client.js $JWT_TOKEN &
done
wait
```

---

## 📁 Key Files

| File | Purpose |
|------|---------|
| `src/stream/stream.gateway.ts` | WebSocket entry point |
| `src/stream/services/stream.service.ts` | Core orchestration |
| `src/stream/adapters/stt.adapter.ts` | STT providers |
| `src/stream/adapters/tts.adapter.ts` | TTS providers |
| `src/stream/services/llm.service.ts` | LLM integration |
| `src/stream/services/context.service.ts` | Crypto context |
| `src/config/stream.config.ts` | Configuration |
| `.env` | Environment variables |

---

## 🔗 Useful URLs

### Local Development
- Server: http://localhost:3001
- WebSocket: ws://localhost:3001

### Documentation
- Main README: `README.voice.md`
- Implementation: `VOICE_IMPLEMENTATION_SUMMARY.md`
- Deployment: `DEPLOYMENT_CHECKLIST.md`

### Provider Docs
- OpenAI: https://platform.openai.com/docs
- Deepgram: https://developers.deepgram.com
- AssemblyAI: https://www.assemblyai.com/docs
- AWS Polly: https://docs.aws.amazon.com/polly

---

## 💡 Pro Tips

### Reduce Latency
1. Use Deepgram for STT (300ms vs 2-5s)
2. Use streaming LLM responses
3. Enable context caching
4. Use CDN for audio delivery

### Reduce Costs
1. Use GPT-4o-mini instead of GPT-4
2. Use shorter system prompts
3. Implement response caching
4. Set max_tokens limits

### Improve Quality
1. Use GPT-4o for better responses
2. Include more context (prices, news)
3. Fine-tune system prompts
4. Use higher-quality TTS voices

---

**Quick Help**: Run `node setup-voice-stream.js` for interactive setup
