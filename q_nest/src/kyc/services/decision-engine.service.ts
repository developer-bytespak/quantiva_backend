import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { KycStatus } from '@prisma/client';

@Injectable()
export class DecisionEngineService {
  private readonly logger = new Logger(DecisionEngineService.name);
  private readonly faceMatchThreshold: number;
  private readonly livenessConfidenceThreshold: number;
  private readonly docAuthenticityThreshold: number;
  private readonly bypassKycChecks: boolean;

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {
    this.faceMatchThreshold = this.configService.get<number>('KYC_FACE_MATCH_THRESHOLD', 0.8);
    this.livenessConfidenceThreshold = this.configService.get<number>(
      'KYC_LIVENESS_CONFIDENCE_THRESHOLD',
      0.7,
    );
    this.docAuthenticityThreshold = this.configService.get<number>(
      'KYC_DOC_AUTHENTICITY_THRESHOLD',
      0.75,
    );
    // TEMPORARY: Bypass KYC checks - set KYC_BYPASS_CHECKS=true to enable
    this.bypassKycChecks = this.configService.get<string>('KYC_BYPASS_CHECKS', 'false').toLowerCase() === 'true';
    
    if (this.bypassKycChecks) {
      this.logger.warn('⚠️  KYC CHECKS ARE BYPASSED - All verifications will be auto-approved');
    }
  }

  async makeDecision(kycId: string): Promise<{ status: KycStatus; reason?: string }> {
    // TEMPORARY: Bypass all checks and auto-approve
    if (this.bypassKycChecks) {
      this.logger.warn(`KYC bypass enabled - Auto-approving verification ${kycId}`);
      return {
        status: 'approved',
        reason: 'KYC checks bypassed (temporary mode)',
      };
    }

    const verification = await this.prisma.kyc_verifications.findUnique({
      where: { kyc_id: kycId },
      include: {
        documents: true,
        face_matches: true,
      },
    });

    if (!verification) {
      throw new Error('KYC verification not found');
    }

    // Check if all required data is present
    if (!verification.liveness_result || !verification.face_match_score || !verification.doc_authenticity_score) {
      return {
        status: 'pending',
        reason: 'Verification still in progress',
      };
    }

    // Check liveness
    if (verification.liveness_result !== 'live') {
      return {
        status: 'rejected',
        reason: 'Liveness check failed',
      };
    }

    const livenessConfidence = verification.liveness_confidence 
      ? Number(verification.liveness_confidence) 
      : 0;
    if (livenessConfidence < this.livenessConfidenceThreshold) {
      return {
        status: 'review',
        reason: 'Low liveness confidence score',
      };
    }

    // Check face match
    const faceMatchScore = verification.face_match_score 
      ? Number(verification.face_match_score) 
      : 0;
    if (faceMatchScore < this.faceMatchThreshold) {
      return {
        status: 'review',
        reason: 'Face match score below threshold',
      };
    }

    // Check document authenticity
    const docAuthenticityScore = verification.doc_authenticity_score 
      ? Number(verification.doc_authenticity_score) 
      : 0;
    if (docAuthenticityScore < this.docAuthenticityThreshold) {
      return {
        status: 'review',
        reason: 'Document authenticity score below threshold',
      };
    }

    // All checks passed
    return {
      status: 'approved',
      reason: 'All verification checks passed',
    };
  }

  async applyDecision(kycId: string): Promise<void> {
    const decision = await this.makeDecision(kycId);

    await this.prisma.kyc_verifications.update({
      where: { kyc_id: kycId },
      data: {
        status: decision.status,
        decision_reason: decision.reason || null,
      },
    });

    // Update user's KYC status if approved
    if (decision.status === 'approved') {
      const verification = await this.prisma.kyc_verifications.findUnique({
        where: { kyc_id: kycId },
        select: { user_id: true },
      });

      if (verification) {
        await this.prisma.users.update({
          where: { user_id: verification.user_id },
          data: { kyc_status: 'approved' },
        });
      }
    }
  }
}

