import {
  Controller,
  Post,
  Body,
  Headers,
  Logger,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SumsubService } from './integrations/sumsub.service';

interface SumsubWebhookPayload {
  applicantId: string;
  inspectionId: string;
  correlationId: string;
  externalUserId: string;
  type: string;
  reviewResult?: {
    reviewAnswer: string; // GREEN, RED, YELLOW
    rejectLabels?: string[];
    reviewRejectType?: string;
    moderationComment?: string;
    clientComment?: string;
  };
  reviewStatus: string; // init, pending, completed, onHold
  createdAt: string;
}

@Controller('kyc/webhooks')
export class KycWebhookController {
  private readonly logger = new Logger(KycWebhookController.name);

  constructor(
    private prisma: PrismaService,
    private sumsubService: SumsubService,
  ) {}

  @Post('sumsub')
  @HttpCode(HttpStatus.OK)
  async handleSumsubWebhook(
    @Body() payload: SumsubWebhookPayload,
    @Headers('x-payload-digest') signature: string,
  ): Promise<{ success: boolean }> {
    this.logger.log('');
    this.logger.log('╔══════════════════════════════════════════════════════════════════╗');
    this.logger.log('║  🔔 [WEBHOOK] Sumsub webhook received                            ║');
    this.logger.log('╚══════════════════════════════════════════════════════════════════╝');
    this.logger.log(`   Applicant ID: ${payload.applicantId}`);
    this.logger.log(`   Type: ${payload.type}`);
    this.logger.log(`   Review Status: ${payload.reviewStatus}`);

    // Verify webhook signature
    if (!this.verifySignature(payload, signature)) {
      this.logger.error('❌ Invalid webhook signature');
      throw new UnauthorizedException('Invalid webhook signature');
    }

    try {
      // Find verification by Sumsub applicant ID
      const verification = await this.prisma.kyc_verifications.findUnique({
        where: { sumsub_applicant_id: payload.applicantId },
        include: { user: true },
      });

      if (!verification) {
        this.logger.warn(`No verification found for applicant: ${payload.applicantId}`);
        return { success: true }; // Return success to avoid retries
      }

      this.logger.log(`   Found verification: ${verification.kyc_id}`);
      this.logger.log(`   User: ${verification.user.email}`);

      // Handle different webhook types
      switch (payload.type) {
        case 'applicantReviewed':
          await this.handleApplicantReviewed(verification.kyc_id, payload);
          break;
        case 'applicantPending':
          await this.handleApplicantPending(verification.kyc_id, payload);
          break;
        case 'applicantOnHold':
          await this.handleApplicantOnHold(verification.kyc_id, payload);
          break;
        default:
          this.logger.log(`   Unhandled webhook type: ${payload.type}`);
      }

      this.logger.log('✅ [WEBHOOK] Processed successfully');
      this.logger.log('');
      return { success: true };
    } catch (error) {
      this.logger.error(`❌ [WEBHOOK] Error processing: ${error.message}`);
      throw error;
    }
  }

  private verifySignature(payload: any, signature: string): boolean {
    if (!signature) {
      this.logger.warn('No signature provided in webhook');
      return false;
    }

    try {
      const payloadString = JSON.stringify(payload);
      return this.sumsubService.verifyWebhookSignature(payloadString, signature);
    } catch (error) {
      this.logger.error(`Signature verification error: ${error.message}`);
      return false;
    }
  }

  private async handleApplicantReviewed(
    kycId: string,
    payload: SumsubWebhookPayload,
  ): Promise<void> {
    this.logger.log('   📋 Handling applicantReviewed event');

    if (!payload.reviewResult) {
      this.logger.warn('   No reviewResult in payload');
      return;
    }

    const reviewAnswer = payload.reviewResult.reviewAnswer;
    const kycStatus = this.sumsubService.parseReviewResult(reviewAnswer);

    this.logger.log(`   Review Answer: ${reviewAnswer} → KYC Status: ${kycStatus}`);

    let decisionReason = `Sumsub review completed: ${reviewAnswer}`;
    if (payload.reviewResult.moderationComment) {
      decisionReason += ` - ${payload.reviewResult.moderationComment}`;
    }
    if (payload.reviewResult.rejectLabels && payload.reviewResult.rejectLabels.length > 0) {
      decisionReason += ` (Reject labels: ${payload.reviewResult.rejectLabels.join(', ')})`;
    }

    // Update verification
    await this.prisma.kyc_verifications.update({
      where: { kyc_id: kycId },
      data: {
        status: kycStatus as any,
        decision_reason: decisionReason,
        sumsub_review_result: payload.reviewResult as any,
        sumsub_review_status: payload.reviewStatus,
      },
    });

    // Update user KYC status if approved
    if (kycStatus === 'approved') {
      const verification = await this.prisma.kyc_verifications.findUnique({
        where: { kyc_id: kycId },
      });

      if (verification) {
        await this.prisma.users.update({
          where: { user_id: verification.user_id },
          data: { kyc_status: 'approved' },
        });
        this.logger.log('   ✅ User KYC status updated to APPROVED');
      }
    }

    this.logger.log(`   ✅ Verification updated to: ${kycStatus.toUpperCase()}`);
  }

  private async handleApplicantPending(
    kycId: string,
    payload: SumsubWebhookPayload,
  ): Promise<void> {
    this.logger.log('   ⏳ Handling applicantPending event');

    await this.prisma.kyc_verifications.update({
      where: { kyc_id: kycId },
      data: {
        status: 'pending',
        decision_reason: 'Under review by Sumsub',
        sumsub_review_status: payload.reviewStatus,
      },
    });

    this.logger.log('   ✅ Status updated to PENDING');
  }

  private async handleApplicantOnHold(
    kycId: string,
    payload: SumsubWebhookPayload,
  ): Promise<void> {
    this.logger.log('   ⚠️  Handling applicantOnHold event');

    await this.prisma.kyc_verifications.update({
      where: { kyc_id: kycId },
      data: {
        status: 'review',
        decision_reason: 'Verification on hold - additional information may be required',
        sumsub_review_status: payload.reviewStatus,
      },
    });

    this.logger.log('   ✅ Status updated to REVIEW (on hold)');
  }
}
