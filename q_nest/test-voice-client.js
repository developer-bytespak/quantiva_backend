/**
 * Simple WebSocket Client Test for Voice Stream
 * 
 * This script tests the voice stream WebSocket gateway by:
 * 1. Connecting to the WebSocket server
 * 2. Sending a mock audio chunk
 * 3. Receiving STT, LLM, and TTS responses
 * 
 * Usage:
 *   node test-voice-client.js [JWT_TOKEN]
 */

const io = require('socket.io-client');

// Configuration
const WS_URL = process.env.WS_URL || 'http://localhost:3001';
const JWT_TOKEN = process.argv[2] || 'mock-jwt-token-for-testing';

console.log('🎙️  Voice Stream Client Test');
console.log('================================');
console.log(`Connecting to: ${WS_URL}`);
console.log(`Auth token: ${JWT_TOKEN.substring(0, 20)}...`);
console.log('');

// Create socket connection
const socket = io(WS_URL, {
  transports: ['websocket'],
  auth: {
    token: JWT_TOKEN
  },
  reconnection: false
});

// Track test state
let sessionId = null;
let testPassed = false;

// Connection events
socket.on('connect', () => {
  console.log('✅ Connected to WebSocket server');
  console.log(`   Socket ID: ${socket.id}`);
  
  // Send connect message
  const connectMsg = {
    type: 'connect',
    client_id: 'test-client-' + Date.now(),
    metadata: {
      sampleRate: 16000,
      channels: 1,
      codec: 'pcm'
    }
  };
  
  console.log('\n📤 Sending connect message:', JSON.stringify(connectMsg, null, 2));
  socket.emit('message', connectMsg);
});

socket.on('disconnect', (reason) => {
  console.log(`\n❌ Disconnected: ${reason}`);
  process.exit(testPassed ? 0 : 1);
});

socket.on('connect_error', (error) => {
  console.error('\n❌ Connection error:', error.message);
  process.exit(1);
});

// Message events
socket.on('message', (data) => {
  console.log('\n📥 Received message:', JSON.stringify(data, null, 2));
  
  if (data.type === 'connected') {
    sessionId = data.session_id;
    console.log(`\n✅ Session established: ${sessionId}`);
    
    // Send a test audio chunk (mock data)
    sendTestAudioChunk();
  }
  
  if (data.type === 'stt_partial' || data.type === 'stt_final') {
    console.log(`\n✅ STT Response: "${data.text}"`);
  }
  
  if (data.type === 'llm_partial') {
    process.stdout.write(data.content);
  }
  
  if (data.type === 'llm_final') {
    console.log(`\n\n✅ LLM Response complete`);
    console.log(`   Content: ${data.content}`);
    testPassed = true;
    
    // Test completed successfully
    setTimeout(() => {
      console.log('\n✅ All tests passed!');
      socket.disconnect();
    }, 1000);
  }
});

socket.on('error', (error) => {
  console.error('\n❌ Socket error:', error);
});

socket.on('stt_partial', (data) => {
  console.log(`\n🎤 STT Partial: "${data.text}"`);
});

socket.on('stt_final', (data) => {
  console.log(`\n✅ STT Final: "${data.text}" (confidence: ${data.confidence})`);
});

socket.on('llm_partial', (data) => {
  process.stdout.write(data.content);
});

socket.on('llm_final', (data) => {
  console.log(`\n\n✅ LLM Response: ${data.content.substring(0, 100)}...`);
  testPassed = true;
});

socket.on('tts_chunk', (data) => {
  console.log(`\n🔊 TTS Chunk received (${data.byteLength} bytes)`);
});

function sendTestAudioChunk() {
  console.log('\n📤 Sending test audio chunk...');
  
  // Create a mock audio chunk message
  const audioMsg = {
    type: 'audio_chunk',
    session_id: sessionId,
    seq: 1,
    timestamp: Date.now(),
    eou: true, // End of utterance
    // In real implementation, this would be actual audio data
    payload: Buffer.from('mock audio data').toString('base64')
  };
  
  socket.emit('message', audioMsg);
  
  // Also send an LLM request directly for testing
  setTimeout(() => {
    console.log('\n📤 Sending direct LLM request...');
    const llmMsg = {
      type: 'llm_request',
      session_id: sessionId,
      prompt: 'What is happening with Bitcoin today?',
      request_id: 'test-' + Date.now()
    };
    socket.emit('message', llmMsg);
  }, 1000);
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n⏹️  Shutting down...');
  socket.disconnect();
  process.exit(0);
});

// Timeout after 30 seconds
setTimeout(() => {
  if (!testPassed) {
    console.error('\n❌ Test timeout - no response received');
    socket.disconnect();
    process.exit(1);
  }
}, 30000);
