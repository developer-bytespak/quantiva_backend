#!/usr/bin/env node
/**
 * Voice Stream Quick Start Setup
 * 
 * This script helps you configure and test the voice stream implementation
 * 
 * Usage:
 *   node setup-voice-stream.js
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

async function main() {
  console.log('\n🎙️  Voice Stream Setup Wizard');
  console.log('=================================\n');

  // Check if .env exists
  const envPath = path.join(__dirname, '.env');
  const envExamplePath = path.join(__dirname, '.env.stream.example');
  
  if (!fs.existsSync(envPath)) {
    console.log('⚠️  .env file not found. Creating from example...');
    if (fs.existsSync(envExamplePath)) {
      fs.copyFileSync(envExamplePath, envPath);
      console.log('✅ Created .env file\n');
    }
  }

  console.log('Choose your STT provider:\n');
  console.log('1. Mock (for testing, no API key needed)');
  console.log('2. OpenAI Whisper (requires OpenAI API key)');
  console.log('3. Deepgram (requires Deepgram API key)');
  console.log('4. AssemblyAI (requires AssemblyAI API key)\n');
  
  const sttChoice = await question('Enter choice (1-4): ');
  
  let sttProvider = 'mock';
  let sttApiKey = '';
  
  switch(sttChoice.trim()) {
    case '2':
      sttProvider = 'openai-whisper';
      sttApiKey = await question('Enter OpenAI API key: ');
      break;
    case '3':
      sttProvider = 'deepgram';
      sttApiKey = await question('Enter Deepgram API key: ');
      break;
    case '4':
      sttProvider = 'assemblyai';
      sttApiKey = await question('Enter AssemblyAI API key: ');
      break;
    default:
      sttProvider = 'mock';
  }

  console.log('\n\nChoose your TTS provider:\n');
  console.log('1. Mock (for testing, no API key needed)');
  console.log('2. OpenAI TTS (requires OpenAI API key)');
  console.log('3. AWS Polly (requires AWS credentials)');
  console.log('4. Google Cloud TTS (requires Google credentials)\n');
  
  const ttsChoice = await question('Enter choice (1-4): ');
  
  let ttsProvider = 'mock';
  
  switch(ttsChoice.trim()) {
    case '2':
      ttsProvider = 'openai';
      if (!sttApiKey && sttProvider === 'openai-whisper') {
        console.log('✅ Using same OpenAI API key for TTS');
      } else if (!sttApiKey) {
        sttApiKey = await question('Enter OpenAI API key: ');
      }
      break;
    case '3':
      ttsProvider = 'aws-polly';
      console.log('⚠️  Please configure AWS credentials in .env manually');
      break;
    case '4':
      ttsProvider = 'google';
      console.log('⚠️  Please configure Google credentials in .env manually');
      break;
    default:
      ttsProvider = 'mock';
  }

  console.log('\n\nChoose your LLM provider:\n');
  console.log('1. Mock (for testing, returns canned responses)');
  console.log('2. OpenAI GPT-4 (requires OpenAI API key)');
  console.log('3. Anthropic Claude (requires Anthropic API key)\n');
  
  const llmChoice = await question('Enter choice (1-3): ');
  
  let llmProvider = 'mock';
  let llmApiKey = '';
  
  switch(llmChoice.trim()) {
    case '2':
      llmProvider = 'openai';
      if (sttApiKey && (sttProvider === 'openai-whisper' || ttsProvider === 'openai')) {
        console.log('✅ Using same OpenAI API key for LLM');
        llmApiKey = sttApiKey;
      } else {
        llmApiKey = await question('Enter OpenAI API key: ');
      }
      break;
    case '3':
      llmProvider = 'anthropic';
      llmApiKey = await question('Enter Anthropic API key: ');
      break;
    default:
      llmProvider = 'mock';
  }

  // Update .env file
  console.log('\n\n📝 Updating .env file...');
  
  let envContent = fs.readFileSync(envPath, 'utf-8');
  
  // Update or add configurations
  const updates = {
    'STREAM_STT_PROVIDER': sttProvider,
    'STREAM_TTS_PROVIDER': ttsProvider,
    'STREAM_LLM_PROVIDER': llmProvider,
  };

  if (sttApiKey) {
    if (sttProvider === 'openai-whisper' || ttsProvider === 'openai' || llmProvider === 'openai') {
      updates['OPENAI_API_KEY'] = sttApiKey;
    } else if (sttProvider === 'deepgram') {
      updates['DEEPGRAM_API_KEY'] = sttApiKey;
    } else if (sttProvider === 'assemblyai') {
      updates['ASSEMBLYAI_API_KEY'] = sttApiKey;
    }
  }

  if (llmApiKey && llmProvider === 'anthropic') {
    updates['ANTHROPIC_API_KEY'] = llmApiKey;
  }

  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(envContent)) {
      envContent = envContent.replace(regex, `${key}=${value}`);
    } else {
      envContent += `\n${key}=${value}`;
    }
  }

  fs.writeFileSync(envPath, envContent);
  
  console.log('✅ Configuration updated!\n');
  console.log('=================================');
  console.log('📋 Configuration Summary:');
  console.log('=================================');
  console.log(`STT Provider: ${sttProvider}`);
  console.log(`TTS Provider: ${ttsProvider}`);
  console.log(`LLM Provider: ${llmProvider}`);
  console.log('=================================\n');

  console.log('Next steps:\n');
  console.log('1. Review your .env file and add any missing credentials');
  console.log('2. Run: npm run build');
  console.log('3. Run: npm run start:dev');
  console.log('4. Test with: node test-voice-client.js [YOUR_JWT_TOKEN]\n');
  console.log('For more details, see README.voice.md\n');

  rl.close();
}

main().catch(err => {
  console.error('❌ Setup failed:', err);
  rl.close();
  process.exit(1);
});
