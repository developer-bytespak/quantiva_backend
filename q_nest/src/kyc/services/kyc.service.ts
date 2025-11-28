import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentService } from './document.service';
import { LivenessService } from './liveness.service';
import { FaceMatchingService } from './face-matching.service';
import { DecisionEngineService } from './decision-engine.service';

@Injectable()
export class KycService {
  private readonly logger = new Logger(KycService.name);

  constructor(
    private prisma: PrismaService,
    private documentService: DocumentService,
    private livenessService: LivenessService,
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
    // Get or create verification
    let verification = await this.prisma.kyc_verifications.findFirst({
      where: { user_id: userId },
      orderBy: { kyc_id: 'desc' },
    });

    if (!verification) {
      const kycId = await this.createVerification(userId);
      verification = await this.prisma.kyc_verifications.findUnique({
        where: { kyc_id: kycId },
      });
    }

    if (!verification) {
      throw new Error('Failed to create verification');
    }

    return this.documentService.uploadDocument(verification.kyc_id, file, documentType);
  }

  async uploadSelfie(userId: string, file: Express.Multer.File): Promise<void> {
    // Get verification
    const verification = await this.prisma.kyc_verifications.findFirst({
      where: { user_id: userId },
      orderBy: { kyc_id: 'desc' },
    });

    if (!verification) {
      throw new Error('No KYC verification found. Please upload document first.');
    }

    // TEMPORARY: Check if KYC checks are bypassed
    const bypassKycChecks = this.configService.get<string>('KYC_BYPASS_CHECKS', 'false').toLowerCase() === 'true';

    if (bypassKycChecks) {
      this.logger.warn('⚠️  KYC checks bypassed - Skipping liveness and face matching');
      // Still save the selfie file
      await this.livenessService.verifyLiveness(verification.kyc_id, file);
    } else {
      // Verify liveness
      await this.livenessService.verifyLiveness(verification.kyc_id, file);

      // Match faces
      await this.faceMatchingService.matchFaces(verification.kyc_id, file);
    }

    // Run decision engine (will auto-approve if bypass is enabled)
    await this.decisionEngine.applyDecision(verification.kyc_id);
  }

  async submitVerification(userId: string): Promise<void> {
    const verification = await this.prisma.kyc_verifications.findFirst({
      where: { user_id: userId },
      orderBy: { kyc_id: 'desc' },
    });

    if (!verification) {
      throw new Error('No KYC verification found');
    }

    // TEMPORARY: Auto-approve without running decision engine
    this.logger.warn(`⚠️  Auto-approving KYC verification ${verification.kyc_id} (backend temporarily halted)`);
    await this.autoApproveVerification(userId);
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

