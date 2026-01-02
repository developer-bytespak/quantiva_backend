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
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { memoryStorage } from 'multer';

// Multer configuration for file uploads
const MAX_FILE_SIZE = parseInt(process.env.KYC_MAX_FILE_SIZE || '10485760', 10); // 10MB default

const fileUploadOptions = {
  storage: memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE,
  },
};
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
  private readonly logger = new Logger(KycController.name);

  constructor(
    private readonly kycService: KycService,
    private readonly reviewService: ReviewService,
    private readonly configService: ConfigService,
  ) {}

  @Post('documents')
  @UseInterceptors(FileInterceptor('file', fileUploadOptions))
  async uploadDocument(
    @CurrentUser() user: TokenPayload,
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadDocumentDto,
  ) {
    const requestStartTime = Date.now();
    console.log('=== DOCUMENT UPLOAD STARTED ===');
    console.log(`[DOCUMENT_UPLOAD_START] User ID: ${user.sub}`);
    console.log(`[DOCUMENT_UPLOAD_START] File: ${file?.originalname || 'unknown'}`);
    console.log(`[DOCUMENT_UPLOAD_START] Document Type: ${dto.document_type || 'not specified'}`);
    console.log(`[DOCUMENT_UPLOAD_START] Timestamp: ${new Date().toISOString()}`);
    this.logger.log(`[DOCUMENT_UPLOAD_START] User ${user.sub} uploading document: ${file?.originalname || 'unknown'}`);
    
    if (!file) {
      console.error('[DOCUMENT_UPLOAD_ERROR] No file provided in upload request');
      this.logger.warn('Upload document: No file provided');
      throw new BadRequestException('UPLOAD_ERROR: No file was provided. Please select a document image to upload.');
    }

    this.logger.debug(
      `File received - Name: ${file.originalname}, Size: ${file.size}, Buffer length: ${file.buffer?.length || 0}, MIME: ${file.mimetype}`,
    );

    if (!file.buffer || file.buffer.length === 0) {
      this.logger.error(
        `File buffer is empty - Name: ${file.originalname}, Size: ${file.size}, Buffer: ${file.buffer ? 'exists but empty' : 'null'}`,
      );
      throw new BadRequestException('UPLOAD_ERROR: File data is empty or corrupt. The file may not have been uploaded completely. Please try again.');
    }

    if (file.size > MAX_FILE_SIZE) {
      this.logger.warn(`File size exceeds limit: ${file.size} > ${MAX_FILE_SIZE}`);
      throw new BadRequestException(`UPLOAD_ERROR: File is too large (${(file.size / 1024 / 1024).toFixed(2)}MB). Maximum file size is ${(MAX_FILE_SIZE / 1024 / 1024).toFixed(2)}MB.`);
    }

    if (!file.mimetype || !['image/jpeg', 'image/png', 'image/jpg'].includes(file.mimetype)) {
      this.logger.warn(`Invalid file format: ${file.mimetype}`);
      throw new BadRequestException(`UPLOAD_ERROR: Invalid file format (${file.mimetype}). Please upload a JPEG or PNG image.`);
    }

    const uploadStartTime = Date.now();
    console.log(`[DOCUMENT_UPLOAD_PROCESSING] Starting document save and processing...`);
    const documentId = await this.kycService.uploadDocument(user.sub, file, dto.document_type);
    const uploadTime = Date.now() - uploadStartTime;
    
    const totalTime = Date.now() - requestStartTime;
    console.log(`[DOCUMENT_UPLOAD_SUCCESS] Document uploaded successfully!`);
    console.log(`  - Document ID: ${documentId}`);
    console.log(`  - Upload time: ${uploadTime}ms`);
    console.log(`  - Total time: ${totalTime}ms`);
    console.log(`  - OCR and authenticity checks are now running in Python service...`);
    console.log('=== DOCUMENT UPLOAD COMPLETED ===\n');
    this.logger.log(`[DOCUMENT_UPLOAD_COMPLETE] Document uploaded in ${totalTime}ms (upload: ${uploadTime}ms). OCR and authenticity checks running in background.`);

    return {
      success: true,
      document_id: documentId,
      message: 'Document uploaded successfully. ID verification and authenticity checks are running in the background.',
      timing: {
        total_ms: totalTime,
        upload_ms: uploadTime,
      }
    };
  }

  @Post('selfie')
  @UseInterceptors(FileInterceptor('file', fileUploadOptions))
  async uploadSelfie(
    @CurrentUser() user: TokenPayload,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const requestStartTime = Date.now();
    console.log('=== SELFIE UPLOAD STARTED ===');
    console.log(`[SELFIE_UPLOAD_START] User ID: ${user.sub}`);
    console.log(`[SELFIE_UPLOAD_START] File: ${file?.originalname || 'unknown'}`);
    console.log(`[SELFIE_UPLOAD_START] Timestamp: ${new Date().toISOString()}`);
    this.logger.log(`[SELFIE_UPLOAD_START] User ${user.sub} uploading selfie: ${file?.originalname || 'unknown'}`);
    
    if (!file) {
      console.error('[SELFIE_UPLOAD_ERROR] No file provided in upload request');
      this.logger.warn('Upload selfie: No file provided');
      throw new BadRequestException('SELFIE_UPLOAD_ERROR: No file was provided. Please take a selfie photo and try again.');
    }

    this.logger.debug(
      `File received - Name: ${file.originalname}, Size: ${file.size}, Buffer length: ${file.buffer?.length || 0}, MIME: ${file.mimetype}`,
    );

    if (!file.buffer || file.buffer.length === 0) {
      this.logger.error(
        `File buffer is empty - Name: ${file.originalname}, Size: ${file.size}, Buffer: ${file.buffer ? 'exists but empty' : 'null'}`,
      );
      throw new BadRequestException('SELFIE_UPLOAD_ERROR: File data is empty or corrupt. The file may not have been uploaded completely. Please try again.');
    }

    if (file.size > MAX_FILE_SIZE) {
      this.logger.warn(`File size exceeds limit: ${file.size} > ${MAX_FILE_SIZE}`);
      throw new BadRequestException(`SELFIE_UPLOAD_ERROR: File is too large (${(file.size / 1024 / 1024).toFixed(2)}MB). Maximum file size is ${(MAX_FILE_SIZE / 1024 / 1024).toFixed(2)}MB.`);
    }

    if (!file.mimetype || !['image/jpeg', 'image/png', 'image/jpg'].includes(file.mimetype)) {
      this.logger.warn(`Invalid file format: ${file.mimetype}`);
      throw new BadRequestException(`SELFIE_UPLOAD_ERROR: Invalid file format (${file.mimetype}). Please upload a JPEG or PNG image.`);
    }

    try {
      const processingStartTime = Date.now();
      console.log(`[SELFIE_UPLOAD_PROCESSING] Starting liveness detection and face matching...`);
      await this.kycService.uploadSelfie(user.sub, file);
      const processingTime = Date.now() - processingStartTime;

      const totalTime = Date.now() - requestStartTime;
      console.log(`[SELFIE_UPLOAD_SUCCESS] Selfie processed successfully!`);
      console.log(`  - Processing time: ${processingTime}ms`);
      console.log(`  - Total time: ${totalTime}ms`);
      console.log(`  - Face matching and decision engine completed`);
      console.log('=== SELFIE UPLOAD COMPLETED ===\n');
      this.logger.log(`[SELFIE_UPLOAD_COMPLETE] Selfie uploaded in ${totalTime}ms (processing: ${processingTime}ms). Face matching and decision engine running in background.`);

      return {
        success: true,
        message: 'Selfie uploaded and verified successfully',
        timing: {
          total_ms: totalTime,
          processing_ms: processingTime,
        }
      };
    } catch (error: any) {
      const totalTime = Date.now() - requestStartTime;
      console.error(`[SELFIE_UPLOAD_ERROR] Selfie upload failed after ${totalTime}ms`);
      console.error(`  - User ID: ${user.sub}`);
      console.error(`  - Error: ${error?.message}`);
      console.error(`  - Stack: ${error?.stack}`);
      console.error('=== SELFIE UPLOAD FAILED ===\n');
      this.logger.error('Selfie upload failed', {
        userId: user.sub,
        error: error?.message,
        stack: error?.stack,
        elapsed_ms: totalTime,
      });
      
      // Return specific error message based on error type
      const errorMessage = error?.message || 'Failed to process selfie';
      if (errorMessage.includes('face') || errorMessage.includes('Face')) {
        throw new BadRequestException(`FACE_MATCHING_ERROR: ${errorMessage}. Please ensure your face is clearly visible and well-lit.`);
      } else if (errorMessage.includes('timeout') || errorMessage.includes('Timeout')) {
        throw new BadRequestException(`PROCESSING_TIMEOUT: Face verification is taking too long. Please try again with a clearer image.`);
      } else if (errorMessage.includes('quality') || errorMessage.includes('Quality')) {
        throw new BadRequestException(`IMAGE_QUALITY_ERROR: ${errorMessage}. Please ensure the image is clear and in focus.`);
      } else {
        throw new BadRequestException(`SELFIE_VERIFICATION_ERROR: ${errorMessage}. Please check that your images are clear and contain visible faces.`);
      }
    }
  }

  @Post('submit')
  async submitVerification(@CurrentUser() user: TokenPayload) {
    try {
      const startTime = Date.now();
      this.logger.log(`[SUBMIT_START] User ${user.sub} submitting KYC verification`);
      
      await this.kycService.submitVerification(user.sub);
      
      const elapsed = Date.now() - startTime;
      this.logger.log(`[SUBMIT_COMPLETE] KYC submission completed in ${elapsed}ms. Decision engine running in background.`);

      return {
        success: true,
        message: 'KYC verification submitted successfully. Your application is under review. Check your status for updates.',
        timestamp: new Date().toISOString(),
      };
    } catch (error: any) {
      this.logger.error('KYC submission failed', {
        userId: user.sub,
        error: error?.message,
        stack: error?.stack,
      });
      throw new BadRequestException(
        error?.message || 'SUBMIT_ERROR: Failed to submit KYC verification. Please ensure you have completed all required steps: ID document upload and selfie verification.'
      );
    }
  }

  @Get('status')
  async getStatus(@CurrentUser() user: TokenPayload) {
    try {
      const status = await this.kycService.getStatus(user.sub);
      return status;
    } catch (error: any) {
      this.logger.error('Failed to get KYC status', {
        userId: user.sub,
        error: error?.message,
      });
      throw new BadRequestException(
        `STATUS_ERROR: Unable to retrieve KYC verification status. Error: ${error?.message || 'Unknown error'}`
      );
    }
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
      throw new BadRequestException('REVIEW_ERROR: Rejection reason is required. Please provide a specific reason for rejecting this KYC verification.');
    }

    try {
      await this.reviewService.reject(kycId, dto.reason);
      return {
        success: true,
        message: 'KYC verification rejected',
      };
    } catch (error: any) {
      this.logger.error('KYC rejection failed', { kycId, error: error?.message });
      throw new BadRequestException(`REVIEW_ERROR: Failed to reject verification. Error: ${error?.message || 'Unknown error'}`);
    }
  }

  @Post('review/:kycId/resubmit')
  // TODO: Add RolesGuard and @Roles('admin') when roles are implemented
  async requestResubmit(
    @Param('kycId', ParseUUIDPipe) kycId: string,
    @Body() dto: ReviewDecisionDto,
  ) {
    if (!dto.reason) {
      throw new BadRequestException('REVIEW_ERROR: Resubmission reason is required. Please specify what needs to be resubmitted.');
    }

    try {
      await this.reviewService.requestResubmit(kycId, dto.reason);
      return {
        success: true,
        message: 'Resubmission requested',
      };
    } catch (error: any) {
      this.logger.error('Resubmission request failed', { kycId, error: error?.message });
      throw new BadRequestException(`REVIEW_ERROR: Failed to request resubmission. Error: ${error?.message || 'Unknown error'}`);
    }
  }

  @Get('review/pending')
  // TODO: Add RolesGuard and @Roles('admin') when roles are implemented
  async getPendingReviews() {
    try {
      const reviews = await this.reviewService.getPendingReviews();
      return reviews;
    } catch (error: any) {
      this.logger.error('Failed to fetch pending reviews', { error: error?.message });
      throw new BadRequestException(`REVIEW_ERROR: Unable to retrieve pending reviews. Error: ${error?.message || 'Unknown error'}`);
    }
  }
}

