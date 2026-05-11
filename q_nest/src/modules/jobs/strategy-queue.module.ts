import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { StrategyProcessor } from './processors/strategy-processor';
import bullRedisConfig from '../../config/bull-redis.config';

@Module({
  imports: [
    ConfigModule.forFeature(bullRedisConfig),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        const redis = configService.get('bullRedis');
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
    BullModule.registerQueue({
      name: 'strategy-execution',
    }),
  ],
  providers: [StrategyProcessor],
  exports: [BullModule],
})
export class StrategyQueueModule {}

