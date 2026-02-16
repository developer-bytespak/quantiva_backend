import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentService } from './document.service';
import { FaceMatchingService } from './face-matching.service';
import { DecisionEngineService } from './decision-engine.service';
import { SumsubService } from '../integrations/sumsub.service';

@Injectable()
export class KycService {
  private readonly logger = new Logger(KycService.name);

  constructor(
    private prisma: PrismaService,
    private documentService: DocumentService,
    private faceMatchingService: FaceMatchingService,
    private decisionEngine: DecisionEngineService,
    private configService: ConfigService,
    private sumsubService: SumsubService,
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
    documentSide?: string,
  ): Promise<string> {
    this.logger.log(`📄 [KYC-SERVICE] uploadDocument() - type: ${documentType}, side: ${documentSide || 'N/A'}`);
    
    // Get user info for Sumsub
    const user = await this.prisma.users.findUnique({
      where: { user_id: userId },
    });

    if (!user) {
      throw new Error('User not found');
    }

    // Get or create verification
    let verification = await this.prisma.kyc_verifications.findFirst({
      where: { user_id: userId },
      orderBy: { kyc_id: 'desc' },
    });

    // Create verification record first (even if Sumsub fails later)
    if (!verification) {
      const kycId = await this.createVerification(userId);
      verification = await this.prisma.kyc_verifications.findUnique({
        where: { kyc_id: kycId },
      });
      this.logger.log(`Created verification record: ${kycId}`);
    }

    if (!verification) {
      throw new Error('Failed to create verification');
    }

    // Try to create Sumsub applicant if not already created
    if (!verification.sumsub_applicant_id) {
      try {
        this.logger.log('Creating new Sumsub applicant...');
        const sumsubApplicant = await this.sumsubService.createApplicant(
          userId,
          user.email,
          user.phone_number || undefined,
        );

        // Update verification with Sumsub ID
        verification = await this.prisma.kyc_verifications.update({
          where: { kyc_id: verification.kyc_id },
          data: {
            sumsub_applicant_id: sumsubApplicant.id,
            sumsub_external_user_id: userId,
            verification_provider: 'sumsub',
          },
        });
        this.logger.log(`Sumsub applicant created: ${sumsubApplicant.id}`);
      } catch (error) {
        // Handle 409 Conflict - Applicant already exists in Sumsub
        if (error.status === 409 || error.message?.includes('already exists')) {
          this.logger.warn(`Applicant already exists in Sumsub for user ${userId}, fetching existing...`);
          try {
            const existingApplicant = await this.sumsubService.getApplicantByExternalUserId(userId);
            if (existingApplicant) {
              verification = await this.prisma.kyc_verifications.update({
                where: { kyc_id: verification.kyc_id },
                data: {
                  sumsub_applicant_id: existingApplicant.id,
                  sumsub_external_user_id: userId,
                  verification_provider: 'sumsub',
                },
              });
              this.logger.log(`✅ Linked existing Sumsub applicant: ${existingApplicant.id}`);
            }
          } catch (fetchError) {
            this.logger.error(`Failed to fetch existing applicant: ${fetchError.message}`);
          }
        } else {
          this.logger.error(`Failed to create Sumsub applicant: ${error.message}`);
          this.logger.warn('Continuing with verification record, but Sumsub integration failed');
        }
      }
    }

    // Upload document to Sumsub if applicant exists
    if (verification.sumsub_applicant_id) {
      try {
        this.logger.log('Uploading document to Sumsub...');
        const sumsubDocType = this.mapDocumentType(documentType);
        await this.sumsubService.addDocument(
          verification.sumsub_applicant_id,
          file.buffer,
          file.originalname,
          sumsubDocType,
          user.nationality || undefined,
          documentSide,
        );
        this.logger.log('✅ Document uploaded to Sumsub successfully');
      } catch (error) {
        this.logger.error(`Failed to upload document to Sumsub: ${error.message}`);
        this.logger.warn('📋 Document will need to be uploaded via Sumsub dashboard');
        this.logger.warn(`🔗 Sumsub Applicant ID: ${verification.sumsub_applicant_id}`);
        // Continue anyway - document will be uploaded to Cloudinary
      }
    }

    // Always upload to Cloudinary as backup/audit trail
    return this.documentService.uploadDocument(verification.kyc_id, file, documentType, documentSide);
  }

  private mapDocumentType(documentType?: string): string {
    const typeMap: { [key: string]: string } = {
      passport: 'PASSPORT',
      id_card: 'ID_CARD',
      drivers_license: 'DRIVERS',
    };
    return typeMap[documentType?.toLowerCase() || ''] || 'IDENTITY';
  }

  async uploadSelfie(userId: string, file: Express.Multer.File): Promise<void> {
    const totalStart = Date.now();
    this.logger.log('');
    this.logger.log('╔══════════════════════════════════════════════════════════════════╗');
    this.logger.log('║  🚀 [KYC-SERVICE] uploadSelfie() - REQUEST STARTED (SUMSUB)      ║');
    this.logger.log('╚══════════════════════════════════════════════════════════════════╝');
    this.logger.log(`   User: ${userId}`);
    this.logger.log(`   File: ${file.originalname} (${file.size} bytes)`);
    
    // Step 1: Get verification from DB
    this.logger.log('📋 [KYC-SERVICE] Step 1: Fetching verification from database...');
    const step1Start = Date.now();
    let verification = await this.prisma.kyc_verifications.findFirst({
      where: { user_id: userId },
      orderBy: { kyc_id: 'desc' },
    });
    this.logger.log(`   DB query completed in ${Date.now() - step1Start}ms`);

    if (!verification) {
      throw new Error('No KYC verification found. Please upload document first.');
    }
    this.logger.log(`   Verification found: ${verification.kyc_id}`);

    // Try to create Sumsub applicant if it doesn't exist yet (failed during document upload)
    if (!verification.sumsub_applicant_id) {
      this.logger.warn('⚠️  No Sumsub applicant ID found. Attempting to create now...');
      
      try {
        const user = await this.prisma.users.findUnique({
          where: { user_id: userId },
        });

        if (user) {
          const sumsubApplicant = await this.sumsubService.createApplicant(
            userId,
            user.email,
            user.phone_number || undefined,
          );

          verification = await this.prisma.kyc_verifications.update({
            where: { kyc_id: verification.kyc_id },
            data: {
              sumsub_applicant_id: sumsubApplicant.id,
              sumsub_external_user_id: userId,
              verification_provider: 'sumsub',
            },
          });
          
          this.logger.log(`✅ Sumsub applicant created: ${sumsubApplicant.id}`);
        }
      } catch (error) {
        // Handle 409 Conflict - Applicant already exists in Sumsub
        if (error.status === 409 || error.message?.includes('already exists')) {
          this.logger.warn(`Applicant already exists in Sumsub for user ${userId}, fetching existing...`);
          try {
            const existingApplicant = await this.sumsubService.getApplicantByExternalUserId(userId);
            if (existingApplicant) {
              verification = await this.prisma.kyc_verifications.update({
                where: { kyc_id: verification.kyc_id },
                data: {
                  sumsub_applicant_id: existingApplicant.id,
                  sumsub_external_user_id: userId,
                  verification_provider: 'sumsub',
                },
              });
              this.logger.log(`✅ Linked existing Sumsub applicant: ${existingApplicant.id}`);
            }
          } catch (fetchError) {
            this.logger.error(`Failed to fetch existing applicant: ${fetchError.message}`);
            this.logger.warn('⚠️  Continuing without Sumsub - verification will need manual review');
          }
        } else {
          this.logger.error(`❌ Failed to create Sumsub applicant: ${error.message}`);
          this.logger.warn('⚠️  Continuing without Sumsub - verification will need manual review');
        }
      }
    }

    try {
      // Fetch user for nationality
      const user = await this.prisma.users.findUnique({
        where: { user_id: userId },
        select: { nationality: true },
      });

      // Step 2: Upload selfie to Sumsub (if applicant exists)
      if (verification.sumsub_applicant_id) {
        this.logger.log('🧠 [KYC-SERVICE] Step 2: Uploading selfie to Sumsub...');
        const step2Start = Date.now();
        await this.sumsubService.uploadSelfie(
          verification.sumsub_applicant_id,
          file.buffer,
          file.originalname,
          user?.nationality || undefined,
        );
        this.logger.log(`   Selfie upload completed in ${Date.now() - step2Start}ms`);

        // Step 3: Request verification check
        this.logger.log('🔍 [KYC-SERVICE] Step 3: Requesting Sumsub verification check...');
        const step3Start = Date.now();
        await this.sumsubService.requestCheck(verification.sumsub_applicant_id);
        this.logger.log(`   Check requested in ${Date.now() - step3Start}ms`);

        // Step 4: Update database with pending status
        this.logger.log('💾 [KYC-SERVICE] Step 4: Updating database...');
        const step4Start = Date.now();
        
        await this.prisma.kyc_verifications.update({
          where: { kyc_id: verification.kyc_id },
          data: {
            status: 'pending',
            decision_reason: 'Verification submitted to Sumsub, awaiting review',
            sumsub_review_status: 'pending',
          },
        });
      } else {
        // Fallback: No Sumsub integration - set to review status
        this.logger.warn('⚠️  [KYC-SERVICE] Step 2-4: Sumsub unavailable - setting to manual review...');
        
        await this.prisma.kyc_verifications.update({
          where: { kyc_id: verification.kyc_id },
          data: {
            status: 'review',
            decision_reason: 'Sumsub integration unavailable - requires manual review',
          },
        });
      }

      // Always upload to Cloudinary as backup/audit trail
      this.logger.log('📦 [KYC-SERVICE] Uploading selfie to Cloudinary...');
      await this.documentService.uploadDocument(verification.kyc_id, file, 'selfie');

      const totalTime = Date.now() - totalStart;
      this.logger.log('');
      this.logger.log('╔══════════════════════════════════════════════════════════════════╗');
      this.logger.log(`║  ✅ [KYC-SERVICE] uploadSelfie() COMPLETE                        ║`);
      this.logger.log('╚══════════════════════════════════════════════════════════════════╝');
      this.logger.log(`   Total time: ${totalTime}ms (${(totalTime/1000).toFixed(2)}s)`);
      this.logger.log(`   Status: ${verification.sumsub_applicant_id ? 'PENDING (awaiting Sumsub webhook)' : 'REVIEW (manual review required)'}`);
      this.logger.log('');
      
    } catch (error: any) {
      const totalTime = Date.now() - totalStart;
      this.logger.error('');
      this.logger.error('╔══════════════════════════════════════════════════════════════════╗');
      this.logger.error(`║  ❌ [KYC-SERVICE] uploadSelfie() FAILED after ${totalTime}ms`);
      this.logger.error('╚══════════════════════════════════════════════════════════════════╝');
      this.logger.error(`   Error: ${error?.message}`);
      throw new Error(
        `KYC verification failed: ${error?.message || 'Unknown error'}. Please try again.`,
      );
    }
  }

  async submitVerification(userId: string): Promise<void> {
    const verification = await this.prisma.kyc_verifications.findFirst({
      where: { user_id: userId },
      orderBy: { kyc_id: 'desc' },
    });

    if (!verification) {
      throw new Error('No KYC verification found');
    }

    // Run decision engine to evaluate verification based on all checks
    await this.decisionEngine.applyDecision(verification.kyc_id);
  }

  async autoApproveVerification(userId: string): Promise<void> {
    const verification = await this.prisma.kyc_verifications.findFirst({
      where: { user_id: userId },
      orderBy: { kyc_id: 'desc' },
    });

    if (!verification) {
      throw new Error('No KYC verification found');
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
    let verification = await this.prisma.kyc_verifications.findFirst({
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

    // If status is still pending and we have a Sumsub applicant, poll Sumsub for latest status
    if (
      verification.sumsub_applicant_id &&
      (verification.status === 'pending' || verification.status === 'review')
    ) {
      try {
        this.logger.log(`🔄 Polling Sumsub for applicant status: ${verification.sumsub_applicant_id}`);
        const applicant = await this.sumsubService.getApplicantStatus(verification.sumsub_applicant_id);

        if (applicant.review) {
          const reviewStatus = applicant.review.reviewStatus; // init, pending, completed, onHold
          const reviewAnswer = applicant.review.reviewResult?.reviewAnswer; // GREEN, RED, YELLOW

          this.logger.log(`   Sumsub review status: ${reviewStatus}, answer: ${reviewAnswer || 'N/A'}`);

          // Map Sumsub status to our status
          let newStatus = verification.status;
          let decisionReason = verification.decision_reason;

          if (reviewStatus === 'completed' && reviewAnswer) {
            newStatus = this.sumsubService.parseReviewResult(reviewAnswer);
            const rejectLabels = applicant.review.reviewResult?.rejectLabels;
            const moderationComment = applicant.review.reviewResult?.moderationComment;
            const rejectType = applicant.review.reviewResult?.reviewRejectType;

            decisionReason = `Sumsub review completed: ${reviewAnswer}`;
            if (moderationComment) decisionReason += ` - ${moderationComment}`;
            if (rejectLabels?.length) decisionReason += ` (Labels: ${rejectLabels.join(', ')})`;
            if (rejectType) decisionReason += ` [Type: ${rejectType}]`;

            this.logger.log(`   ✅ Synced Sumsub result → ${newStatus.toUpperCase()}`);
            if (rejectLabels?.length) this.logger.log(`   Reject labels: ${rejectLabels.join(', ')}`);
            if (moderationComment) this.logger.log(`   Moderation comment: ${moderationComment}`);
            if (rejectType) this.logger.log(`   Reject type: ${rejectType}`);
          } else if (reviewStatus === 'onHold') {
            newStatus = 'review';
            decisionReason = 'Verification on hold - additional information may be required';
          }

          // Update DB if status changed
          if (newStatus !== verification.status) {
            verification = await this.prisma.kyc_verifications.update({
              where: { kyc_id: verification.kyc_id },
              data: {
                status: newStatus as any,
                decision_reason: decisionReason,
                sumsub_review_status: reviewStatus,
              },
              include: {
                documents: true,
                face_matches: true,
              },
            });

            // Update user kyc_status if approved
            if (newStatus === 'approved') {
              await this.prisma.users.update({
                where: { user_id: userId },
                data: { kyc_status: 'approved' },
              });
              this.logger.log('   ✅ User KYC status updated to APPROVED');
            } else if (newStatus === 'rejected') {
              await this.prisma.users.update({
                where: { user_id: userId },
                data: { kyc_status: 'rejected' },
              });
            }
          }
        }
      } catch (error) {
        this.logger.warn(`Failed to poll Sumsub status: ${error.message}`);
        // Continue with DB status — don't fail the request
      }
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

  async checkDocumentCompleteness(userId: string): Promise<{
    isComplete: boolean;
    missingDocuments: string[];
  }> {
    const verification = await this.prisma.kyc_verifications.findFirst({
      where: { user_id: userId },
      include: { documents: true },
      orderBy: { kyc_id: 'desc' },
    });

    if (!verification) {
      return { isComplete: false, missingDocuments: ['No verification found'] };
    }

    const documents = verification.documents;
    
    if (documents.length === 0) {
      return { isComplete: false, missingDocuments: ['No documents uploaded'] };
    }

    // Get the document type being used
    const documentType = documents[0]?.document_type;
    if (!documentType) {
      return { isComplete: false, missingDocuments: ['Invalid document type'] };
    }

    const hasFront = documents.some(d => d.document_side === 'front');
    const hasBack = documents.some(d => d.document_side === 'back');

    const missingDocuments: string[] = [];

    // Check requirements based on document type
    if (documentType === 'passport') {
      if (!hasFront) missingDocuments.push('Passport bio page');
    } else {
      // ID card or driver's license - both sides required
      if (!hasFront) missingDocuments.push(`${documentType} front side`);
      if (!hasBack) missingDocuments.push(`${documentType} back side`);
    }

    return {
      isComplete: missingDocuments.length === 0,
      missingDocuments,
    };
  }

  async getVerificationForUser(userId: string) {
    return this.prisma.kyc_verifications.findFirst({
      where: { user_id: userId },
      orderBy: { kyc_id: 'desc' },
    });
  }
}

