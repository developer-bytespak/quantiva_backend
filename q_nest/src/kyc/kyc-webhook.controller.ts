import {
  Controller,
  Post,
  Body,
  Headers,
  Logger,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { SumsubService } from './integrations/sumsub.service';
import { KycEmailService } from './services/kyc-email.service';

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

interface SumsubWebhookPayload {
  applicantId: string;
  inspectionId: string;
  correlationId: string;
  externalUserId: string;
  levelName?: string;
  type: string;
  reviewResult?: {
    reviewAnswer: string; // GREEN, RED, YELLOW
    rejectLabels?: string[];
    reviewRejectType?: string; // FINAL, RETRY
    moderationComment?: string;
    clientComment?: string;
    buttonIds?: string[];
  };
  reviewStatus: string; // init, pending, completed, onHold
  sandboxMode?: boolean;
  createdAtMs: string;
  clientId?: string;
}

@Controller('kyc/webhooks')
export class KycWebhookController {
  private readonly logger = new Logger(KycWebhookController.name);

  constructor(
    private prisma: PrismaService,
    private sumsubService: SumsubService,
    private kycEmailService: KycEmailService,
  ) {}

  @Post('sumsub')
  @HttpCode(HttpStatus.OK)
  async handleSumsubWebhook(
    @Req() req: RawBodyRequest,
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

    // Verify webhook signature using the raw request body (not re-serialized JSON)
    if (!this.verifySignature(req, signature)) {
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
        case 'applicantPrechecked':
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

  private verifySignature(req: RawBodyRequest, signature: string): boolean {
    if (!signature) {
      this.logger.warn('No signature provided in webhook');
      return false;
    }

    try {
      // Use the raw body buffer preserved by the verify callback in main.ts.
      // This ensures the HMAC is computed on the exact bytes Sumsub sent,
      // rather than a re-serialized JSON string which may differ in key
      // ordering, whitespace, or unicode escaping.
      const rawBody = req.rawBody;
      if (!rawBody) {
        this.logger.error('Raw body not available — ensure json({ verify }) middleware is configured');
        return false;
      }
      return this.sumsubService.verifyWebhookSignature(rawBody, signature);
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
    const reviewRejectType = payload.reviewResult.reviewRejectType || null;

    this.logger.log(`   Review Answer: ${reviewAnswer} → KYC Status: ${kycStatus}`);
    if (reviewRejectType) {
      this.logger.log(`   Reject Type: ${reviewRejectType}`);
    }

    let decisionReason = `Sumsub review completed: ${reviewAnswer}`;
    if (payload.reviewResult.moderationComment) {
      decisionReason += ` - ${payload.reviewResult.moderationComment}`;
    }
    if (payload.reviewResult.rejectLabels && payload.reviewResult.rejectLabels.length > 0) {
      decisionReason += ` (Reject labels: ${payload.reviewResult.rejectLabels.join(', ')})`;
    }

    // Update verification (including review_reject_type for RETRY/FINAL distinction)
    const verification = await this.prisma.kyc_verifications.update({
      where: { kyc_id: kycId },
      data: {
        status: kycStatus as any,
        decision_reason: decisionReason,
        sumsub_review_result: payload.reviewResult as any,
        sumsub_review_status: payload.reviewStatus,
        review_reject_type: reviewRejectType,
      },
      include: { user: true },
    });

    // Update user KYC status for ALL outcomes so flow-router and dashboard see the truth
    await this.prisma.users.update({
      where: { user_id: verification.user_id },
      data: { kyc_status: kycStatus as any },
    });
    this.logger.log(`   ✅ User KYC status updated to ${kycStatus.toUpperCase()}`);

    // Fire email notification based on final outcome
    try {
      const user = verification.user;
      if (kycStatus === 'approved') {
        await this.kycEmailService.sendApprovedEmail(user.email, user.username);
      } else if (kycStatus === 'rejected') {
        const buttonIds = payload.reviewResult.buttonIds || [];
        const humanReasons = buttonIds.map((b) => this.sumsubService.getRejectionReasonLabel(b));
        if (reviewRejectType === 'FINAL') {
          await this.kycEmailService.sendFinalRejectionEmail(user.email, user.username, humanReasons);
        } else {
          await this.kycEmailService.sendRetryRejectionEmail(user.email, user.username, humanReasons);
        }
      }
    } catch (emailError) {
      this.logger.warn(`Failed to send KYC email notification: ${emailError.message}`);
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
