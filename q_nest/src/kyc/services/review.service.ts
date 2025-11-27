import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { KycStatus } from '@prisma/client';

@Injectable()
export class ReviewService {
  constructor(private prisma: PrismaService) {}

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
}

