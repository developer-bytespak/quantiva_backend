import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { KycController } from './kyc.controller';
import { KycWebhookController } from './kyc-webhook.controller';
import { KycService } from './services/kyc.service';
import { DocumentService } from './services/document.service';
import { LivenessService } from './services/liveness.service';
import { FaceMatchingService } from './services/face-matching.service';
import { DecisionEngineService } from './services/decision-engine.service';
import { ReviewService } from './services/review.service';
import { PythonApiService } from './integrations/python-api.service';
import { SumsubService } from './integrations/sumsub.service';

@Module({
  imports: [PrismaModule, StorageModule, ConfigModule],
  controllers: [KycController, KycWebhookController],
  providers: [
    KycService,
    DocumentService,
    LivenessService,
    FaceMatchingService,
    DecisionEngineService,
    ReviewService,
    PythonApiService,
    SumsubService,
  ],
  exports: [KycService, PythonApiService, SumsubService],
})
export class KycModule {}

