import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentService } from './document.service';
import { FaceMatchingService } from './face-matching.service';
import { DecisionEngineService } from './decision-engine.service';

@Injectable()
export class KycService {
  private readonly logger = new Logger(KycService.name);

  constructor(
    private prisma: PrismaService,
    private documentService: DocumentService,
    private faceMatchingService: FaceMatchingService,
    private decisionEngine: DecisionEngineService,
    private configService: ConfigService,
  ) {}

  async createVerification(userId: string): Promise<string> {
    const verification = await this.prisma.kyc_verifications.create({
      data: {
        user_id: userId,
        status: 'pending',
      },
    });

    return verification.kyc_id;
  }

  async uploadDocument(
    userId: string,
    file: Express.Multer.File,
    documentType?: string,
  ): Promise<string> {
    const startTime = Date.now();
    console.log(`[KYC_SERVICE_DOC] Starting document upload process for user: ${userId}`);
    console.log(`[KYC_SERVICE_DOC] Document type: ${documentType || 'not specified'}`);
    console.log(`[KYC_SERVICE_DOC] File: ${file.originalname} (${file.size} bytes)`);
    this.logger.log(`[UPLOAD_DOCUMENT_START] Starting document processing for user ${userId}`);
    
    // Get or create verification
    const verificationStartTime = Date.now();
    console.log(`[KYC_SERVICE_DOC] Looking for existing KYC verification...`);
    let verification = await this.prisma.kyc_verifications.findFirst({
      where: { user_id: userId },
      orderBy: { kyc_id: 'desc' },
    });
    const verificationTime = Date.now() - verificationStartTime;
    
    if (verification) {
      console.log(`[KYC_SERVICE_DOC] Found existing verification: ${verification.kyc_id} (retrieved in ${verificationTime}ms)`);
      console.log(`[KYC_SERVICE_DOC] Current status: ${verification.status}`);
    }
    this.logger.log(`[UPLOAD_DOCUMENT_STEP_1] Retrieved/created verification in ${verificationTime}ms`);

    if (!verification) {
      console.log(`[KYC_SERVICE_DOC] No existing verification found, creating new one...`);
      const createStartTime = Date.now();
      const kycId = await this.createVerification(userId);
      verification = await this.prisma.kyc_verifications.findUnique({
        where: { kyc_id: kycId },
      });
      const createTime = Date.now() - createStartTime;
      console.log(`[KYC_SERVICE_DOC] Created new verification: ${kycId} (in ${createTime}ms)`);
      this.logger.log(`[UPLOAD_DOCUMENT_STEP_1_CREATED] Created new verification in ${createTime}ms`);
    }

    if (!verification) {
      console.error(`[KYC_SERVICE_DOC_ERROR] Failed to create or retrieve KYC verification for user ${userId}`);
      throw new Error('VERIFICATION_ERROR: Failed to create or retrieve KYC verification. Please contact support if this issue persists.');
    }

    const documentUploadStartTime = Date.now();
    console.log(`[KYC_SERVICE_DOC] Starting document save to database and storage...`);
    console.log(`[KYC_SERVICE_DOC] Verification ID: ${verification.kyc_id}`);
    this.logger.log(`[UPLOAD_DOCUMENT_STEP_2] Starting document save...`);
    const documentId = await this.documentService.uploadDocument(verification.kyc_id, file, documentType);
    const documentUploadTime = Date.now() - documentUploadStartTime;
    
    console.log(`[KYC_SERVICE_DOC] Document saved successfully!`);
    console.log(`[KYC_SERVICE_DOC] Document ID: ${documentId}`);
    console.log(`[KYC_SERVICE_DOC] Save time: ${documentUploadTime}ms`);
    console.log(`[KYC_SERVICE_DOC] Background processing (OCR + authenticity) has been triggered`);
    this.logger.log(`[UPLOAD_DOCUMENT_STEP_2_DONE] Document saved in ${documentUploadTime}ms (OCR and authenticity checks running in background)`);
    
    const totalTime = Date.now() - startTime;
    console.log(`[KYC_SERVICE_DOC] Total document upload time: ${totalTime}ms`);
    console.log(`  - Verification lookup/create: ${verificationTime}ms`);
    console.log(`  - Document save + trigger background: ${documentUploadTime}ms`);
    this.logger.log(`[UPLOAD_DOCUMENT_COMPLETE] Document upload completed in ${totalTime}ms (verification: ${verificationTime}ms, save: ${documentUploadTime}ms)`);
    
    return documentId;
  }

  async uploadSelfie(userId: string, file: Express.Multer.File): Promise<void> {
    const startTime = Date.now();
    console.log(`[KYC_SERVICE_SELFIE] Starting selfie processing for user: ${userId}`);
    console.log(`[KYC_SERVICE_SELFIE] File: ${file.originalname} (${file.size} bytes)`);
    this.logger.log(`[UPLOAD_SELFIE_START] Starting selfie processing for user ${userId}`);
    
    // Get verification
    const verificationStartTime = Date.now();
    console.log(`[KYC_SERVICE_SELFIE] Looking for existing KYC verification...`);
    const verification = await this.prisma.kyc_verifications.findFirst({
      where: { user_id: userId },
      orderBy: { kyc_id: 'desc' },
    });
    const verificationTime = Date.now() - verificationStartTime;
    
    if (verification) {
      console.log(`[KYC_SERVICE_SELFIE] Found verification: ${verification.kyc_id} (retrieved in ${verificationTime}ms)`);
      console.log(`[KYC_SERVICE_SELFIE] Current status: ${verification.status}`);
    } else {
      console.error(`[KYC_SERVICE_SELFIE_ERROR] No verification found for user ${userId}`);
    }
    this.logger.log(`[UPLOAD_SELFIE_STEP_1] Retrieved verification in ${verificationTime}ms`);

    if (!verification) {
      console.error(`[KYC_SERVICE_SELFIE_ERROR] User must upload ID document first`);
      throw new Error('NO_VERIFICATION_ERROR: No active KYC verification found. Please upload your ID document first to start the verification process.');
    }

    try {
      // Match faces using Python API
      const faceMatchStartTime = Date.now();
      console.log(`[KYC_SERVICE_SELFIE] Starting liveness detection and face matching...`);
      console.log(`[KYC_SERVICE_SELFIE] This will call Python service for:`)
      console.log(`  1. Liveness detection on selfie`);
      console.log(`  2. Face matching between ID document and selfie`);
      console.log(`  3. Update database with results`);
      this.logger.log(`[UPLOAD_SELFIE_STEP_2] Starting face matching...`);
      await this.faceMatchingService.matchFaces(verification.kyc_id, file);
      const faceMatchTime = Date.now() - faceMatchStartTime;
      
      console.log(`[KYC_SERVICE_SELFIE] Face matching completed successfully!`);
      console.log(`[KYC_SERVICE_SELFIE] Processing time: ${faceMatchTime}ms`);
      this.logger.log(`[UPLOAD_SELFIE_STEP_2_DONE] Face matching completed in ${faceMatchTime}ms`);

      // Run decision engine asynchronously (don't wait for it)
      // This prevents the user from waiting while the decision engine evaluates
      const decisionStartTime = Date.now();
      console.log(`[KYC_SERVICE_SELFIE] Starting decision engine in background...`);
      console.log(`[KYC_SERVICE_SELFIE] Decision engine will automatically approve/reject based on:`)
      console.log(`  - Face match score >= 80%`)
      console.log(`  - Document authenticity >= 75%`)
      this.decisionEngine.applyDecision(verification.kyc_id).then(() => {
        const decisionTime = Date.now() - decisionStartTime;
        console.log(`[KYC_SERVICE_SELFIE] Decision engine completed in background (${decisionTime}ms)`);
        this.logger.log(`[UPLOAD_SELFIE_DECISION_COMPLETE] Decision engine completed in ${decisionTime}ms (ran in background)`);
      }).catch((error) => {
        console.error(`[KYC_SERVICE_SELFIE_ERROR] Decision engine failed:`, error?.message);
        this.logger.error('Decision engine failed', {
          kycId: verification.kyc_id,
          error: error?.message,
        });
      });
      
      const totalTime = Date.now() - startTime;
      console.log(`[KYC_SERVICE_SELFIE] Selfie upload completed successfully!`);
      console.log(`[KYC_SERVICE_SELFIE] Total time: ${totalTime}ms`);
      console.log(`  - Verification lookup: ${verificationTime}ms`);
      console.log(`  - Face matching: ${faceMatchTime}ms`);
      console.log(`  - Decision engine: running in background`);
      this.logger.log(`[UPLOAD_SELFIE_COMPLETE] Selfie upload completed in ${totalTime}ms (verification: ${verificationTime}ms, face match: ${faceMatchTime}ms). Decision engine running in background.`);
    } catch (error: any) {
      const errorTime = Date.now() - startTime;
      console.error(`[KYC_SERVICE_SELFIE_ERROR] Selfie processing failed after ${errorTime}ms`);
      console.error(`  - User ID: ${userId}`);
      console.error(`  - Verification ID: ${verification.kyc_id}`);
      console.error(`  - Error: ${error?.message}`);
      console.error(`  - Stack trace:`, error?.stack);
      this.logger.error('KYC verification step failed', {
        kycId: verification.kyc_id,
        error: error?.message,
        stack: error?.stack,
        elapsed_ms: errorTime,
      });
      // Re-throw with more context
      throw new Error(
        `KYC_VERIFICATION_FAILED: ${error?.message || 'Unknown verification error'}. Please ensure both your ID photo and selfie are clear, well-lit, and show your face clearly. Try using a higher quality image if the first attempt failed.`,
      );
    }
  }

  async submitVerification(userId: string): Promise<void> {
    const verification = await this.prisma.kyc_verifications.findFirst({
      where: { user_id: userId },
      orderBy: { kyc_id: 'desc' },
    });

    if (!verification) {
      throw new Error('SUBMIT_ERROR: No KYC verification found to submit. Please complete ID document upload and selfie verification first.');
    }

    // Run decision engine asynchronously (don't wait for it)
    // This prevents the user from waiting while the decision engine evaluates
    this.decisionEngine.applyDecision(verification.kyc_id).catch((error) => {
      this.logger.error('Decision engine failed during submit', {
        kycId: verification.kyc_id,
        error: error?.message,
      });
    });
  }

  async autoApproveVerification(userId: string): Promise<void> {
    const verification = await this.prisma.kyc_verifications.findFirst({
      where: { user_id: userId },
      orderBy: { kyc_id: 'desc' },
    });

    if (!verification) {
      throw new Error('APPROVAL_ERROR: No KYC verification found to auto-approve. Please ensure the user has started the KYC process.');
    }

    // Update verification to approved status
    await this.prisma.kyc_verifications.update({
      where: { kyc_id: verification.kyc_id },
      data: {
        status: 'approved',
        decision_reason: 'Auto-approved (backend temporarily halted)',
        liveness_result: 'live',
        liveness_confidence: 0.95,
        face_match_score: 0.95,
        doc_authenticity_score: 0.95,
      },
    });

    // Update user's KYC status
    await this.prisma.users.update({
      where: { user_id: userId },
      data: {
        kyc_status: 'approved',
      },
    });
  }

  async getStatus(userId: string) {
    const verification = await this.prisma.kyc_verifications.findFirst({
      where: { user_id: userId },
      include: {
        documents: true,
        face_matches: true,
      },
      orderBy: { kyc_id: 'desc' },
    });

    if (!verification) {
      return {
        status: 'pending',
        kyc_id: null,
      };
    }

    return {
      status: verification.status,
      kyc_id: verification.kyc_id,
      decision_reason: verification.decision_reason,
      liveness_result: verification.liveness_result,
      liveness_confidence: verification.liveness_confidence
        ? Number(verification.liveness_confidence)
        : null,
      face_match_score: verification.face_match_score
        ? Number(verification.face_match_score)
        : null,
      doc_authenticity_score: verification.doc_authenticity_score
        ? Number(verification.doc_authenticity_score)
        : null,
    };
  }

  async getVerificationDetails(kycId: string) {
    return this.prisma.kyc_verifications.findUnique({
      where: { kyc_id: kycId },
      include: {
        user: {
          select: {
            user_id: true,
            email: true,
            username: true,
          },
        },
        documents: true,
        face_matches: true,
      },
    });
  }
}

