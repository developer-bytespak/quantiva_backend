import { Module } from '@nestjs/common';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { KycModule } from '../../kyc/kyc.module';
import { ExchangesModule } from '../exchanges/exchanges.module';
import { OnboardingEmailsModule } from '../onboarding-emails/onboarding-emails.module';

@Module({
  imports: [PrismaModule, AuthModule, KycModule, ExchangesModule, OnboardingEmailsModule],
  controllers: [OnboardingController],
  providers: [OnboardingService],
  exports: [OnboardingService],
})
export class OnboardingModule {}
