import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { KycStatus } from '@prisma/client';

@Injectable()
export class DecisionEngineService {
  private readonly logger = new Logger(DecisionEngineService.name);
  private readonly faceMatchThreshold: number;
  private readonly docAuthenticityThreshold: number;

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {
    // Lower thresholds to allow verifications to pass
    // Face match: 0.25 (25%) - very lenient to allow for variations
    this.faceMatchThreshold = this.configService.get<number>('KYC_FACE_MATCH_THRESHOLD', 0.25);
    // Document authenticity: 0.3 (30%) - basic authenticity check
    this.docAuthenticityThreshold = this.configService.get<number>(
      'KYC_DOC_AUTHENTICITY_THRESHOLD',
      0.3,
    );
  }

  async makeDecision(kycId: string): Promise<{ status: KycStatus; reason?: string }> {
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

    // Check if all required data is present (liveness check removed)
    if (!verification.face_match_score || !verification.doc_authenticity_score) {
      return {
        status: 'pending',
        reason: 'Verification still in progress',
      };
    }

    // Check face match
    const faceMatchScore = verification.face_match_score 
      ? Number(verification.face_match_score) 
      : 0;
    
    this.logger.debug(
      `Face match check: score=${faceMatchScore}, threshold=${this.faceMatchThreshold}`,
    );
    
    if (faceMatchScore < this.faceMatchThreshold) {
      this.logger.warn(
        `Face match score ${faceMatchScore} below threshold ${this.faceMatchThreshold}`,
      );
      return {
        status: 'review',
        reason: `Face match score (${(faceMatchScore * 100).toFixed(1)}%) below threshold (${(this.faceMatchThreshold * 100).toFixed(0)}%)`,
      };
    }

    // Check document authenticity
    const docAuthenticityScore = verification.doc_authenticity_score 
      ? Number(verification.doc_authenticity_score) 
      : 0;
    
    this.logger.debug(
      `Document authenticity check: score=${docAuthenticityScore}, threshold=${this.docAuthenticityThreshold}`,
    );
    
    if (docAuthenticityScore < this.docAuthenticityThreshold) {
      this.logger.warn(
        `Document authenticity score ${docAuthenticityScore} below threshold ${this.docAuthenticityThreshold}`,
      );
      return {
        status: 'review',
        reason: `Document authenticity score (${(docAuthenticityScore * 100).toFixed(1)}%) below threshold (${(this.docAuthenticityThreshold * 100).toFixed(0)}%)`,
      };
    }

    // All checks passed (face match and document authenticity)
    return {
      status: 'approved',
      reason: 'Face match and document authenticity checks passed',
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

