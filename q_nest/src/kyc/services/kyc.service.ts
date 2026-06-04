import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { DecisionEngineService } from './decision-engine.service';
import { SumsubService } from '../integrations/sumsub.service';
import { OnboardingStateService } from '../../modules/onboarding-emails/services/onboarding-state.service';
import { OnboardingState } from '../../modules/onboarding-emails/types';

@Injectable()
export class KycService {
  private readonly logger = new Logger(KycService.name);

  // In-memory cache to throttle Sumsub API polling.
  // Key: sumsub_applicant_id, Value: { timestamp, data }
  // Prevents hitting Sumsub rate limits when frontend polls every few seconds.
  private readonly sumsubStatusCache = new Map<string, { ts: number; data: any }>();
  private readonly SUMSUB_POLL_TTL_MS = 30_000; // Only poll Sumsub once every 30 seconds per applicant

  constructor(
    private prisma: PrismaService,
    private decisionEngine: DecisionEngineService,
    private configService: ConfigService,
    private sumsubService: SumsubService,
    private onboardingStateService: OnboardingStateService,
  ) {}

  /**
   * Generate an SDK access token for the SumSub Web SDK.
   * Creates or reuses the kyc_verifications record and SumSub applicant,
   * then returns a short-lived token the frontend passes to the SDK.
   */
  async generateSdkToken(userId: string): Promise<{ token: string; userId: string }> {
    this.logger.log(`Generating SDK token for user: ${userId}`);

    const user = await this.prisma.users.findUnique({
      where: { user_id: userId },
    });
    if (!user) {
      throw new Error('User not found');
    }

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
      throw new Error('Failed to create verification record');
    }

    // Ensure a SumSub applicant exists so the SDK can attach to it
    if (!verification.sumsub_applicant_id) {
      try {
        const applicant = await this.sumsubService.createApplicant(
          userId,
          user.email,
          user.phone_number || undefined,
        );
        verification = await this.prisma.kyc_verifications.update({
          where: { kyc_id: verification.kyc_id },
          data: {
            sumsub_applicant_id: applicant.id,
            sumsub_external_user_id: userId,
            verification_provider: 'sumsub',
          },
        });
        this.logger.log(`Created SumSub applicant: ${applicant.id}`);
      } catch (error: any) {
        if (error.status === 409 || error.message?.includes('already exists')) {
          const existing = await this.sumsubService.getApplicantByExternalUserId(userId);
          if (existing) {
            verification = await this.prisma.kyc_verifications.update({
              where: { kyc_id: verification.kyc_id },
              data: {
                sumsub_applicant_id: existing.id,
                sumsub_external_user_id: userId,
                verification_provider: 'sumsub',
              },
            });
            this.logger.log(`Linked existing SumSub applicant: ${existing.id}`);
          }
        } else {
          this.logger.error(`Failed to create SumSub applicant: ${error.message}`);
          throw error;
        }
      }
    }

    const result = await this.sumsubService.generateSdkAccessToken(
      userId,
      user.email,
      user.phone_number || undefined,
    );

    this.logger.log(`SDK token generated successfully for user: ${userId}`);
    return result;
  }

  async createVerification(userId: string): Promise<string> {
    const verification = await this.prisma.kyc_verifications.create({
      data: {
        user_id: userId,
        status: 'pending',
      },
    });

    return verification.kyc_id;
  }

  async submitVerification(userId: string): Promise<void> {
    const verification = await this.prisma.kyc_verifications.findFirst({
      where: { user_id: userId },
      orderBy: { kyc_id: 'desc' },
    });

    if (!verification) {
      throw new Error('No KYC verification found');
    }

    // For Sumsub verifications, status is updated via webhook - skip legacy decision engine
    if (verification.verification_provider === 'sumsub') {
      return;
    }

    // Run decision engine for legacy (non-Sumsub) verifications
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
      orderBy: { kyc_id: 'desc' },
    });

    if (!verification) {
      return {
        status: 'pending',
        kyc_id: null,
      };
    }

    // Poll Sumsub for the latest state when:
    //   • our local status is still pending or under manual review, OR
    //   • Sumsub hasn't finalised yet (reviewStatus != "completed") — this
    //     covers the "prechecked RED but review still in progress" race where
    //     Sumsub may later flip the verdict to GREEN after human review.
    // Throttled by SUMSUB_POLL_TTL_MS either way.
    const sumsubNotFinalised =
      verification.sumsub_review_status !== 'completed';
    const shouldPollSumsub =
      verification.sumsub_applicant_id &&
      (verification.status === 'pending' ||
        verification.status === 'review' ||
        sumsubNotFinalised);

    if (shouldPollSumsub) {
      const cacheKey = verification.sumsub_applicant_id;
      const cached = this.sumsubStatusCache.get(cacheKey);
      const now = Date.now();

      if (cached && (now - cached.ts) < this.SUMSUB_POLL_TTL_MS) {
        this.logger.debug(`Sumsub poll skipped (cached ${Math.round((now - cached.ts) / 1000)}s ago): ${cacheKey}`);
      }

      // Only poll Sumsub if cache is stale or absent
      if (!cached || (now - cached.ts) >= this.SUMSUB_POLL_TTL_MS) {
      try {
        this.logger.log(`🔄 Polling Sumsub for applicant status: ${verification.sumsub_applicant_id}`);
        const applicant = await this.sumsubService.getApplicantStatus(verification.sumsub_applicant_id);

        // Update cache
        this.sumsubStatusCache.set(cacheKey, { ts: Date.now(), data: applicant });

        if (applicant.review) {
          const reviewStatus = applicant.review.reviewStatus; // init, pending, completed, onHold
          const reviewAnswer = applicant.review.reviewResult?.reviewAnswer; // GREEN, RED, YELLOW

          this.logger.log(`   Sumsub review status: ${reviewStatus}, answer: ${reviewAnswer || 'N/A'}`);

          // If there's a RED answer regardless of status, log rejection details immediately
          if (reviewAnswer === 'RED') {
            const rejectLabels = applicant.review.reviewResult?.rejectLabels;
            const moderationComment = applicant.review.reviewResult?.moderationComment;
            const rejectType = applicant.review.reviewResult?.reviewRejectType;
            const clientComment = applicant.review.reviewResult?.clientComment;

            this.logger.error(`   ❌ REJECTION DETECTED - Status: ${reviewStatus}`);
            if (rejectLabels?.length) this.logger.error(`   📋 Reject labels: ${rejectLabels.join(', ')}`);
            if (moderationComment) this.logger.error(`   💬 Moderation comment: ${moderationComment}`);
            if (clientComment) this.logger.error(`   💬 Client comment: ${clientComment}`);
            if (rejectType) this.logger.error(`   🏷️  Reject type: ${rejectType}`);

            // Check required docs status to see what's missing
            try {
              const requiredDocStatus = await this.sumsubService.getRequiredDocStatus(verification.sumsub_applicant_id);
              this.logger.error(`   📄 Required docs status: ${JSON.stringify(requiredDocStatus, null, 2)}`);
            } catch (err) {
              this.logger.error(`   ⚠️  Could not fetch required docs status: ${err.message}`);
            }
          }

          // Map Sumsub status to our status.
          // Sumsub reviewStatus values: init, pending, prechecked, completed, onHold.
          //
          // • GREEN at "prechecked" OR "completed" → safe to treat as approved.
          //   A GREEN from the automated check (prechecked) is stable; Sumsub
          //   doesn't walk back a GREEN to a RED.
          //
          // • RED at "prechecked" → wait for "completed" before persisting
          //   as rejected. Sumsub may still escalate to human review, during
          //   which the applicant is effectively "still processing" on their
          //   SDK. If we mark the DB rejected here, the user sees our retry
          //   UI while the Sumsub side hasn't finalised — then clicking Retry
          //   fails with "review is already in progress".
          //
          // • Any reviewAnswer at "completed" → final, persist verbatim.
          let newStatus = verification.status;
          let decisionReason = verification.decision_reason;
          let newReviewResult = verification.sumsub_review_result;

          const isFinalised = reviewStatus === 'completed';
          const isPrecheckedGreen =
            reviewStatus === 'prechecked' && reviewAnswer === 'GREEN';
          const hasActionableAnswer =
            reviewAnswer && (isFinalised || isPrecheckedGreen);

          if (hasActionableAnswer) {
            newStatus = this.sumsubService.parseReviewResult(reviewAnswer);
            const rejectLabels = applicant.review.reviewResult?.rejectLabels;
            const moderationComment = applicant.review.reviewResult?.moderationComment;
            const rejectType = applicant.review.reviewResult?.reviewRejectType;

            decisionReason = `Sumsub review ${reviewStatus}: ${reviewAnswer}`;
            if (moderationComment) decisionReason += ` - ${moderationComment}`;
            if (rejectLabels?.length) decisionReason += ` (Labels: ${rejectLabels.join(', ')})`;
            if (rejectType) decisionReason += ` [Type: ${rejectType}]`;

            // Persist the full reviewResult so review_reject_type is available
            newReviewResult = applicant.review.reviewResult as any;

            this.logger.log(`   ✅ Synced Sumsub result (${reviewStatus}) → ${newStatus.toUpperCase()}`);
            if (rejectLabels?.length) this.logger.log(`   Reject labels: ${rejectLabels.join(', ')}`);
            if (moderationComment) this.logger.log(`   Moderation comment: ${moderationComment}`);
            if (rejectType) this.logger.log(`   Reject type: ${rejectType}`);
          } else if (reviewStatus === 'onHold') {
            newStatus = 'review';
            decisionReason = 'Verification on hold - additional information may be required';
          } else if (reviewStatus === 'prechecked' && reviewAnswer === 'RED') {
            // Automated check said RED but Sumsub may still escalate to a
            // human. Keep our state as pending so the frontend stays inside
            // the SDK waiting UI until Sumsub finalises.
            this.logger.log(
              `   ⏳ Sumsub prechecked RED — waiting for "completed" before marking rejected`,
            );
          }

          // Update DB if status changed
          if (newStatus !== verification.status) {
            // Capture reject type (RETRY/FINAL) from the Sumsub response so the
            // UI can distinguish retry-able rejections from permanent ones
            // without having to parse the review_result JSON every time.
            const polledRejectType =
              (applicant.review?.reviewResult as any)?.reviewRejectType ?? null;

            verification = await this.prisma.kyc_verifications.update({
              where: { kyc_id: verification.kyc_id },
              data: {
                status: newStatus as any,
                decision_reason: decisionReason,
                sumsub_review_status: reviewStatus,
                sumsub_review_result: newReviewResult as any,
                review_reject_type: polledRejectType,
              },
            });

            // Mirror onto users.kyc_status for ALL outcomes so flow-router,
            // dashboard banner, and action-button gating all see the truth.
            await this.prisma.users.update({
              where: { user_id: userId },
              data: { kyc_status: newStatus as any },
            });
            this.logger.log(`   ✅ User KYC status updated to ${newStatus.toUpperCase()}`);

            // Onboarding drip: when polling discovers an approval before Sumsub's webhook
            // arrives, advance the funnel state too. advanceTo is idempotent — a later
            // webhook approval call is a no-op because state is already KYC.
            if (newStatus === 'approved') {
              try {
                await this.onboardingStateService.advanceTo(userId, OnboardingState.KYC);
              } catch (advanceError) {
                this.logger.warn(`Failed to advance onboarding state: ${advanceError.message}`);
              }
            }
          }
        }
      } catch (error) {
        this.logger.warn(`Failed to poll Sumsub status: ${error.message}`);
        // Continue with DB status — don't fail the request
      }
      } // end: if cache stale
    }

    // Prefer the dedicated column; fall back to parsing the stored review JSON
    const reviewResult = verification.sumsub_review_result as Record<string, any> | null;
    const reviewRejectType =
      verification.review_reject_type ??
      (reviewResult?.reviewRejectType as string | undefined) ??
      null;

    // Fetch human-readable rejection reasons when status is rejected
    let rejectionReasons: string[] = [];
    if (
      (verification.status === 'rejected' || verification.status === 'review') &&
      verification.sumsub_applicant_id
    ) {
      try {
        const moderationStates = await this.sumsubService.getModerationStates(
          verification.sumsub_applicant_id,
        );
        const buttonIds = new Set<string>();

        if (moderationStates.imagesStates) {
          Object.values(moderationStates.imagesStates).forEach((id: any) =>
            buttonIds.add(String(id)),
          );
        }
        if (moderationStates.applicantState?.buttonId) {
          buttonIds.add(moderationStates.applicantState.buttonId);
        }

        // Fallback: use buttonIds from stored review result if moderation states returned none
        if (buttonIds.size === 0 && reviewResult?.buttonIds?.length) {
          reviewResult.buttonIds.forEach((id: string) => buttonIds.add(id));
        }

        rejectionReasons = Array.from(buttonIds)
          .map((bid) => this.sumsubService.getRejectionReasonLabel(bid))
          .filter(Boolean);

        // Fallback: use rejectLabels (e.g. FORGERY, UNSATISFACTORY_PHOTOS) if no buttonIds
        if (rejectionReasons.length === 0 && reviewResult?.rejectLabels?.length) {
          const labelMap: Record<string, string> = {
            FORGERY: 'Document authenticity could not be verified. Please upload a genuine, unaltered document.',
            UNSATISFACTORY_PHOTOS: 'Photo quality did not meet requirements. Please upload clearer photos.',
            GRAPHIC_EDITOR: 'Photo appears edited. Please upload an unmodified photo.',
            BAD_SELFIE: 'Selfie did not meet requirements. Please retake in good lighting.',
            BAD_FACE_MATCHING: 'Face could not be matched to your ID. Please ensure your face is clearly visible.',
            SCREENSHOTS: 'Screenshots are not accepted. Please photograph your physical document.',
          };
          rejectionReasons = reviewResult.rejectLabels
            .map((l: string) => labelMap[l] || l.replace(/_/g, ' '))
            .filter(Boolean);
        }
      } catch (err) {
        this.logger.warn(`Could not fetch rejection reasons: ${err.message}`);
        if (reviewResult?.buttonIds?.length) {
          rejectionReasons = reviewResult.buttonIds.map((bid: string) =>
            this.sumsubService.getRejectionReasonLabel(bid),
          );
        }
      }
    }

    // `has_submission` tells the frontend whether Sumsub actually received
    // any docs on this applicant yet. When the SDK token endpoint is called
    // it creates a kyc_verifications row + a Sumsub applicant, but if the
    // user never actually finishes the SDK (closes the tab, navigates away),
    // the applicant sits in `reviewStatus: init` forever. We don't want to
    // trap those users on the pending spinner — the frontend uses this flag
    // to redirect them back to the SDK page.
    const sumsubReviewStatus = verification.sumsub_review_status || null;
    const hasSubmission =
      sumsubReviewStatus !== null && sumsubReviewStatus !== 'init';

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
      review_reject_type: reviewRejectType || null,
      rejection_reasons: rejectionReasons.length > 0 ? rejectionReasons : undefined,
      sumsub_review_status: sumsubReviewStatus,
      has_submission: hasSubmission,
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
      },
    });
  }

  async getVerificationForUser(userId: string) {
    return this.prisma.kyc_verifications.findFirst({
      where: { user_id: userId },
      orderBy: { kyc_id: 'desc' },
    });
  }

  // Getter for Sumsub service (for debugging/admin endpoints)
  getSumsubService(): SumsubService {
    return this.sumsubService;
  }
}

