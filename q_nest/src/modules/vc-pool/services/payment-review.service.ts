import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

const POOL_STATUS = { open: 'open', full: 'full' } as const;

@Injectable()
export class PaymentReviewService {
  private readonly logger = new Logger(PaymentReviewService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── List payment submissions for a pool ──

  async listPayments(
    adminId: string,
    poolId: string,
    filters: { status?: string; payment_method?: string; page?: number; limit?: number },
  ) {
    await this.validatePoolOwnership(adminId, poolId);

    const page = filters.page && filters.page > 0 ? filters.page : 1;
    const limit = filters.limit && filters.limit > 0 ? Math.min(filters.limit, 50) : 20;
    const skip = (page - 1) * limit;

    const where: Record<string, any> = { pool_id: poolId };
    if (filters.status) where.status = filters.status;
    if (filters.payment_method) where.payment_method = filters.payment_method;

    const [submissions, total] = await this.prisma.$transaction([
      this.prisma.vc_pool_payment_submissions.findMany({
        where,
        orderBy: { submitted_at: 'desc' },
        skip,
        take: limit,
        include: {
          user: { select: { user_id: true, email: true, username: true } },
          reservation: { select: { status: true, expires_at: true } },
        },
      }),
      this.prisma.vc_pool_payment_submissions.count({ where }),
    ]);

    return {
      submissions,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  // ── List seat reservations for a pool ──

  async listReservations(adminId: string, poolId: string) {
    await this.validatePoolOwnership(adminId, poolId);

    const reservations = await this.prisma.vc_pool_seat_reservations.findMany({
      where: { pool_id: poolId },
      orderBy: { reserved_at: 'desc' },
      include: {
        user: { select: { user_id: true, email: true, username: true } },
      },
    });

    return { reservations };
  }

  // ── List members for a pool ──

  async listMembers(adminId: string, poolId: string) {
    await this.validatePoolOwnership(adminId, poolId);

    const members = await this.prisma.vc_pool_members.findMany({
      where: { pool_id: poolId },
      orderBy: { joined_at: 'desc' },
      include: {
        user: { select: { user_id: true, email: true, username: true } },
      },
    });

    return { members };
  }

  // ── Approve payment ──

  async approvePayment(
    adminId: string,
    poolId: string,
    submissionId: string,
    adminNotes?: string,
  ) {
    const pool = await this.validatePoolOwnership(adminId, poolId);

    const submission = await this.prisma.vc_pool_payment_submissions.findUnique({
      where: { submission_id: submissionId },
      include: { reservation: true },
    });

    if (!submission || submission.pool_id !== poolId) {
      throw new NotFoundException('Payment submission not found');
    }

    if (submission.status !== 'processing') {
      throw new BadRequestException(
        `Payment is ${submission.status}, only 'processing' submissions can be approved`,
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // Update submission
      const updatedSubmission = await tx.vc_pool_payment_submissions.update({
        where: { submission_id: submissionId },
        data: {
          status: 'verified' as any,
          verified_at: new Date(),
          reviewed_by_admin_id: adminId,
          admin_notes: adminNotes || null,
        },
      });

      // Confirm reservation
      await tx.vc_pool_seat_reservations.update({
        where: { reservation_id: submission.reservation_id },
        data: { status: 'confirmed' as any },
      });

      // Create pool member
      const member = await tx.vc_pool_members.create({
        data: {
          pool_id: poolId,
          user_id: submission.user_id,
          payment_method: submission.payment_method,
          invested_amount_usdt: submission.investment_amount,
          share_percent: 0, // Recalculated when pool starts
          user_binance_uid:
            submission.payment_method === 'binance'
              ? (submission.reservation as any)?.user_binance_uid || null
              : null,
          is_active: true,
        },
      });

      // Update pool counters
      const updatedPool = await tx.vc_pools.update({
        where: { pool_id: poolId },
        data: {
          verified_members_count: { increment: 1 },
          reserved_seats_count: { decrement: 1 },
        },
      });

      // Auto-transition to 'full' if all seats filled
      if (updatedPool.verified_members_count >= updatedPool.max_members) {
        await tx.vc_pools.update({
          where: { pool_id: poolId },
          data: { status: POOL_STATUS.full as any },
        });
        this.logger.log(`Pool ${poolId} is now full`);
      }

      return { submission: updatedSubmission, member };
    });

    this.logger.log(
      `Payment ${submissionId} approved by admin ${adminId} for pool ${poolId}`,
    );

    return {
      message: 'Payment approved. User is now a pool member.',
      submission_id: result.submission.submission_id,
      member_id: result.member.member_id,
      status: 'verified',
    };
  }

  // ── Reject payment ──

  async rejectPayment(
    adminId: string,
    poolId: string,
    submissionId: string,
    rejectionReason: string,
  ) {
    await this.validatePoolOwnership(adminId, poolId);

    const submission = await this.prisma.vc_pool_payment_submissions.findUnique({
      where: { submission_id: submissionId },
    });

    if (!submission || submission.pool_id !== poolId) {
      throw new NotFoundException('Payment submission not found');
    }

    if (submission.status !== 'processing') {
      throw new BadRequestException(
        `Payment is ${submission.status}, only 'processing' submissions can be rejected`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.vc_pool_payment_submissions.update({
        where: { submission_id: submissionId },
        data: {
          status: 'rejected' as any,
          rejection_reason: rejectionReason,
          reviewed_by_admin_id: adminId,
        },
      });

      await tx.vc_pool_seat_reservations.update({
        where: { reservation_id: submission.reservation_id },
        data: { status: 'released' as any },
      });

      await tx.vc_pools.update({
        where: { pool_id: poolId },
        data: { reserved_seats_count: { decrement: 1 } },
      });
    });

    this.logger.log(
      `Payment ${submissionId} rejected by admin ${adminId}: ${rejectionReason}`,
    );

    return {
      message: 'Payment rejected. Seat has been released.',
      submission_id: submissionId,
      status: 'rejected',
    };
  }

  // ── Helpers ──

  private async validatePoolOwnership(adminId: string, poolId: string) {
    const pool = await this.prisma.vc_pools.findUnique({
      where: { pool_id: poolId },
    });

    if (!pool) throw new NotFoundException('Pool not found');
    if (pool.admin_id !== adminId) {
      throw new ForbiddenException('You do not own this pool');
    }

    return pool;
  }
}
