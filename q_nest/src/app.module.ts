import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { ConfigModule } from './config/config.module';
import { AuthModule } from './modules/auth/auth.module';
import { KycModule } from './kyc/kyc.module';
import { ExchangesModule } from './modules/exchanges/exchanges.module';
import { UsersModule } from './modules/users/users.module';
import { NewsModule } from './modules/news/news.module';

@Module({
  imports: [ConfigModule, PrismaModule, AuthModule, KycModule, ExchangesModule, UsersModule, NewsModule],
  controllers: [],
  providers: [],
})
export class AppModule {}
