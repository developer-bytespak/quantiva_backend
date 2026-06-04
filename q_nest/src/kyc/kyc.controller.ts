import {
  Controller,
  Post,
  Get,
  UseGuards,
  Param,
  Body,
  ParseUUIDPipe,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KycService } from './services/kyc.service';
import { ReviewService } from './services/review.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReviewDecisionDto } from './dto/review-decision.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../modules/auth/guards/jwt-auth.guard';
import { TokenPayload } from '../modules/auth/services/token.service';

@Controller('kyc')
@UseGuards(JwtAuthGuard)
export class KycController {
  private readonly logger = new Logger(KycController.name);

  constructor(
    private readonly kycService: KycService,
    private readonly reviewService: ReviewService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('sdk-token')
  async getSdkToken(@CurrentUser() user: TokenPayload) {
    const tokenData = await this.kycService.generateSdkToken(user.sub);
    return {
      success: true,
      token: tokenData.token,
      userId: tokenData.userId,
    };
  }

  @Post('submit')
  async submitVerification(@CurrentUser() user: TokenPayload) {
    await this.kycService.submitVerification(user.sub);

    return {
      success: true,
      message: 'KYC verification submitted successfully',
    };
  }

  @Get('status')
  async getStatus(@CurrentUser() user: TokenPayload) {
    const status = await this.kycService.getStatus(user.sub);
    return status;
  }

  @Get('verification/:kycId')
  async getVerificationDetails(@Param('kycId', ParseUUIDPipe) kycId: string) {
    const verification = await this.kycService.getVerificationDetails(kycId);
    return verification;
  }

  // Admin endpoints for manual review
  @Post('review/:kycId/approve')
  // TODO: Add RolesGuard and @Roles('admin') when roles are implemented
  async approveReview(
    @Param('kycId', ParseUUIDPipe) kycId: string,
    @Body() dto: ReviewDecisionDto,
  ) {
    await this.reviewService.approve(kycId, dto.reason);
    return {
      success: true,
      message: 'KYC verification approved',
    };
  }

  @Post('review/:kycId/reject')
  // TODO: Add RolesGuard and @Roles('admin') when roles are implemented
  async rejectReview(
    @Param('kycId', ParseUUIDPipe) kycId: string,
    @Body() dto: ReviewDecisionDto,
  ) {
    if (!dto.reason) {
      throw new Error('Reason is required for rejection');
    }

    await this.reviewService.reject(kycId, dto.reason);
    return {
      success: true,
      message: 'KYC verification rejected',
    };
  }

  @Post('review/:kycId/resubmit')
  // TODO: Add RolesGuard and @Roles('admin') when roles are implemented
  async requestResubmit(
    @Param('kycId', ParseUUIDPipe) kycId: string,
    @Body() dto: ReviewDecisionDto,
  ) {
    if (!dto.reason) {
      throw new Error('Reason is required for resubmission request');
    }

    await this.reviewService.requestResubmit(kycId, dto.reason);
    return {
      success: true,
      message: 'Resubmission requested',
    };
  }

  @Get('review/pending')
  // TODO: Add RolesGuard and @Roles('admin') when roles are implemented
  async getPendingReviews() {
    const reviews = await this.reviewService.getPendingReviews();
    return reviews;
  }

  @Get('debug/sumsub/:applicantId')
  // Debug endpoint to check Sumsub applicant details
  async getSumsubApplicantDetails(@Param('applicantId') applicantId: string): Promise<any> {
    this.logger.log(`Fetching Sumsub details for applicant: ${applicantId}`);
    
    try {
      const [applicantStatus, requiredDocStatus] = await Promise.all([
        this.kycService.getSumsubService().getApplicantStatus(applicantId),
        this.kycService.getSumsubService().getRequiredDocStatus(applicantId),
      ]);

      // Also fetch what documents we have in our database for this applicant
      const verification = await this.prisma.kyc_verifications.findFirst({
        where: { sumsub_applicant_id: applicantId },
      });

      const analysis = {
        sumsub_identity_images: requiredDocStatus?.IDENTITY?.imageIds?.length || 0,
        sumsub_attempt_id: requiredDocStatus?.IDENTITY?.attemptId || 'N/A',
        issue: null as string | null,
      };

      return {
        applicant_id: applicantId,
        analysis,
        verification_status: verification?.status || 'N/A',
        sumsub_applicant_status: applicantStatus,
        sumsub_required_doc_status: requiredDocStatus,
      };
    } catch (error) {
      this.logger.error(`Error fetching Sumsub details: ${error.message}`);
      throw error;
    }
  }

  @Post('debug/reset-applicant/:applicantId')
  // Debug endpoint to manually reset a Sumsub applicant
  async resetSumsubApplicant(@Param('applicantId') applicantId: string): Promise<any> {
    this.logger.log(`Manually resetting Sumsub applicant: ${applicantId}`);
    
    try {
      await this.kycService.getSumsubService().resetApplicant(applicantId);
      
      // Update verification status
      await this.prisma.kyc_verifications.updateMany({
        where: { sumsub_applicant_id: applicantId },
        data: {
          status: 'pending',
          decision_reason: 'Manually reset for resubmission',
        },
      });

      return {
        success: true,
        message: 'Applicant reset successfully. All documents cleared. Ready for fresh upload.',
        applicant_id: applicantId,
      };
    } catch (error) {
      this.logger.error(`Error resetting applicant: ${error.message}`);
      throw error;
    }
  }

  @Post('documents/clear')
  // Clear all documents and reset for fresh upload (useful after rejection)
  async clearAllDocuments(@CurrentUser() user: TokenPayload) {
    this.logger.log(`Clearing all documents for user: ${user.sub}`);
    
    const verification = await this.kycService.getVerificationForUser(user.sub);
    if (!verification) {
      throw new NotFoundException('No KYC verification found');
    }

    // Reset Sumsub applicant if exists
    if (verification.sumsub_applicant_id) {
      this.logger.log(`🔄 Resetting Sumsub applicant: ${verification.sumsub_applicant_id}`);
      await this.kycService.getSumsubService().resetApplicant(verification.sumsub_applicant_id);
      this.logger.log(`✅ Sumsub applicant reset successful: ${verification.sumsub_applicant_id}`);
    }

    // Update verification status
    await this.prisma.kyc_verifications.update({
      where: { kyc_id: verification.kyc_id },
      data: {
        status: 'pending',
        decision_reason: 'Documents cleared, ready for resubmission',
      },
    });

    return {
      success: true,
      message: 'All documents cleared successfully. Ready for fresh upload.',
      deleted_documents: 0,
      kyc_id: verification.kyc_id,
    };
  }
}

