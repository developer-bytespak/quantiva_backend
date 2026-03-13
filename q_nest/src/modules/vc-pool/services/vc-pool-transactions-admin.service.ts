import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

@Injectable()
export class VcPoolTransactionsAdminService {
  private readonly logger = new Logger(VcPoolTransactionsAdminService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * List all transactions for a pool with detailed information
   */
  async listTransactions(
    adminId: string,
    poolId: string,
    filters: {
      status?: string;
      transactionType?: string;
      dateFrom?: Date;
      dateTo?: Date;
      userId?: string;
      page?: number;
      limit?: number;
    },
  ) {
    // Validate pool ownership
    const pool = await this.validatePoolOwnership(adminId, poolId);

    const page = filters.page && filters.page > 0 ? filters.page : 1;
    const limit = filters.limit && filters.limit > 0 ? Math.min(filters.limit, 100) : 20;
    const skip = (page - 1) * limit;

    // Build where clause
    const where: Record<string, any> = { pool_id: poolId };
    if (filters.status) where.status = filters.status;
    if (filters.transactionType) where.transaction_type = filters.transactionType;
    if (filters.userId) where.user_id = filters.userId;
    if (filters.dateFrom || filters.dateTo) {
      where.created_at = {};
      if (filters.dateFrom) where.created_at.gte = filters.dateFrom;
      if (filters.dateTo) where.created_at.lte = filters.dateTo;
    }

    // Fetch transactions
    const [transactions, total] = await this.prisma.$transaction([
      this.prisma.vc_pool_transactions.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
        include: {
          user: {
            select: { user_id: true, email: true, username: true, full_name: true },
          },
          payment_submission: {
            select: {
              submission_id: true,
              payment_method: true,
              status: true,
              binance_payment_status: true,
              exact_amount_expected: true,
              exact_amount_received: true,
              rejection_reason: true,
              refund_initiated_at: true,
              refund_reason: true,
            },
          },
          member: {
            select: { member_id: true, invested_amount_usdt: true, share_percent: true },
          },
        },
      }),
      this.prisma.vc_pool_transactions.count({ where }),
    ]);

    // Format response
    const formattedTransactions = transactions.map((tx) => ({
      transaction_id: tx.transaction_id,
      pool_id: tx.pool_id,
      user: tx.user,
      transaction_type: tx.transaction_type,
      amount_usdt: tx.amount_usdt,
      binance_tx_id: tx.binance_tx_id,
      expected_amount: tx.expected_amount,
      actual_amount_received: tx.actual_amount_received,
      status: tx.status,
      description: tx.description,
      payment_submission: tx.payment_submission
        ? {
            submission_id: tx.payment_submission.submission_id,
            payment_method: tx.payment_submission.payment_method,
            status: tx.payment_submission.status,
            binance_payment_status: tx.payment_submission.binance_payment_status,
            exact_amount_expected: tx.payment_submission.exact_amount_expected,
            exact_amount_received: tx.payment_submission.exact_amount_received,
            rejection_reason: tx.payment_submission.rejection_reason,
            refund_initiated_at: tx.payment_submission.refund_initiated_at,
            refund_reason: tx.payment_submission.refund_reason,
          }
        : null,
      member: tx.member || null,
      created_at: tx.created_at,
      resolved_at: tx.resolved_at,
    }));

    return {
      pool_id: poolId,
      pool_name: pool.name,
      transactions: formattedTransactions,
      summary: {
        total_transactions: total,
        verified: transactions.filter((t) => t.status === 'verified').length,
        rejected: transactions.filter((t) => t.status === 'rejected').length,
        pending: transactions.filter((t) => t.status === 'pending').length,
        failed: transactions.filter((t) => t.status === 'failed').length,
      },
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get detailed information about a single transaction
   */
  async getTransactionDetail(adminId: string, poolId: string, txId: string) {
    // Validate pool ownership
    await this.validatePoolOwnership(adminId, poolId);

    const transaction = await this.prisma.vc_pool_transactions.findUnique({
      where: { transaction_id: txId },
      include: {
        user: {
          select: {
            user_id: true,
            email: true,
            username: true,
            full_name: true,
            binance_deposit_address: true,
          },
        },
        payment_submission: {
          select: {
            submission_id: true,
            payment_method: true,
            status: true,
            binance_payment_status: true,
            investment_amount: true,
            pool_fee_amount: true,
            total_amount: true,
            exact_amount_expected: true,
            exact_amount_received: true,
            binance_tx_id: true,
            binance_tx_timestamp: true,
            screenshot_url: true,
            rejection_reason: true,
            refund_initiated_at: true,
            refund_reason: true,
            admin_notes: true,
            verified_at: true,
            submitted_at: true,
            payment_deadline: true,
            reservation: {
              select: {
                status: true,
                expires_at: true,
                payment_method: true,
              },
            },
          },
        },
        member: {
          select: {
            member_id: true,
            invested_amount_usdt: true,
            share_percent: true,
            joined_at: true,
            is_active: true,
          },
        },
        pool: {
          select: {
            pool_id: true,
            name: true,
            contribution_amount: true,
            pool_fee_percent: true,
            admin_profit_fee_percent: true,
            coin_type: true,
          },
        },
      },
    });

    if (!transaction) {
      throw new NotFoundException('Transaction not found');
    }

    if (transaction.pool_id !== poolId) {
      throw new ForbiddenException('Transaction does not belong to this pool');
    }

    // Calculate useful derived data
    const shortfall = transaction.expected_amount
      ? Number(transaction.expected_amount) - (Number(transaction.actual_amount_received) || 0)
      : null;

    const overpayment = transaction.actual_amount_received && transaction.expected_amount
      ? Number(transaction.actual_amount_received) - Number(transaction.expected_amount)
      : null;

    const amountVariance = shortfall !== null ? shortfall : overpayment;
    const variancePercent = transaction.expected_amount && amountVariance
      ? ((amountVariance / Number(transaction.expected_amount)) * 100).toFixed(2)
      : null;

    return {
      transaction_id: transaction.transaction_id,
      pool: transaction.pool,
      user: transaction.user,
      transaction_type: transaction.transaction_type,
      amount_usdt: transaction.amount_usdt,
      binance_tx_id: transaction.binance_tx_id,
      status: transaction.status,
      description: transaction.description,
      created_at: transaction.created_at,
      resolved_at: transaction.resolved_at,
      
      // Payment submission details
      payment_submission: transaction.payment_submission
        ? {
            submission_id: transaction.payment_submission.submission_id,
            payment_method: transaction.payment_submission.payment_method,
            status: transaction.payment_submission.status,
            binance_payment_status: transaction.payment_submission.binance_payment_status,
            investment_amount: transaction.payment_submission.investment_amount,
            pool_fee_amount: transaction.payment_submission.pool_fee_amount,
            total_amount: transaction.payment_submission.total_amount,
            exact_amount_expected: transaction.payment_submission.exact_amount_expected,
            exact_amount_received: transaction.payment_submission.exact_amount_received,
            binance_tx_id: transaction.payment_submission.binance_tx_id,
            binance_tx_timestamp: transaction.payment_submission.binance_tx_timestamp,
            screenshot_url: transaction.payment_submission.screenshot_url,
            rejection_reason: transaction.payment_submission.rejection_reason,
            refund_initiated_at: transaction.payment_submission.refund_initiated_at,
            refund_reason: transaction.payment_submission.refund_reason,
            admin_notes: transaction.payment_submission.admin_notes,
            verified_at: transaction.payment_submission.verified_at,
            submitted_at: transaction.payment_submission.submitted_at,
            payment_deadline: transaction.payment_submission.payment_deadline,
            reservation: transaction.payment_submission.reservation,
          }
        : null,

      // Member details (if transaction resulted in member creation)
      member: transaction.member || null,

      // Variance analysis (for debugging shortfall/overpayment)
      variance_analysis:
        transaction.expected_amount && transaction.actual_amount_received
          ? {
              expected_amount: transaction.expected_amount,
              actual_amount: transaction.actual_amount_received,
              variance_amount: amountVariance,
              variance_percent: variancePercent,
              variance_type: shortfall && shortfall > 0 ? 'SHORTFALL' : overpayment && overpayment > 0 ? 'OVERPAYMENT' : 'EXACT_MATCH',
            }
          : null,

      // Admin actions available
      available_actions: this.getAvailableActions(transaction),
    };
  }

  /**
   * List transactions by status grouped by user
   * Useful for seeing which users have pending/failed payments
   */
  async listTransactionsByUser(
    adminId: string,
    poolId: string,
  ) {
    // Validate pool ownership
    await this.validatePoolOwnership(adminId, poolId);

    const transactions = await this.prisma.vc_pool_transactions.findMany({
      where: { pool_id: poolId },
      include: {
        user: {
          select: { user_id: true, email: true, username: true, full_name: true },
        },
        payment_submission: {
          select: {
            binance_payment_status: true,
            exact_amount_expected: true,
            exact_amount_received: true,
          },
        },
      },
      orderBy: [{ user_id: 'asc' }, { created_at: 'desc' }],
    });

    // Group by user
    const groupedByUser: Record<string, any> = {};

    for (const tx of transactions) {
      const userId = tx.user_id;
      if (!groupedByUser[userId]) {
        groupedByUser[userId] = {
          user: tx.user,
          transactions: [],
          statuses: {
            total: 0,
            verified: 0,
            rejected: 0,
            pending: 0,
            failed: 0,
          },
          total_amount: 0,
        };
      }

      groupedByUser[userId].transactions.push({
        transaction_id: tx.transaction_id,
        type: tx.transaction_type,
        status: tx.status,
        amount: tx.amount_usdt,
        created_at: tx.created_at,
      });

      groupedByUser[userId].statuses.total += 1;
      groupedByUser[userId].statuses[tx.status] += 1;
      groupedByUser[userId].total_amount += Number(tx.amount_usdt);
    }

    return {
      pool_id: poolId,
      users_with_transactions: Object.values(groupedByUser),
      summary: {
        total_users: Object.keys(groupedByUser).length,
        total_transactions: transactions.length,
      },
    };
  }

  /**
   * Get transactions requiring admin action
   */
  async getPendingActions(adminId: string, poolId: string) {
    // Validate pool ownership
    await this.validatePoolOwnership(adminId, poolId);

    // Find transactions that need attention
    const alertTransactions = await this.prisma.vc_pool_transactions.findMany({
      where: {
        pool_id: poolId,
        status: { in: ['rejected', 'failed', 'pending'] },
      },
      include: {
        user: {
          select: { user_id: true, email: true, username: true, full_name: true },
        },
        payment_submission: {
          select: {
            submission_id: true,
            status: true,
            binance_payment_status: true,
            refund_initiated_at: true,
            rejection_reason: true,
          },
        },
      },
      orderBy: { created_at: 'desc' },
    });

    return {
      pool_id: poolId,
      alerts: {
        rejected_payments: alertTransactions.filter((t) => t.status === 'rejected'),
        failed_payments: alertTransactions.filter((t) => t.status === 'failed'),
        pending_payments: alertTransactions.filter((t) => t.status === 'pending'),
      },
      action_items: {
        rejections_to_notify: alertTransactions
          .filter((t) => t.status === 'rejected' && t.payment_submission)
          .map((t) => ({
            type: 'rejection_notification',
            user: t.user,
            reason: t.payment_submission?.rejection_reason || t.description,
            created_at: t.created_at,
          })),
      },
      summary: {
        total_alerts: alertTransactions.length,
        requires_immediate_action: alertTransactions.filter(
          (t) => t.status === 'rejected' || t.status === 'failed',
        ).length,
      },
    };
  }

  // ── Helpers ──

  private async validatePoolOwnership(adminId: string, poolId: string) {
    const pool = await this.prisma.vc_pools.findUnique({
      where: { pool_id: poolId },
      select: { pool_id: true, admin_id: true, name: true },
    });

    if (!pool) {
      throw new NotFoundException('Pool not found');
    }

    if (pool.admin_id !== adminId) {
      throw new ForbiddenException('You do not own this pool');
    }

    return pool;
  }

  private getAvailableActions(transaction: any): string[] {
    const actions: string[] = [];

    if (transaction.status === 'rejected') {
      actions.push('view_rejection_reason', 'initiate_manual_refund', 'contact_user');
    }

    if (transaction.status === 'failed') {
      actions.push('retry_verification', 'initiate_manual_refund', 'contact_user');
    }

    if (transaction.status === 'pending') {
      actions.push('manually_approve', 'manually_reject', 'view_binance_status');
    }

    if (transaction.payment_submission?.refund_initiated_at && transaction.status !== 'verified') {
      actions.push('mark_refund_completed', 'view_refund_details');
    }

    return actions;
  }
}
