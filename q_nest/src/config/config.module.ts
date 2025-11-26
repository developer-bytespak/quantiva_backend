import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import jwtConfig from './jwt.config';

@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      load: [jwtConfig],
    }),
  ],
})
export class ConfigModule {}
