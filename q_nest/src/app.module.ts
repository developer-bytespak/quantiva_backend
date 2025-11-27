import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { ConfigModule } from './config/config.module';
import { AuthModule } from './modules/auth/auth.module';
import { KycModule } from './kyc/kyc.module';

@Module({
  imports: [ConfigModule, PrismaModule, AuthModule, KycModule],
  controllers: [],
  providers: [],
})
export class AppModule {}
