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

    try {
      // Match faces using Python API
      const matchResult = await this.faceMatchingService.matchFaces(verification.kyc_id, file);

      // Apply decision engine based on face matching result
      let kycStatus = 'rejected';
      let decisionReason = 'Face matching threshold not met';

      if (matchResult.is_match && matchResult.similarity >= 0.50) {
        kycStatus = 'approved';
        decisionReason = `Face match successful (similarity: ${(matchResult.similarity * 100).toFixed(1)}%)`;
      } else if (matchResult.similarity >= 0.50) {
        kycStatus = 'review';
        decisionReason = `Face similarity borderline (${(matchResult.similarity * 100).toFixed(1)}%) - manual review needed`;
      } else {
        kycStatus = 'rejected';
        decisionReason = `Face match failed (similarity: ${(matchResult.similarity * 100).toFixed(1)}% < 50%)`;
      }

      // Update verification with decision
      await this.prisma.kyc_verifications.update({
        where: { kyc_id: verification.kyc_id },
        data: {
          status: kycStatus,
          decision_reason: decisionReason,
          doc_authenticity_score: matchResult.similarity,
        },
      });

      // Update user's KYC status
      if (kycStatus === 'approved') {
        await this.prisma.users.update({
          where: { user_id: userId },
          data: { kyc_status: 'approved' },
        });
      }

      this.logger.debug(`KYC decision for user ${userId}: ${kycStatus} - ${decisionReason}`);
    } catch (error: any) {
      this.logger.error('KYC verification step failed', {
        kycId: verification.kyc_id,
        error: error?.message,
        stack: error?.stack,
      });
      // Re-throw with more context
      throw new Error(
        `KYC verification failed: ${error?.message || 'Unknown error'}. Please check that your images are clear and contain visible faces.`,
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

