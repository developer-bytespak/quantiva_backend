import { registerAs } from '@nestjs/config';

export default registerAs('bullRedis', () => ({
  host: process.env.BULL_REDIS_HOST || 'localhost',
  port: parseInt(process.env.BULL_REDIS_PORT || '6379', 10),
  username: process.env.BULL_REDIS_USERNAME,
  password: process.env.BULL_REDIS_PASSWORD,
  db: parseInt(process.env.BULL_REDIS_DB || '0', 10),
  tls: process.env.BULL_REDIS_TLS === 'true' ? {} : undefined,
  maxRetriesPerRequest: null,
  retryStrategy: (times: number) => Math.min(times * 200, 10000),
}));
