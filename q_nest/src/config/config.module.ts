import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import jwtConfig from './jwt.config';
import kycConfig from './kyc.config';
import cloudinaryConfig from './cloudinary.config';

@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      load: [jwtConfig, kycConfig, cloudinaryConfig],
    }),
  ],
})
export class ConfigModule {}
