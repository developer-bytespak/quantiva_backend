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
    // Production thresholds for KYC verification
    // Face match: 0.8 (80%) - high confidence required
    this.faceMatchThreshold = this.configService.get<number>('KYC_FACE_MATCH_THRESHOLD', 0.8);
    // Document authenticity: 0.75 (75%) - strong authenticity requirement
    this.docAuthenticityThreshold = this.configService.get<number>(
      'KYC_DOC_AUTHENTICITY_THRESHOLD',
      0.75,
    );
  }

  async makeDecision(kycId: string): Promise<{ status: KycStatus; reason?: string }> {
    console.log(`[DECISION_ENGINE_ANALYSIS] Starting decision analysis for KYC: ${kycId}`);
    
    const verification = await this.prisma.kyc_verifications.findUnique({
      where: { kyc_id: kycId },
      include: {
        documents: true,
        face_matches: true,
      },
    });

    if (!verification) {
      console.error(`[DECISION_ENGINE_ERROR] KYC verification not found: ${kycId}`);
      throw new Error('KYC verification not found');
    }

    console.log(`[DECISION_ENGINE_ANALYSIS] Retrieved verification data:`);
    console.log(`  - User ID: ${verification.user_id}`);
    console.log(`  - Current Status: ${verification.status}`);
    console.log(`  - Face Match Score: ${verification.face_match_score || 'not available'}`);
    console.log(`  - Document Authenticity Score: ${verification.doc_authenticity_score || 'not available'}`);
    console.log(`  - Liveness Result: ${verification.liveness_result || 'not available'}`);
    console.log(`  - Documents Count: ${verification.documents?.length || 0}`);
    console.log(`  - Face Matches Count: ${verification.face_matches?.length || 0}`);

    // Check if all required data is present (liveness check removed)
    if (!verification.face_match_score || !verification.doc_authenticity_score) {
      console.log(`[DECISION_ENGINE_PENDING] Missing required data - keeping status as pending`);
      console.log(`  - Face match score available: ${!!verification.face_match_score}`);
      console.log(`  - Document authenticity score available: ${!!verification.doc_authenticity_score}`);
      return {
        status: 'pending',
        reason: 'Verification still in progress',
      };
    }

    // Check face match
    const faceMatchScore = verification.face_match_score 
      ? Number(verification.face_match_score) 
      : 0;
    
    console.log(`[DECISION_ENGINE_FACE_CHECK] Face matching analysis:`);
    console.log(`  - Score: ${faceMatchScore.toFixed(4)} (${(faceMatchScore * 100).toFixed(2)}%)`);
    console.log(`  - Threshold: ${this.faceMatchThreshold.toFixed(4)} (${(this.faceMatchThreshold * 100).toFixed(0)}%)`);
    console.log(`  - Passes threshold: ${faceMatchScore >= this.faceMatchThreshold ? 'YES' : 'NO'}`);
    
    this.logger.debug(
      `Face match check: score=${faceMatchScore}, threshold=${this.faceMatchThreshold}`,
    );
    
    if (faceMatchScore < this.faceMatchThreshold) {
      console.log(`[DECISION_ENGINE_FACE_FAIL] Face match score too low - sending to manual review`);
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
    
    console.log(`[DECISION_ENGINE_DOC_CHECK] Document authenticity analysis:`);
    console.log(`  - Score: ${docAuthenticityScore.toFixed(4)} (${(docAuthenticityScore * 100).toFixed(2)}%)`);
    console.log(`  - Threshold: ${this.docAuthenticityThreshold.toFixed(4)} (${(this.docAuthenticityThreshold * 100).toFixed(0)}%)`);
    console.log(`  - Passes threshold: ${docAuthenticityScore >= this.docAuthenticityThreshold ? 'YES' : 'NO'}`);
    
    this.logger.debug(
      `Document authenticity check: score=${docAuthenticityScore}, threshold=${this.docAuthenticityThreshold}`,
    );
    
    if (docAuthenticityScore < this.docAuthenticityThreshold) {
      console.log(`[DECISION_ENGINE_DOC_FAIL] Document authenticity score too low - sending to manual review`);
      this.logger.warn(
        `Document authenticity score ${docAuthenticityScore} below threshold ${this.docAuthenticityThreshold}`,
      );
      return {
        status: 'review',
        reason: `Document authenticity score (${(docAuthenticityScore * 100).toFixed(1)}%) below threshold (${(this.docAuthenticityThreshold * 100).toFixed(0)}%)`,
      };
    }

    // All checks passed (face match and document authenticity)
    console.log(`[DECISION_ENGINE_APPROVED] All checks passed - automatically approving KYC`);
    console.log(`  - Face match: ${(faceMatchScore * 100).toFixed(2)}% >= ${(this.faceMatchThreshold * 100).toFixed(0)}%`);
    console.log(`  - Document authenticity: ${(docAuthenticityScore * 100).toFixed(2)}% >= ${(this.docAuthenticityThreshold * 100).toFixed(0)}%`);
    return {
      status: 'approved',
      reason: 'Face match and document authenticity checks passed',
    };
  }

  async applyDecision(kycId: string): Promise<void> {
    const startTime = Date.now();
    console.log(`[DECISION_ENGINE] ========== STARTING AUTOMATIC DECISION ==========`);
    console.log(`[DECISION_ENGINE_START] KYC ID: ${kycId}`);
    console.log(`[DECISION_ENGINE_START] Timestamp: ${new Date().toISOString()}`);
    console.log(`[DECISION_ENGINE_START] Thresholds:`);
    console.log(`  - Face Match: ${(this.faceMatchThreshold * 100).toFixed(0)}%`);
    console.log(`  - Document Authenticity: ${(this.docAuthenticityThreshold * 100).toFixed(0)}%`);
    this.logger.log(`[DECISION_ENGINE_START] Starting automatic decision for KYC ${kycId}`);
    
    const decision = await this.makeDecision(kycId);

    console.log(`[DECISION_ENGINE_DECISION] Final decision:`);
    console.log(`  - Status: ${decision.status.toUpperCase()}`);
    console.log(`  - Reason: ${decision.reason}`);
    console.log(`[DECISION_ENGINE_UPDATE] Updating database with decision...`);

    await this.prisma.kyc_verifications.update({
      where: { kyc_id: kycId },
      data: {
        status: decision.status,
        decision_reason: decision.reason || null,
      },
    });

    console.log(`[DECISION_ENGINE_UPDATE] KYC verification record updated successfully`);

    // Update user's KYC status if approved
    if (decision.status === 'approved') {
      console.log(`[DECISION_ENGINE_USER_UPDATE] Updating user's KYC status to approved...`);
      const verification = await this.prisma.kyc_verifications.findUnique({
        where: { kyc_id: kycId },
        select: { user_id: true },
      });

      if (verification) {
        await this.prisma.users.update({
          where: { user_id: verification.user_id },
          data: { kyc_status: 'approved' },
        });
        console.log(`[DECISION_ENGINE_USER_UPDATE] User ${verification.user_id} KYC status updated to approved`);
      } else {
        console.error(`[DECISION_ENGINE_ERROR] Could not find verification to update user status`);
      }
    } else {
      console.log(`[DECISION_ENGINE_USER_UPDATE] User KYC status unchanged (decision: ${decision.status})`);
    }

    const elapsedTime = Date.now() - startTime;
    console.log(`[DECISION_ENGINE_COMPLETE] Decision processing completed in ${elapsedTime}ms`);
    console.log(`[DECISION_ENGINE] ========== DECISION COMPLETED ==========\\n`);
    this.logger.log(`[DECISION_ENGINE_COMPLETE] Decision made in ${elapsedTime}ms for KYC ${kycId}: status=${decision.status}, reason=${decision.reason}`);
  }
}

