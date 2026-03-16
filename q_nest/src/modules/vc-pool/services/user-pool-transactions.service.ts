import {
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

@Injectable()
export class UserPoolTransactionsService {
  private readonly logger = new Logger(UserPoolTransactionsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Get complete transaction history for a user across all pools
   * Includes: payment submissions, confirmations, rejections, refunds, etc.
   */
  async getUserTransactionHistory(
    userId: string,
    filters: {
      poolId?: string;
      status?: string;
      transactionType?: string;
      dateFrom?: Date;
      dateTo?: Date;
      page?: number;
      limit?: number;
    },
  ) {
    const page = filters.page && filters.page > 0 ? filters.page : 1;
    const limit = filters.limit && filters.limit > 0 ? Math.min(filters.limit, 50) : 20;
    const skip = (page - 1) * limit;

    // Build where clause
    const where: Record<string, any> = { user_id: userId };
    if (filters.poolId) where.pool_id = filters.poolId;
    if (filters.status) where.status = filters.status;
    if (filters.transactionType) where.transaction_type = filters.transactionType;
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
          pool: {
            select: {
              pool_id: true,
              name: true,
              coin_type: true,
              contribution_amount: true,
              pool_fee_percent: true,
            },
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
              verified_at: true,
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
        },
      }),
      this.prisma.vc_pool_transactions.count({ where }),
    ]);

    // Format response
    const formattedTransactions = transactions.map((tx) => ({
      transaction_id: tx.transaction_id,
      pool: tx.pool,
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
            verified_at: tx.payment_submission.verified_at,
          }
        : null,
      member: tx.member || null,
      created_at: tx.created_at,
      resolved_at: tx.resolved_at,
    }));

    return {
      transactions: formattedTransactions,
      summary: {
        total_transactions: total,
        by_status: {
          verified: transactions.filter((t) => t.status === 'verified').length,
          rejected: transactions.filter((t) => t.status === 'rejected').length,
          pending: transactions.filter((t) => t.status === 'pending').length,
          failed: transactions.filter((t) => t.status === 'failed').length,
        },
        by_type: {
          payment_submitted: transactions.filter((t) => t.transaction_type === 'payment_submitted').length,
          payment_verified: transactions.filter((t) => t.transaction_type === 'payment_verified').length,
          payment_rejected: transactions.filter((t) => t.transaction_type === 'payment_rejected').length,
          payment_expired_refund_initiated: transactions.filter((t) => t.transaction_type === 'payment_expired_refund_initiated').length,
          member_created: transactions.filter((t) => t.transaction_type === 'member_created').length,
        },
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
   * Get transaction history for a specific pool
   */
  async getUserPoolTransactions(userId: string, poolId: string) {
    const transactions = await this.prisma.vc_pool_transactions.findMany({
      where: {
        user_id: userId,
        pool_id: poolId,
      },
      orderBy: { created_at: 'desc' },
      include: {
        pool: {
          select: {
            pool_id: true,
            name: true,
            coin_type: true,
          },
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
          select: {
            member_id: true,
            invested_amount_usdt: true,
            share_percent: true,
          },
        },
      },
    });

    if (transactions.length === 0) {
      throw new NotFoundException(`No transactions found for user in pool ${poolId}`);
    }

    return {
      pool_id: poolId,
      pool_name: transactions[0].pool.name,
      transactions: transactions.map((tx) => ({
        transaction_id: tx.transaction_id,
        transaction_type: tx.transaction_type,
        amount_usdt: tx.amount_usdt,
        binance_tx_id: tx.binance_tx_id,
        status: tx.status,
        description: tx.description,
        payment_submission: tx.payment_submission || null,
        member: tx.member || null,
        created_at: tx.created_at,
        resolved_at: tx.resolved_at,
      })),
      summary: {
        total_transactions: transactions.length,
        verified: transactions.filter((t) => t.status === 'verified').length,
        rejected: transactions.filter((t) => t.status === 'rejected').length,
        pending: transactions.filter((t) => t.status === 'pending').length,
      },
    };
  }

  /**
   * Get single transaction detail
   */
  async getUserTransactionDetail(userId: string, transactionId: string) {
    const transaction = await this.prisma.vc_pool_transactions.findUnique({
      where: { transaction_id: transactionId },
      include: {
        pool: {
          select: {
            pool_id: true,
            name: true,
            coin_type: true,
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
            rejection_reason: true,
            refund_initiated_at: true,
            refund_reason: true,
            verified_at: true,
            submitted_at: true,
            payment_deadline: true,
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
      },
    });

    if (!transaction) {
      throw new NotFoundException('Transaction not found');
    }

    if (transaction.user_id !== userId) {
      throw new NotFoundException('Transaction does not belong to this user');
    }

    // Calculate variance analysis
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
      transaction_type: transaction.transaction_type,
      amount_usdt: transaction.amount_usdt,
      binance_tx_id: transaction.binance_tx_id,
      status: transaction.status,
      description: transaction.description,
      created_at: transaction.created_at,
      resolved_at: transaction.resolved_at,
      
      payment_submission: transaction.payment_submission || null,
      member: transaction.member || null,
      
      // Variance analysis
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
    };
  }

  /**
   * Get summary of all user transactions by type
   */
  async getUserTransactionSummary(userId: string) {
    const transactions = await this.prisma.vc_pool_transactions.findMany({
      where: { user_id: userId },
      select: {
        transaction_type: true,
        status: true,
        amount_usdt: true,
      },
    });

    const summary = {
      total_transactions: transactions.length,
      total_amount_involved: transactions.reduce((sum, tx) => sum + Number(tx.amount_usdt), 0),
      by_status: {
        verified: transactions.filter((t) => t.status === 'verified').length,
        rejected: transactions.filter((t) => t.status === 'rejected').length,
        pending: transactions.filter((t) => t.status === 'pending').length,
        failed: transactions.filter((t) => t.status === 'failed').length,
      },
      by_type: {
        payment_submitted: transactions.filter((t) => t.transaction_type === 'payment_submitted').length,
        payment_verified: transactions.filter((t) => t.transaction_type === 'payment_verified').length,
        payment_rejected: transactions.filter((t) => t.transaction_type === 'payment_rejected').length,
        payment_expired_refund_initiated: transactions.filter((t) => t.transaction_type === 'payment_expired_refund_initiated').length,
        member_created: transactions.filter((t) => t.transaction_type === 'member_created').length,
      },
      approved_total: transactions
        .filter((t) => t.status === 'verified')
        .reduce((sum, tx) => sum + Number(tx.amount_usdt), 0),
      rejected_total: transactions
        .filter((t) => t.status === 'rejected')
        .reduce((sum, tx) => sum + Number(tx.amount_usdt), 0),
    };

    return summary;
  }
}
