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
import { DocumentService } from './services/document.service';
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
    private readonly documentService: DocumentService,
    private readonly configService: ConfigService,
  ) {}

  @Post('documents')
  @UseInterceptors(FileInterceptor('file', fileUploadOptions))
  async uploadDocument(
    @CurrentUser() user: TokenPayload,
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadDocumentDto,
  ) {
    this.logger.debug(`Upload document request - User: ${user.sub}, File: ${file?.originalname || 'none'}`);
    
    if (!file) {
      this.logger.warn('Upload document: No file provided');
      throw new BadRequestException('File is required');
    }

    this.logger.debug(
      `File received - Name: ${file.originalname}, Size: ${file.size}, Buffer length: ${file.buffer?.length || 0}, MIME: ${file.mimetype}, Type: ${dto.document_type}, Side: ${dto.document_side || 'N/A'}`,
    );

    if (!file.buffer || file.buffer.length === 0) {
      this.logger.error(
        `File buffer is empty - Name: ${file.originalname}, Size: ${file.size}, Buffer: ${file.buffer ? 'exists but empty' : 'null'}`,
      );
      throw new BadRequestException('File buffer is empty. Please ensure the file was uploaded correctly.');
    }

    const documentId = await this.kycService.uploadDocument(user.sub, file, dto.document_type, dto.document_side);

    return {
      success: true,
      document_id: documentId,
      message: 'Document uploaded successfully',
    };
  }

  @Post('selfie')
  @UseInterceptors(FileInterceptor('file', fileUploadOptions))
  async uploadSelfie(
    @CurrentUser() user: TokenPayload,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const requestStart = Date.now();
    this.logger.log('');
    this.logger.log('████████████████████████████████████████████████████████████████████');
    this.logger.log('█  🚀 [CONTROLLER] POST /kyc/selfie - REQUEST RECEIVED             █');
    this.logger.log('████████████████████████████████████████████████████████████████████');
    this.logger.log(`   Timestamp: ${new Date().toISOString()}`);
    this.logger.log(`   User: ${user.sub}`);
    this.logger.log(`   File: ${file?.originalname || 'none'} (${file?.size || 0} bytes)`);
    
    if (!file) {
      this.logger.warn('Upload selfie: No file provided');
      throw new BadRequestException('File is required');
    }

    this.logger.log(`   Buffer length: ${file.buffer?.length || 0}, MIME: ${file.mimetype}`);

    if (!file.buffer || file.buffer.length === 0) {
      this.logger.error(`   ❌ File buffer is empty!`);
      throw new BadRequestException('File buffer is empty. Please ensure the file was uploaded correctly.');
    }

    try {
      this.logger.log('   📞 Calling kycService.uploadSelfie()...');
      const serviceStart = Date.now();
      
      await this.kycService.uploadSelfie(user.sub, file);
      
      const serviceTime = Date.now() - serviceStart;
      const totalTime = Date.now() - requestStart;
      
      this.logger.log('');
      this.logger.log('████████████████████████████████████████████████████████████████████');
      this.logger.log('█  ✅ [CONTROLLER] POST /kyc/selfie - SUCCESS                      █');
      this.logger.log('████████████████████████████████████████████████████████████████████');
      this.logger.log(`   Service time: ${serviceTime}ms (${(serviceTime/1000).toFixed(2)}s)`);
      this.logger.log(`   Total request time: ${totalTime}ms (${(totalTime/1000).toFixed(2)}s)`);
      this.logger.log('');

      return {
        success: true,
        message: 'Selfie uploaded and verified successfully',
      };
    } catch (error: any) {
      const totalTime = Date.now() - requestStart;
      this.logger.error('');
      this.logger.error('████████████████████████████████████████████████████████████████████');
      this.logger.error(`█  ❌ [CONTROLLER] POST /kyc/selfie - FAILED after ${totalTime}ms`);
      this.logger.error('████████████████████████████████████████████████████████████████████');
      this.logger.error(`   Error: ${error?.message}`);
      
      throw new BadRequestException(
        error?.message || 'Failed to process selfie. Please ensure the image is clear and contains a visible face.',
      );
    }
  }

  @Post('submit')
  async submitVerification(@CurrentUser() user: TokenPayload) {
    await this.kycService.submitVerification(user.sub);

    return {
      success: true,
      message: 'KYC verification submitted successfully',
    };
  }

  @Get('documents/status/:documentType')
  async getDocumentStatus(
    @CurrentUser() user: TokenPayload,
    @Param('documentType') documentType: string,
  ) {
    this.logger.log(`Checking document status for type: ${documentType}`);
    
    const verification = await this.kycService.getVerificationForUser(user.sub);
    
    if (!verification) {
      return {
        frontUploaded: false,
        backUploaded: false,
        isComplete: false,
      };
    }

    return this.documentService.getDocumentUploadStatus(verification.kyc_id, documentType);
  }

  @Get('documents/completeness')
  async checkCompleteness(@CurrentUser() user: TokenPayload) {
    this.logger.log(`Checking document completeness for user: ${user.sub}`);
    return this.kycService.checkDocumentCompleteness(user.sub);
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

