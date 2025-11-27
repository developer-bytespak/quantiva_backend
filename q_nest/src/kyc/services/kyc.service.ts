import { Injectable, Logger } from '@nestjs/common';
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

    // Verify liveness
    await this.livenessService.verifyLiveness(verification.kyc_id, file);

    // Match faces
    await this.faceMatchingService.matchFaces(verification.kyc_id, file);

    // Run decision engine
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

    // Run decision engine
    await this.decisionEngine.applyDecision(verification.kyc_id);
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

