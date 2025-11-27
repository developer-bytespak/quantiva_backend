import {
  Controller,
  Post,
  Get,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Body,
  Param,
  ParseUUIDPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { KycService } from './services/kyc.service';
import { ReviewService } from './services/review.service';
import { UploadDocumentDto } from './dto/upload-document.dto';
import { UploadSelfieDto } from './dto/upload-selfie.dto';
import { ReviewDecisionDto } from './dto/review-decision.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../modules/auth/guards/jwt-auth.guard';
import { TokenPayload } from '../modules/auth/services/token.service';

@Controller('kyc')
@UseGuards(JwtAuthGuard)
export class KycController {
  constructor(
    private readonly kycService: KycService,
    private readonly reviewService: ReviewService,
  ) {}

  @Post('documents')
  @UseInterceptors(FileInterceptor('file'))
  async uploadDocument(
    @CurrentUser() user: TokenPayload,
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadDocumentDto,
  ) {
    if (!file) {
      throw new Error('File is required');
    }

    const documentId = await this.kycService.uploadDocument(user.sub, file, dto.document_type);

    return {
      success: true,
      document_id: documentId,
      message: 'Document uploaded successfully',
    };
  }

  @Post('selfie')
  @UseInterceptors(FileInterceptor('file'))
  async uploadSelfie(
    @CurrentUser() user: TokenPayload,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new Error('File is required');
    }

    await this.kycService.uploadSelfie(user.sub, file);

    return {
      success: true,
      message: 'Selfie uploaded and verified successfully',
    };
  }

  @Post('submit')
  async submitVerification(@CurrentUser() user: TokenPayload) {
    await this.kycService.submitVerification(user.sub);

    return {
      success: true,
      message: 'KYC verification submitted',
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
}

