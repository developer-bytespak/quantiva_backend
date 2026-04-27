import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UserBinanceController } from './controllers/user-binance.controller';
import { UsersService } from './users.service';
import { CloudinaryService } from './services/cloudinary.service';
import { UserBinanceService } from './services/user-binance.service';
import { ExchangesModule } from '../exchanges/exchanges.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { KycModule } from '../../kyc/kyc.module';
import { OnboardingEmailsModule } from '../onboarding-emails/onboarding-emails.module';

@Module({
  imports: [ExchangesModule, PrismaModule, KycModule, OnboardingEmailsModule],
  controllers: [UserBinanceController, UsersController],
  providers: [UsersService, CloudinaryService, UserBinanceService],
  exports: [UsersService],
})
export class UsersModule {}

