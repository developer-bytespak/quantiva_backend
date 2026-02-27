import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

const POOL_STATUS = {
  active: 'active',
  completed: 'completed',
  open: 'open',
  full: 'full',
  cancelled: 'cancelled',
} as const;

const PAYOUT_STATUS = {
  pending: 'pending',
  completed: 'completed',
} as const;

const PAYOUT_TYPE = {
  completion: 'completion',
  pool_cancelled: 'pool_cancelled',
} as const;

@Injectable()
export class PoolPayoutService {
  private readonly logger = new Logger(PoolPayoutService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Admin: Complete Pool ──

  async completePool(adminId: string, poolId: string) {
    const pool = await this.validatePoolOwnership(adminId, poolId);

    if (pool.status !== POOL_STATUS.active) {
      throw new BadRequestException('Only active pools can be completed');
    }

    // Check for open trades
    const openTrades = await this.prisma.vc_pool_trades.findFirst({
      where: { pool_id: poolId, is_open: true },
    });

    if (openTrades) {
      throw new BadRequestException('Close all open trades before completing the pool');
    }

    // Calculate final pool value from closed trades
    const closedTrades = await this.prisma.vc_pool_trades.findMany({
      where: { pool_id: poolId, is_open: false },
      select: { pnl_usdt: true },
    });

    const closedPnl = closedTrades.reduce(
      (sum, t) => sum + (t.pnl_usdt ? Number(t.pnl_usdt) : 0),
      0,
    );

    const totalInvested = Number(pool.total_invested_usdt);
    const finalPoolValue = totalInvested + closedPnl;
    const totalProfit = finalPoolValue - totalInvested;

    // Get all active members
    const activeMembers = await this.prisma.vc_pool_members.findMany({
      where: { pool_id: poolId, is_active: true },
      select: {
        member_id: true,
        user_id: true,
        invested_amount_usdt: true,
        share_percent: true,
      },
    });

    if (activeMembers.length === 0) {
      throw new BadRequestException('No active members in this pool');
    }

    // Calculate total pool fees collected (from payment submissions)
    const paymentSubmissions = await this.prisma.vc_pool_payment_submissions.findMany({
      where: {
        pool_id: poolId,
        status: 'verified',
      },
      select: { pool_fee_amount: true },
    });

    const totalPoolFees = paymentSubmissions.reduce(
      (sum, s) => sum + (s.pool_fee_amount ? Number(s.pool_fee_amount) : 0),
      0,
    );

    const adminProfitFeePercent = Number(pool.admin_profit_fee_percent);

    // Create payouts for each member
    const result = await this.prisma.$transaction(async (tx) => {
      const payouts = [];
      let totalAdminFee = 0;

      for (const member of activeMembers) {
        const sharePercent = Number(member.share_percent || 0);
        const initialInvestment = Number(member.invested_amount_usdt);
        const grossPayout = (sharePercent * finalPoolValue) / 100;
        const profit = Math.max(0, grossPayout - initialInvestment);
        const adminFeeDeducted = (adminProfitFeePercent * profit) / 100;
        const netPayout = grossPayout - adminFeeDeducted;
        const profitLoss = netPayout - initialInvestment;

        totalAdminFee += adminFeeDeducted;

        const payout = await tx.vc_pool_payouts.create({
          data: {
            pool_id: poolId,
            member_id: member.member_id,
            payout_type: PAYOUT_TYPE.completion as any,
            initial_investment: initialInvestment,
            share_percent: sharePercent,
            pool_final_value: finalPoolValue,
            gross_payout: grossPayout,
            admin_fee_deducted: adminFeeDeducted,
            net_payout: netPayout,
            profit_loss: profitLoss,
            status: PAYOUT_STATUS.pending as any,
          },
        });

        payouts.push(payout);
      }

      // Update pool
      await tx.vc_pools.update({
        where: { pool_id: poolId },
        data: {
          status: POOL_STATUS.completed as any,
          completed_at: new Date(),
          current_pool_value_usdt: finalPoolValue,
          total_profit_usdt: totalProfit,
          admin_fee_earned_usdt: totalAdminFee,
          total_pool_fees_usdt: totalPoolFees,
        },
      });

      return { payouts, totalAdminFee, totalPoolFees };
    });

    this.logger.log(
      `Pool ${poolId} completed by admin ${adminId}. Created ${result.payouts.length} payouts.`,
    );

    return {
      pool_id: poolId,
      status: POOL_STATUS.completed,
      completed_at: new Date(),
      final_pool_value: finalPoolValue,
      total_profit: totalProfit,
      admin_fee_earned: result.totalAdminFee,
      total_pool_fees: result.totalPoolFees,
      payouts_created: result.payouts.length,
      payouts: result.payouts.map((p) => ({
        payout_id: p.payout_id,
        member_id: p.member_id,
        net_payout: Number(p.net_payout),
        profit_loss: Number(p.profit_loss),
        status: p.status,
      })),
      message: 'Pool completed. Payouts created. Transfer funds externally, then mark each payout as paid.',
    };
  }

  // ── Admin: List Payouts ──

  async listPayouts(adminId: string, poolId: string) {
    await this.validatePoolOwnership(adminId, poolId);

    const payouts = await this.prisma.vc_pool_payouts.findMany({
      where: { pool_id: poolId },
      include: {
        member: {
          include: {
            user: {
              select: { user_id: true, email: true, full_name: true },
            },
          },
        },
      },
      orderBy: { created_at: 'desc' },
    });

    return {
      payouts: payouts.map((p) => ({
        payout_id: p.payout_id,
        member: {
          member_id: p.member.member_id,
          user: {
            user_id: p.member.user.user_id,
            email: p.member.user.email,
            full_name: p.member.user.full_name,
          },
          payment_method: p.member.payment_method,
        },
        payout_type: p.payout_type,
        initial_investment: Number(p.initial_investment),
        share_percent: Number(p.share_percent),
        pool_final_value: p.pool_final_value ? Number(p.pool_final_value) : null,
        gross_payout: Number(p.gross_payout),
        admin_fee_deducted: Number(p.admin_fee_deducted),
        net_payout: Number(p.net_payout),
        profit_loss: Number(p.profit_loss),
        status: p.status,
        paid_at: p.paid_at,
        notes: p.notes,
        binance_tx_id: p.binance_tx_id,
        stripe_refund_id: p.stripe_refund_id,
        stripe_transfer_id: p.stripe_transfer_id,
        created_at: p.created_at,
      })),
    };
  }

  // ── Admin: Mark Payout as Paid ──

  async markPayoutPaid(
    adminId: string,
    poolId: string,
    payoutId: string,
    binanceTxId?: string,
    notes?: string,
  ) {
    await this.validatePoolOwnership(adminId, poolId);

    const payout = await this.prisma.vc_pool_payouts.findUnique({
      where: { payout_id: payoutId },
    });

    if (!payout || payout.pool_id !== poolId) {
      throw new NotFoundException('Payout not found');
    }

    if (payout.status !== PAYOUT_STATUS.pending) {
      throw new BadRequestException(
        `Payout is ${payout.status}, only 'pending' payouts can be marked as paid`,
      );
    }

    const updated = await this.prisma.vc_pool_payouts.update({
      where: { payout_id: payoutId },
      data: {
        status: PAYOUT_STATUS.completed as any,
        paid_at: new Date(),
        binance_tx_id: binanceTxId || null,
        notes: notes || null,
      },
    });

    this.logger.log(`Payout ${payoutId} marked as paid by admin ${adminId}`);

    return {
      payout_id: updated.payout_id,
      status: updated.status,
      paid_at: updated.paid_at,
      message: 'Payout marked as completed.',
    };
  }

  // ── Admin: Cancel Pool (Full Refund) ──

  async cancelPool(adminId: string, poolId: string) {
    const pool = await this.validatePoolOwnership(adminId, poolId);

    if (pool.status !== POOL_STATUS.open && pool.status !== POOL_STATUS.full) {
      throw new BadRequestException('Only open or full pools can be cancelled');
    }

    // Get all active members
    const activeMembers = await this.prisma.vc_pool_members.findMany({
      where: { pool_id: poolId, is_active: true },
      select: {
        member_id: true,
        invested_amount_usdt: true,
      },
    });

    // Create full refund payouts (no fee)
    const result = await this.prisma.$transaction(async (tx) => {
      const payouts = [];

      for (const member of activeMembers) {
        const investedAmount = Number(member.invested_amount_usdt);

        const payout = await tx.vc_pool_payouts.create({
          data: {
            pool_id: poolId,
            member_id: member.member_id,
            payout_type: PAYOUT_TYPE.pool_cancelled as any,
            initial_investment: investedAmount,
            share_percent: 0, // Not applicable for cancelled pools
            pool_final_value: null,
            gross_payout: investedAmount,
            admin_fee_deducted: 0,
            net_payout: investedAmount, // Full refund, no fee
            profit_loss: 0,
            status: PAYOUT_STATUS.pending as any,
          },
        });

        payouts.push(payout);
      }

      // Release all reserved seat reservations
      await tx.vc_pool_seat_reservations.updateMany({
        where: {
          pool_id: poolId,
          status: 'reserved',
        },
        data: {
          status: 'released' as any,
        },
      });

      // Expire all pending/processing payment submissions
      await tx.vc_pool_payment_submissions.updateMany({
        where: {
          pool_id: poolId,
          status: { in: ['pending', 'processing'] },
        },
        data: {
          status: 'expired' as any,
        },
      });

      // Update pool
      await tx.vc_pools.update({
        where: { pool_id: poolId },
        data: {
          status: POOL_STATUS.cancelled as any,
          cancelled_at: new Date(),
          reserved_seats_count: 0,
        },
      });

      return { payouts };
    });

    this.logger.log(
      `Pool ${poolId} cancelled by admin ${adminId}. Created ${result.payouts.length} refund payouts.`,
    );

    return {
      pool_id: poolId,
      status: POOL_STATUS.cancelled,
      cancelled_at: new Date(),
      refunds_created: result.payouts.length,
      payouts: result.payouts.map((p) => ({
        payout_id: p.payout_id,
        member_id: p.member_id,
        net_payout: Number(p.net_payout),
        status: p.status,
      })),
      message: 'Pool cancelled. Full refund payouts created. Transfer refunds externally, then mark each as paid.',
    };
  }

  // ── Helpers ──

  private async validatePoolOwnership(adminId: string, poolId: string) {
    const pool = await this.prisma.vc_pools.findUnique({
      where: { pool_id: poolId },
    });

    if (!pool) {
      throw new NotFoundException('Pool not found');
    }

    if (pool.admin_id !== adminId) {
      throw new ForbiddenException('You do not own this pool');
    }

    return pool;
  }
}

