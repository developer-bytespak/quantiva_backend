import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import jwtConfig from './jwt.config';
import kycConfig from './kyc.config';
import cloudinaryConfig from './cloudinary.config';
import bullRedisConfig from './bull-redis.config';

@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      load: [jwtConfig, kycConfig, cloudinaryConfig, bullRedisConfig],
    }),
  ],
})
export class ConfigModule {}
