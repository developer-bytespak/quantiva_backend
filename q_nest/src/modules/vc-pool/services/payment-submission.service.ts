import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

@Injectable()
export class PaymentSubmissionService {
  private readonly logger = new Logger(PaymentSubmissionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * User submits Binance P2P TX ID for an existing pending payment.
   * Called AFTER the user already joined the pool (seat reserved + payment record created).
   */
  async submitBinanceTxId(
    userId: string,
    poolId: string,
    binanceTxId: string,
    binanceTxTimestamp: Date,
  ) {
    // 1. Validate reservation exists and is active
    const reservation = await this.prisma.vc_pool_seat_reservations.findUnique({
      where: { pool_id_user_id: { pool_id: poolId, user_id: userId } },
    });

    if (!reservation) {
      throw new NotFoundException('No reservation found for this pool');
    }

    if (reservation.status !== 'reserved') {
      throw new BadRequestException(
        `Seat reservation is ${reservation.status}, cannot submit payment`,
      );
    }

    if (new Date() >= reservation.expires_at) {
      throw new BadRequestException(
        'Reservation has expired. Please join the pool again.',
      );
    }

    // 2. Find existing pending payment submission
    const submission = await this.prisma.vc_pool_payment_submissions.findFirst({
      where: {
        reservation_id: reservation.reservation_id,
        payment_method: 'binance',
      },
    });

    if (!submission) {
      throw new NotFoundException('No payment submission found for this reservation');
    }

    if (submission.status !== 'pending') {
      throw new BadRequestException(
        `Payment is already ${submission.status}. Cannot update TX ID.`,
      );
    }

    // 3. Check if TX ID is already used by another submission
    const existingTx = await this.prisma.vc_pool_payment_submissions.findUnique({
      where: { binance_tx_id: binanceTxId },
    });

    if (existingTx && existingTx.submission_id !== submission.submission_id) {
      throw new ConflictException('This Binance TX ID has already been used');
    }

    // 4. Calculate exact expected amount
    const pool = await this.prisma.vc_pools.findUnique({
      where: { pool_id: poolId },
    });

    if (!pool) throw new NotFoundException('Pool not found');

    const investmentAmount = Number(pool.contribution_amount);
    const poolFee = investmentAmount * Number(pool.pool_fee_percent) / 100;
    const exactExpected = investmentAmount + poolFee;

    // 5. Update payment submission with TX details
    const updated = await this.prisma.vc_pool_payment_submissions.update({
      where: { submission_id: submission.submission_id },
      data: {
        binance_tx_id: binanceTxId,
        binance_tx_timestamp: binanceTxTimestamp,
        exact_amount_expected: exactExpected,
        binance_payment_status: 'pending',
        status: 'processing' as any,
      },
    });

    // 6. Log audit transaction
    await this.prisma.vc_pool_transactions.create({
      data: {
        pool_id: poolId,
        user_id: userId,
        payment_submission_id: submission.submission_id,
        transaction_type: 'payment_submitted',
        amount_usdt: exactExpected,
        binance_tx_id: binanceTxId,
        binance_tx_timestamp: binanceTxTimestamp,
        expected_amount: exactExpected,
        status: 'pending',
        description: `User submitted Binance P2P TX ID: ${binanceTxId}`,
      },
    });

    this.logger.log(
      `User ${userId} submitted Binance TX ${binanceTxId} for pool ${poolId}`,
    );

    return {
      message: 'Binance TX ID submitted. Verification in progress...',
      submission_id: updated.submission_id,
      binance_tx_id: binanceTxId,
      exact_amount_expected: exactExpected,
      status: 'processing',
      binance_payment_status: 'pending',
    };
  }

  /**
   * Get all user's payment submissions across all pools
   */
  async getUserSubmissions(userId: string) {
    const submissions = await this.prisma.vc_pool_payment_submissions.findMany({
      where: { user_id: userId },
      include: {
        pool: {
          select: {
            pool_id: true,
            name: true,
            contribution_amount: true,
            coin_type: true,
          },
        },
      },
      orderBy: { submitted_at: 'desc' },
    });

    return submissions.map((sub) => ({
      submission_id: sub.submission_id,
      pool_id: sub.pool_id,
      pool_name: sub.pool.name,
      coin_type: sub.pool.coin_type,
      payment_method: sub.payment_method,
      total_amount: sub.total_amount,
      investment_amount: sub.investment_amount,
      pool_fee_amount: sub.pool_fee_amount,
      binance_tx_id: sub.binance_tx_id,
      status: sub.status,
      binance_payment_status: sub.binance_payment_status,
      exact_amount_expected: sub.exact_amount_expected,
      exact_amount_received: sub.exact_amount_received,
      refund_reason: sub.refund_reason,
      rejection_reason: sub.rejection_reason,
      verified_at: sub.verified_at,
      submitted_at: sub.submitted_at,
      payment_deadline: sub.payment_deadline,
    }));
  }

  /**
   * Get single submission details for a user
   */
  async getSubmissionDetail(userId: string, submissionId: string) {
    const submission = await this.prisma.vc_pool_payment_submissions.findUnique({
      where: { submission_id: submissionId },
      include: {
        pool: {
          select: {
            pool_id: true,
            name: true,
            contribution_amount: true,
            coin_type: true,
            admin: { select: { binance_uid: true } },
          },
        },
        reservation: {
          select: {
            status: true,
            expires_at: true,
          },
        },
      },
    });

    if (!submission || submission.user_id !== userId) {
      throw new NotFoundException('Submission not found');
    }

    return {
      submission_id: submission.submission_id,
      pool_id: submission.pool_id,
      pool_name: submission.pool.name,
      coin_type: submission.pool.coin_type,
      payment_method: submission.payment_method,
      total_amount: submission.total_amount,
      investment_amount: submission.investment_amount,
      pool_fee_amount: submission.pool_fee_amount,
      binance_tx_id: submission.binance_tx_id,
      status: submission.status,
      binance_payment_status: submission.binance_payment_status,
      exact_amount_expected: submission.exact_amount_expected,
      exact_amount_received: submission.exact_amount_received,
      refund_reason: submission.refund_reason,
      rejection_reason: submission.rejection_reason,
      verified_at: submission.verified_at,
      submitted_at: submission.submitted_at,
      payment_deadline: submission.payment_deadline,
      screenshot_url: submission.screenshot_url,
      reservation_status: submission.reservation?.status,
      reservation_expires_at: submission.reservation?.expires_at,
      admin_binance_uid: submission.pool.admin?.binance_uid,
    };
  }

  /**
   * Get payment transaction history for a user
   */
  async getUserTransactions(userId: string) {
    const transactions = await this.prisma.vc_pool_transactions.findMany({
      where: { user_id: userId },
      include: {
        pool: {
          select: { pool_id: true, name: true },
        },
      },
      orderBy: { created_at: 'desc' },
      take: 50,
    });

    return transactions.map((tx) => ({
      transaction_id: tx.transaction_id,
      pool_id: tx.pool_id,
      pool_name: tx.pool.name,
      transaction_type: tx.transaction_type,
      amount_usdt: tx.amount_usdt,
      binance_tx_id: tx.binance_tx_id,
      expected_amount: tx.expected_amount,
      actual_amount_received: tx.actual_amount_received,
      status: tx.status,
      description: tx.description,
      created_at: tx.created_at,
      resolved_at: tx.resolved_at,
    }));
  }
}
