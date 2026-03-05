import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

const POOL_STATUS = {
  open: 'open',
  full: 'full',
  active: 'active',
} as const;

const EXIT_REQUEST_STATUS = {
  pending: 'pending',
  approved: 'approved',
  rejected: 'rejected',
  processed: 'processed',
} as const;

@Injectable()
export class PoolCancellationService {
  private readonly logger = new Logger(PoolCancellationService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── User: Request Cancellation ──

  async requestCancellation(userId: string, poolId: string) {
    const pool = await this.prisma.vc_pools.findUnique({
      where: { pool_id: poolId },
      include: {
        members: {
          where: { user_id: userId, is_active: true },
        },
      },
    });

    if (!pool) {
      throw new NotFoundException('Pool not found');
    }

    const member = pool.members[0];
    if (!member) {
      throw new BadRequestException('You are not an active member of this pool');
    }

    // Check for existing pending cancellation
    const existingCancellation = await this.prisma.vc_pool_cancellations.findFirst({
      where: {
        member_id: member.member_id,
        status: EXIT_REQUEST_STATUS.pending,
      },
    });

    if (existingCancellation) {
      throw new ConflictException('You already have a pending cancellation request');
    }

    // Calculate refund based on pool status
    const poolStatus = pool.status as string;
    const investedAmount = Number(member.invested_amount_usdt);
    const cancellationFeePercent = Number(pool.cancellation_fee_percent);

    let memberValueAtExit: number;
    let sharePercentAtExit: number | null = null;
    let poolValueAtExit: number | null = null;

    if (poolStatus === POOL_STATUS.open || poolStatus === POOL_STATUS.full) {
      // Pool not started - refund based on invested amount
      memberValueAtExit = investedAmount;
    } else if (poolStatus === POOL_STATUS.active) {
      // Pool active - calculate based on current pool value and share
      sharePercentAtExit = Number(member.share_percent);
      poolValueAtExit = Number(pool.current_pool_value_usdt || pool.total_invested_usdt);
      memberValueAtExit = (sharePercentAtExit * poolValueAtExit) / 100;
    } else {
      throw new BadRequestException('Cannot cancel membership from a pool in this status');
    }

    const feeAmount = (memberValueAtExit * cancellationFeePercent) / 100;
    const refundAmount = memberValueAtExit - feeAmount;

    // Create cancellation record
    const cancellation = await this.prisma.vc_pool_cancellations.create({
      data: {
        pool_id: poolId,
        member_id: member.member_id,
        pool_status_at_request: poolStatus as any,
        invested_amount: investedAmount,
        share_percent_at_exit: sharePercentAtExit,
        pool_value_at_exit: poolValueAtExit,
        member_value_at_exit: memberValueAtExit,
        cancellation_fee_pct: cancellationFeePercent,
        fee_amount: feeAmount,
        refund_amount: refundAmount,
        status: EXIT_REQUEST_STATUS.pending as any,
      },
    });

    this.logger.log(
      `Cancellation requested: member ${member.member_id} from pool ${poolId}, refund: ${refundAmount}`,
    );

    return {
      cancellation_id: cancellation.cancellation_id,
      pool_status_at_request: poolStatus,
      member_value_at_exit: memberValueAtExit,
      fee_amount: feeAmount,
      refund_amount: refundAmount,
      status: EXIT_REQUEST_STATUS.pending,
      message: 'Cancellation request submitted. Awaiting admin approval.',
    };
  }

  // ── User: Get My Cancellation Status ──

  async getMyCancellation(userId: string, poolId: string) {
    // Find member (active or inactive - they may have been deactivated after refund)
    const member = await this.prisma.vc_pool_members.findFirst({
      where: { pool_id: poolId, user_id: userId },
    });

    if (!member) {
      throw new NotFoundException('You are not a member of this pool');
    }

    const cancellation = await this.prisma.vc_pool_cancellations.findUnique({
      where: { member_id: member.member_id },
      include: {
        reviewing_admin: {
          select: { full_name: true, email: true },
        },
      },
    });

    if (!cancellation) {
      return { has_cancellation: false };
    }

    return {
      has_cancellation: true,
      cancellation: {
        cancellation_id: cancellation.cancellation_id,
        status: cancellation.status,
        requested_at: cancellation.requested_at,
        member_value_at_exit: Number(cancellation.member_value_at_exit),
        fee_amount: Number(cancellation.fee_amount),
        refund_amount: Number(cancellation.refund_amount),
        reviewed_at: cancellation.reviewed_at,
        reviewed_by: cancellation.reviewing_admin
          ? {
              name: cancellation.reviewing_admin.full_name,
              email: cancellation.reviewing_admin.email,
            }
          : null,
        rejection_reason: cancellation.rejection_reason,
        refunded_at: cancellation.refunded_at,
      },
    };
  }

  // ── User: Get My Pools ──

  async getMyPools(userId: string) {
    const memberships = await this.prisma.vc_pool_members.findMany({
      where: { user_id: userId, is_active: true },
      include: {
        pool: {
          select: {
            pool_id: true,
            name: true,
            description: true,
            status: true,
            coin_type: true,
            started_at: true,
            end_date: true,
            current_pool_value_usdt: true,
            total_profit_usdt: true,
            total_invested_usdt: true,
          },
        },
        cancellation: {
          select: {
            cancellation_id: true,
            status: true,
            refund_amount: true,
            requested_at: true,
          },
        },
      },
      orderBy: { joined_at: 'desc' },
    });

    const result = memberships.map((m) => {
      const pool = m.pool;
      const sharePercent = Number(m.share_percent || 0);
      const investedAmount = Number(m.invested_amount_usdt);
      const poolValue = Number(pool.current_pool_value_usdt || pool.total_invested_usdt || 0);
      const currentValue = (sharePercent * poolValue) / 100;
      const pnl = currentValue - investedAmount;

      return {
        membership: {
          member_id: m.member_id,
          pool_id: pool.pool_id,
          pool_name: pool.name,
          pool_description: pool.description,
          pool_status: pool.status,
          coin_type: pool.coin_type,
          started_at: pool.started_at,
          end_date: pool.end_date,
          payment_method: m.payment_method,
        },
        my_investment: {
          invested_amount: investedAmount,
          share_percent: sharePercent,
        },
        pool_performance: {
          current_pool_value: poolValue,
          total_profit: Number(pool.total_profit_usdt || 0),
          total_invested: Number(pool.total_invested_usdt || 0),
        },
        my_value: {
          current_value: currentValue,
          profit_loss: pnl,
        },
        cancellation: m.cancellation
          ? {
              cancellation_id: m.cancellation.cancellation_id,
              status: m.cancellation.status,
              refund_amount: Number(m.cancellation.refund_amount),
              requested_at: m.cancellation.requested_at,
            }
          : null,
      };
    });

    return { pools: result };
  }

  // ── Admin: List Cancellations ──

  async listCancellations(adminId: string, poolId: string) {
    await this.validatePoolOwnership(adminId, poolId);

    const cancellations = await this.prisma.vc_pool_cancellations.findMany({
      where: { pool_id: poolId },
      include: {
        member: {
          include: {
            user: {
              select: { user_id: true, email: true, full_name: true },
            },
          },
        },
        reviewing_admin: {
          select: { full_name: true, email: true },
        },
      },
      orderBy: { requested_at: 'desc' },
    });

    return {
      cancellations: cancellations.map((c) => ({
        cancellation_id: c.cancellation_id,
        member: {
          member_id: c.member.member_id,
          user: {
            user_id: c.member.user.user_id,
            email: c.member.user.email,
            full_name: c.member.user.full_name,
          },
          invested_amount: Number(c.member.invested_amount_usdt),
          share_percent: Number(c.member.share_percent || 0),
        },
        pool_status_at_request: c.pool_status_at_request,
        member_value_at_exit: Number(c.member_value_at_exit),
        fee_amount: Number(c.fee_amount),
        refund_amount: Number(c.refund_amount),
        status: c.status,
        requested_at: c.requested_at,
        reviewed_at: c.reviewed_at,
        reviewed_by: c.reviewing_admin
          ? {
              name: c.reviewing_admin.full_name,
              email: c.reviewing_admin.email,
            }
          : null,
        rejection_reason: c.rejection_reason,
        refunded_at: c.refunded_at,
        binance_refund_tx_id: c.binance_refund_tx_id,
      })),
    };
  }

  // ── Admin: Approve Cancellation ──

  async approveCancellation(
    adminId: string,
    poolId: string,
    cancellationId: string,
  ) {
    await this.validatePoolOwnership(adminId, poolId);

    const cancellation = await this.prisma.vc_pool_cancellations.findUnique({
      where: { cancellation_id: cancellationId },
      include: {
        pool: true,
        member: true,
      },
    });

    if (!cancellation || cancellation.pool_id !== poolId) {
      throw new NotFoundException('Cancellation request not found');
    }

    if (cancellation.status !== EXIT_REQUEST_STATUS.pending) {
      throw new BadRequestException(
        `Cancellation is ${cancellation.status}, only 'pending' requests can be approved`,
      );
    }

    // Recalculate refund at current pool value (may have changed since request)
    const pool = cancellation.pool;
    let memberValue: number;
    let poolValue: number | null = null;

    if (pool.status === POOL_STATUS.active) {
      // Recalculate from current pool value
      poolValue = Number(pool.current_pool_value_usdt || pool.total_invested_usdt);
      const sharePercent = Number(cancellation.member.share_percent || 0);
      memberValue = (sharePercent * poolValue) / 100;
    } else {
      // Pool not started - use invested amount
      memberValue = Number(cancellation.invested_amount);
    }

    const cancellationFeePercent = Number(pool.cancellation_fee_percent);
    const feeAmount = (memberValue * cancellationFeePercent) / 100;
    const refundAmount = memberValue - feeAmount;

    // Update cancellation with recalculated values
    const updated = await this.prisma.vc_pool_cancellations.update({
      where: { cancellation_id: cancellationId },
      data: {
        status: EXIT_REQUEST_STATUS.approved as any,
        reviewed_by_admin_id: adminId,
        reviewed_at: new Date(),
        // Update values if pool was active (recalculated)
        ...(pool.status === POOL_STATUS.active && {
          pool_value_at_exit: poolValue,
          member_value_at_exit: memberValue,
          fee_amount: feeAmount,
          refund_amount: refundAmount,
        }),
      },
    });

    this.logger.log(
      `Cancellation ${cancellationId} approved by admin ${adminId}, refund: ${refundAmount}`,
    );

    return {
      cancellation_id: updated.cancellation_id,
      refund_amount: Number(updated.refund_amount),
      message: 'Cancellation approved. Transfer refund externally, then mark as refunded.',
    };
  }

  // ── Admin: Reject Cancellation ──

  async rejectCancellation(
    adminId: string,
    poolId: string,
    cancellationId: string,
    rejectionReason: string,
  ) {
    await this.validatePoolOwnership(adminId, poolId);

    const cancellation = await this.prisma.vc_pool_cancellations.findUnique({
      where: { cancellation_id: cancellationId },
    });

    if (!cancellation || cancellation.pool_id !== poolId) {
      throw new NotFoundException('Cancellation request not found');
    }

    if (cancellation.status !== EXIT_REQUEST_STATUS.pending) {
      throw new BadRequestException(
        `Cancellation is ${cancellation.status}, only 'pending' requests can be rejected`,
      );
    }

    const updated = await this.prisma.vc_pool_cancellations.update({
      where: { cancellation_id: cancellationId },
      data: {
        status: EXIT_REQUEST_STATUS.rejected as any,
        reviewed_by_admin_id: adminId,
        reviewed_at: new Date(),
        rejection_reason: rejectionReason,
      },
    });

    this.logger.log(`Cancellation ${cancellationId} rejected by admin ${adminId}`);

    return {
      cancellation_id: updated.cancellation_id,
      status: updated.status,
      message: 'Cancellation request rejected. Member remains active.',
    };
  }

  // ── Admin: Mark Refunded ──

  async markRefunded(
    adminId: string,
    poolId: string,
    cancellationId: string,
    binanceTxId?: string,
    notes?: string,
  ) {
    await this.validatePoolOwnership(adminId, poolId);

    const cancellation = await this.prisma.vc_pool_cancellations.findUnique({
      where: { cancellation_id: cancellationId },
      include: {
        member: true,
        pool: true,
      },
    });

    if (!cancellation || cancellation.pool_id !== poolId) {
      throw new NotFoundException('Cancellation request not found');
    }

    if (cancellation.status !== EXIT_REQUEST_STATUS.approved) {
      throw new BadRequestException(
        `Cancellation is ${cancellation.status}, only 'approved' cancellations can be marked as refunded`,
      );
    }

    const pool = cancellation.pool;

    // Mark refunded and deactivate member, recalculate remaining shares
    const result = await this.prisma.$transaction(async (tx) => {
      // Update cancellation
      await tx.vc_pool_cancellations.update({
        where: { cancellation_id: cancellationId },
        data: {
          status: EXIT_REQUEST_STATUS.processed as any,
          refunded_at: new Date(),
          binance_refund_tx_id: binanceTxId || null,
        },
      });

      // Deactivate member
      await tx.vc_pool_members.update({
        where: { member_id: cancellation.member_id },
        data: {
          is_active: false,
          exited_at: new Date(),
        },
      });

      // Recalculate remaining members' share_percent if pool is active
      if (pool.status === POOL_STATUS.active) {
        const remainingMembers = await tx.vc_pool_members.findMany({
          where: { pool_id: poolId, is_active: true },
          select: { member_id: true, invested_amount_usdt: true },
        });

        if (remainingMembers.length > 0) {
          const totalInvested = remainingMembers.reduce(
            (sum, m) => sum + Number(m.invested_amount_usdt),
            0,
          );

          for (const member of remainingMembers) {
            const share = (Number(member.invested_amount_usdt) / totalInvested) * 100;
            await tx.vc_pool_members.update({
              where: { member_id: member.member_id },
              data: { share_percent: share },
            });
          }
        }
      }

      // Decrement verified_members_count
      await tx.vc_pools.update({
        where: { pool_id: poolId },
        data: { verified_members_count: { decrement: 1 } },
      });

      return { success: true };
    });

    this.logger.log(
      `Cancellation ${cancellationId} marked as refunded by admin ${adminId}, member deactivated`,
    );

    return {
      cancellation_id: cancellationId,
      status: EXIT_REQUEST_STATUS.processed,
      message: 'Refund marked as completed. Member deactivated and shares recalculated.',
      notes: notes || null,
    };
  }

  // ── Helpers ──

  private async validatePoolOwnership(adminId: string, poolId: string) {
    const pool = await this.prisma.vc_pools.findUnique({
      where: { pool_id: poolId },
      select: { admin_id: true },
    });

    if (!pool) {
      throw new NotFoundException('Pool not found');
    }

    if (pool.admin_id !== adminId) {
      throw new BadRequestException('You do not own this pool');
    }
  }
}

