import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { ConfigModule } from './config/config.module';
import { AuthModule } from './modules/auth/auth.module';

@Module({
  imports: [ConfigModule, PrismaModule, AuthModule],
  controllers: [],
  providers: [],
})
export class AppModule {}
