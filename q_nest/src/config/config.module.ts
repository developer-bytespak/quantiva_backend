import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import jwtConfig from './jwt.config';
import kycConfig from './kyc.config';

@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      load: [jwtConfig, kycConfig],
    }),
  ],
})
export class ConfigModule {}
