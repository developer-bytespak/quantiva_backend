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
  NotFoundException,
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
import { PrismaService } from '../prisma/prisma.service';
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
    private readonly prisma: PrismaService,
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

  @Get('documents')
  async getAllDocuments(@CurrentUser() user: TokenPayload) {
    this.logger.log(`Fetching all documents for user: ${user.sub}`);
    
    const verification = await this.kycService.getVerificationForUser(user.sub);
    if (!verification) {
      throw new NotFoundException('No KYC verification found');
    }

    // Fetch all documents from database
    const documents = await this.prisma.kyc_documents.findMany({
      where: { kyc_id: verification.kyc_id },
      orderBy: [
        { document_type: 'asc' },
        { document_side: 'asc' },
        { uploaded_at: 'desc' },
      ],
      select: {
        document_id: true,
        document_type: true,
        document_side: true,
        is_primary: true,
        storage_url: true,
        uploaded_at: true,
        file_size: true,
        file_type: true,
      },
    });

    return {
      kyc_id: verification.kyc_id,
      sumsub_applicant_id: verification.sumsub_applicant_id,
      total_documents: documents.length,
      documents,
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
        include: {
          documents: {
            select: {
              document_id: true,
              document_type: true,
              document_side: true,
              is_primary: true,
              created_at: true,
            },
            orderBy: [
              { document_type: 'asc' },
              { document_side: 'asc' },
            ],
          },
        },
      });

      const analysis = {
        database_docs_count: verification?.documents?.length || 0,
        sumsub_identity_images: requiredDocStatus?.IDENTITY?.imageIds?.length || 0,
        sumsub_attempt_id: requiredDocStatus?.IDENTITY?.attemptId || 'N/A',
        issue: null as string | null,
      };

      // Detect issues
      if (analysis.database_docs_count === 2 && analysis.sumsub_identity_images === 1) {
        analysis.issue = 'DATABASE HAS 2 DOCS BUT SUMSUB ONLY HAS 1 IMAGE - Both uploads did not reach Sumsub';
      } else if (analysis.database_docs_count > analysis.sumsub_identity_images) {
        analysis.issue = `DATABASE HAS ${analysis.database_docs_count} DOCS BUT SUMSUB HAS ${analysis.sumsub_identity_images} IMAGES`;
      }

      return {
        applicant_id: applicantId,
        analysis,
        database_documents: verification?.documents || [],
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

    // Delete all documents from database
    const deletedCount = await this.prisma.kyc_documents.deleteMany({
      where: { kyc_id: verification.kyc_id },
    });

    // Reset Sumsub applicant if exists
    if (verification.sumsub_applicant_id) {
      try {
        await this.kycService.getSumsubService().resetApplicant(verification.sumsub_applicant_id);
        this.logger.log(`✅ Sumsub applicant reset: ${verification.sumsub_applicant_id}`);
      } catch (error) {
        this.logger.error(`Failed to reset Sumsub applicant: ${error.message}`);
      }
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
      deleted_documents: deletedCount.count,
      kyc_id: verification.kyc_id,
    };
  }
}

