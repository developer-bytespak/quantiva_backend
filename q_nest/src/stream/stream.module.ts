import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { StreamGateway } from './stream.gateway';
import { StreamService } from './services/stream.service';
import { LLMService } from './services/llm.service';
import { ContextService } from './services/context.service';
import { STTAdapter } from './adapters/stt.adapter';
import { TTSAdapter } from './adapters/tts.adapter';
import { WsJwtGuard } from './guards/ws-jwt.guard';
import { WsRateLimitGuard } from './guards/ws-rate-limit.guard';
import { ExchangesModule } from '../modules/exchanges/exchanges.module';
import { NewsModule } from '../modules/news/news.module';
import streamConfig from '../config/stream.config';

@Module({
  imports: [
    ConfigModule.forFeature(streamConfig),
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'your-secret-key',
      signOptions: { expiresIn: '7d' },
    }),
    ExchangesModule,
    NewsModule,
  ],
  providers: [
    StreamGateway,
    StreamService,
    LLMService,
    ContextService,
    STTAdapter,
    TTSAdapter,
    WsJwtGuard,
    WsRateLimitGuard,
  ],
  exports: [StreamService],
})
export class StreamModule {}
