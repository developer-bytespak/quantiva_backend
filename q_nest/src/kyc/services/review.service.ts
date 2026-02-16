import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { KycStatus } from '@prisma/client';
import { SumsubService } from '../integrations/sumsub.service';

@Injectable()
export class ReviewService {
  private readonly logger = new Logger(ReviewService.name);

  constructor(
    private prisma: PrismaService,
    private sumsubService: SumsubService,
  ) {}

  async approve(kycId: string, reason?: string): Promise<void> {
    const verification = await this.prisma.kyc_verifications.findUnique({
      where: { kyc_id: kycId },
      select: { user_id: true },
    });

    if (!verification) {
      throw new Error('KYC verification not found');
    }

    await this.prisma.kyc_verifications.update({
      where: { kyc_id: kycId },
      data: {
        status: 'approved',
        decision_reason: reason || 'Manually approved by reviewer',
      },
    });

    await this.prisma.users.update({
      where: { user_id: verification.user_id },
      data: { kyc_status: 'approved' },
    });
  }

  async reject(kycId: string, reason: string): Promise<void> {
    const verification = await this.prisma.kyc_verifications.findUnique({
      where: { kyc_id: kycId },
      select: { user_id: true },
    });

    if (!verification) {
      throw new Error('KYC verification not found');
    }

    await this.prisma.kyc_verifications.update({
      where: { kyc_id: kycId },
      data: {
        status: 'rejected',
        decision_reason: reason,
      },
    });

    await this.prisma.users.update({
      where: { user_id: verification.user_id },
      data: { kyc_status: 'rejected' },
    });
  }

  async requestResubmit(kycId: string, reason: string): Promise<void> {
    await this.prisma.kyc_verifications.update({
      where: { kyc_id: kycId },
      data: {
        status: 'pending',
        decision_reason: reason,
      },
    });
  }

  async getPendingReviews() {
    return this.prisma.kyc_verifications.findMany({
      where: { status: 'review' },
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
      orderBy: { kyc_id: 'desc' },
    });
  }

  /**
   * Get full Sumsub applicant data from Sumsub API
   */
  async getSumsubApplicantData(kycId: string): Promise<any> {
    const verification = await this.prisma.kyc_verifications.findUnique({
      where: { kyc_id: kycId },
      select: { sumsub_applicant_id: true, verification_provider: true },
    });

    if (!verification) {
      throw new Error('KYC verification not found');
    }

    if (verification.verification_provider !== 'sumsub') {
      throw new Error('This verification does not use Sumsub');
    }

    if (!verification.sumsub_applicant_id) {
      throw new Error('No Sumsub applicant ID found');
    }

    return this.sumsubService.getApplicantStatus(verification.sumsub_applicant_id);
  }

  /**
   * Reset Sumsub applicant for resubmission
   */
  async resetSumsubApplicant(kycId: string): Promise<void> {
    const verification = await this.prisma.kyc_verifications.findUnique({
      where: { kyc_id: kycId },
      select: { sumsub_applicant_id: true, verification_provider: true },
    });

    if (!verification) {
      throw new Error('KYC verification not found');
    }

    if (verification.verification_provider !== 'sumsub') {
      throw new Error('This verification does not use Sumsub');
    }

    if (!verification.sumsub_applicant_id) {
      throw new Error('No Sumsub applicant ID found');
    }

    await this.sumsubService.resetApplicant(verification.sumsub_applicant_id);

    await this.prisma.kyc_verifications.update({
      where: { kyc_id: kycId },
      data: {
        status: 'pending',
        decision_reason: 'Applicant reset for resubmission',
        sumsub_review_status: null,
        sumsub_review_result: null,
      },
    });

    this.logger.log(`Reset Sumsub applicant for KYC: ${kycId}`);
  }

  /**
   * Get Sumsub dashboard link for applicant
   */
  getSumsubDashboardLink(applicantId: string): string {
    // Construct Sumsub dashboard link (adjust based on your Sumsub environment)
    return `https://cockpit.sumsub.com/checkus/#/applicant/${applicantId}`;
  }
}


