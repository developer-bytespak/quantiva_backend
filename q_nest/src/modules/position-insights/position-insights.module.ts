import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import redisConfig from '../../config/redis.config';
import { PositionInsightsController } from './position-insights.controller';
import { PositionInsightsService } from './position-insights.service';
import { ColdRefreshProcessor, COLD_REFRESH_QUEUE } from './cold-refresh.processor';
import { NewsModule } from '../news/news.module';

@Module({
  imports: [
    ConfigModule.forFeature(redisConfig),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => {
        const redis = config.get<{
          host: string;
          port: number;
          password?: string;
          db: number;
          tls?: object;
          maxRetriesPerRequest: number;
          retryStrategy: (times: number) => number;
        }>('redis')!;
        return {
          connection: {
            host: redis.host,
            port: redis.port,
            password: redis.password,
            db: redis.db,
            tls: redis.tls,
            maxRetriesPerRequest: redis.maxRetriesPerRequest,
            retryStrategy: redis.retryStrategy,
          },
        };
      },
      inject: [ConfigService],
    }),
    BullModule.registerQueue({ name: COLD_REFRESH_QUEUE }),
    NewsModule,
  ],
  controllers: [PositionInsightsController],
  providers: [PositionInsightsService, ColdRefreshProcessor],
  exports: [PositionInsightsService],
})
export class PositionInsightsModule {}
