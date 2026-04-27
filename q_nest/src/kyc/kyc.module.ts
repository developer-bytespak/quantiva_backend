import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { KycController } from './kyc.controller';
import { KycWebhookController } from './kyc-webhook.controller';
import { KycService } from './services/kyc.service';
import { DocumentService } from './services/document.service';
import { DecisionEngineService } from './services/decision-engine.service';
import { ReviewService } from './services/review.service';
import { PythonApiService } from './integrations/python-api.service';
import { SumsubService } from './integrations/sumsub.service';
import { KycEmailService } from './services/kyc-email.service';
import { OnboardingEmailsModule } from '../modules/onboarding-emails/onboarding-emails.module';

@Module({
  imports: [PrismaModule, StorageModule, ConfigModule, OnboardingEmailsModule],
  controllers: [KycController, KycWebhookController],
  providers: [
    KycService,
    DocumentService,
    DecisionEngineService,
    ReviewService,
    PythonApiService,
    SumsubService,
    KycEmailService,
  ],
  exports: [KycService, PythonApiService, SumsubService, KycEmailService],
})
export class KycModule {}

