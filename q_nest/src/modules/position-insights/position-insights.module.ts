import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import bullRedisConfig from '../../config/bull-redis.config';
import { PositionInsightsController } from './position-insights.controller';
import { PositionInsightsService } from './position-insights.service';
import { ColdRefreshProcessor, COLD_REFRESH_QUEUE } from './cold-refresh.processor';
import { NewsModule } from '../news/news.module';

@Module({
  imports: [
    ConfigModule.forFeature(bullRedisConfig),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => {
        const redis = config.get<{
          host: string;
          port: number;
          username?: string;
          password?: string;
          db: number;
          tls?: object;
          maxRetriesPerRequest: number | null;
          retryStrategy: (times: number) => number;
        }>('bullRedis')!;
        return {
          connection: {
            host: redis.host,
            port: redis.port,
            username: redis.username,
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
