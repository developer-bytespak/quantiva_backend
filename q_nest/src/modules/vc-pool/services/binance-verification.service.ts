import {
  Injectable,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { Decimal } from '@prisma/client/runtime/library';
import * as crypto from 'crypto';
import axios from 'axios';
import { EncryptionUtil } from '../../../common/utils/encryption.util';
import { AdminBinanceService } from '../../admin-auth/services/admin-binance.service';

interface BinanceP2POrderDetail {
  orderNumber: string;
  amount: string;
  totalPrice: string;
  unitPrice: string;
  orderStatus: string; // COMPLETED, CANCELLED, etc.
  createTime: number;
  asset: string;
  fiat: string;
  tradeType: string; // BUY or SELL
}

@Injectable()
export class BinanceVerificationService {
  private readonly logger = new Logger(BinanceVerificationService.name);
  private readonly binanceApiUrl = 'https://api.binance.com';

  constructor(
    private readonly prisma: PrismaService,
    private readonly adminBinanceService: AdminBinanceService,
  ) {}

  /**
   * Verify a single pending payment submission
   * Returns { verified, reason, amount }
   */
  async verifyPayment(submission: any): Promise<{
    verified: boolean;
    reason: string;
    amount?: Decimal;
  }> {
    try {
      if (!submission.binance_tx_id) {
        return { verified: false, reason: 'No Binance TX ID provided' };
      }

      // Get admin's Binance API keys
      const admin = await this.prisma.admins.findUnique({
        where: { admin_id: submission.pool.admin_id },
      });

      if (!admin) {
        return { verified: false, reason: 'Admin not found for this pool' };
      }

      if (!admin.binance_api_key_encrypted || !admin.binance_api_secret_encrypted) {
        this.logger.warn(
          `Admin ${admin.admin_id} has no Binance API keys configured. Skipping auto-verify.`,
        );
        return { verified: false, reason: 'Admin Binance API keys not configured - manual review required' };
      }

      // Decrypt keys
      const apiKey = this.decryptKey(admin.binance_api_key_encrypted);
      const apiSecret = this.decryptKey(admin.binance_api_secret_encrypted);

      // Query Binance P2P order history
      const orderDetail = await this.getP2POrderDetail(
        apiKey,
        apiSecret,
        submission.binance_tx_id,
      );

      if (!orderDetail) {
        return { verified: false, reason: `TX ID '${submission.binance_tx_id}' not found on Binance - user may have submitted incorrect TX ID or payment not yet confirmed by Binance` };
      }

      if (orderDetail.orderStatus !== 'COMPLETED') {
        return {
          verified: false,
          reason: `Binance order status is ${orderDetail.orderStatus}, not COMPLETED - payment may still be processing`,
        };
      }

      const actualAmount = new Decimal(orderDetail.totalPrice);
      const expectedAmount = submission.exact_amount_expected
        ? new Decimal(submission.exact_amount_expected.toString())
        : new Decimal(submission.total_amount.toString());

      // EXACT MATCH CHECK
      if (!actualAmount.equals(expectedAmount)) {
        const variance = actualAmount.minus(expectedAmount);
        const direction = variance.greaterThan(0) ? 'Overpayment' : 'Shortfall';
        const variancePercent = ((Math.abs(Number(variance)) / Number(expectedAmount)) * 100).toFixed(2);
        const reason = `${direction}: received ${actualAmount} USDT instead of ${expectedAmount} USDT (variance: ${variancePercent}%)`;
        return { verified: false, reason, amount: actualAmount };
      }

      return { verified: true, reason: 'Exact match confirmed', amount: actualAmount };
    } catch (error: any) {
      this.logger.error(`Verification error for submission ${submission.submission_id}: ${error.message}`);
      return { verified: false, reason: `Verification error: ${error.message}` };
    }
  }

  /**
   * Process all pending Binance payments
   * Called by the cron scheduler
   */
  async verifyPendingPayments(): Promise<{
    processed: number;
    approved: number;
    rejected: number;
    errors: number;
  }> {
    this.logger.log('Starting Binance payment verification cycle...');

    const stats = { processed: 0, approved: 0, rejected: 0, errors: 0 };

    const pendingPayments = await this.prisma.vc_pool_payment_submissions.findMany({
      where: {
        binance_payment_status: 'pending',
        binance_tx_id: { not: null },
        payment_method: 'binance',
      },
      include: {
        pool: {
          select: {
            pool_id: true,
            admin_id: true,
            name: true,
            max_members: true,
            verified_members_count: true,
            contribution_amount: true,
            pool_fee_percent: true,
            admin_profit_fee_percent: true,
            status: true,
          },
        },
      },
    });

    if (pendingPayments.length === 0) {
      this.logger.log('No pending Binance payments to verify.');
      return stats;
    }

    this.logger.log(`Found ${pendingPayments.length} pending Binance payment(s) to verify`);

    for (const payment of pendingPayments) {
      try {
        stats.processed++;
        const result = await this.verifyPayment(payment);

        if (result.verified) {
          await this.handleApproved(payment, result.amount!);
          stats.approved++;
        } else {
          await this.handleRejected(payment, result.reason, result.amount);
          stats.rejected++;
        }
      } catch (error: any) {
        stats.errors++;
        this.logger.error(
          `Failed to process payment ${payment.submission_id}: ${error.message}`,
        );
      }
    }

    this.logger.log(
      `Verification cycle complete: ${stats.processed} processed, ` +
        `${stats.approved} approved, ${stats.rejected} rejected, ${stats.errors} errors`,
    );

    return stats;
  }

  /**
   * Verify pending payments by checking admin's Binance deposit history
   * This is an alternative verification method that checks if deposits were received
   */
  async verifyPaymentsByDepositHistory(): Promise<{
    processed: number;
    approved: number;
    rejected: number;
    errors: number;
  }> {
    this.logger.log('Starting Binance deposit history verification cycle...');

    const stats = { processed: 0, approved: 0, rejected: 0, errors: 0 };

    // Get all pending payments
    const pendingPayments = await this.prisma.vc_pool_payment_submissions.findMany({
      where: {
        binance_payment_status: 'pending',
        payment_method: 'binance',
      },
      include: {
        pool: {
          select: {
            pool_id: true,
            admin_id: true,
            name: true,
            max_members: true,
            verified_members_count: true,
            contribution_amount: true,
            pool_fee_percent: true,
            admin_profit_fee_percent: true,
            status: true,
          },
        },
        user: {
          select: {
            user_id: true,
            email: true,
          },
        },
      },
    });

    if (pendingPayments.length === 0) {
      this.logger.log('No pending payments to verify via deposits.');
      return stats;
    }

    this.logger.log(`Found ${pendingPayments.length} pending payment(s) to verify via deposits`);

    for (const payment of pendingPayments) {
      try {
        stats.processed++;
        const result = await this.verifyPaymentViaDeposit(payment);

        if (result.verified) {
          await this.handleApproved(payment, result.amount!);
          this.logger.log(
            `✓ Payment ${payment.submission_id} verified via deposit of ${result.amount} USDT`,
          );
          stats.approved++;
        } else {
          this.logger.debug(
            `Payment ${payment.submission_id} not yet matched to deposit: ${result.reason}`,
          );
        }
      } catch (error: any) {
        stats.errors++;
        this.logger.error(
          `Failed to verify payment ${payment.submission_id} via deposits: ${error.message}`,
        );
      }
    }

    if (stats.approved > 0 || stats.rejected > 0) {
      this.logger.log(
        `Deposit verification cycle complete: ${stats.processed} processed, ` +
          `${stats.approved} approved via deposits, ${stats.errors} errors`,
      );
    }

    return stats;
  }

  /**
   * Verify a single payment submission by checking admin's deposit history
   * ONLY accepts EXACT amount matches - no tolerance for fees or variance
   */
  private async verifyPaymentViaDeposit(
    payment: any,
  ): Promise<{
    verified: boolean;
    reason: string;
    amount?: Decimal;
  }> {
    try {
      const admin = await this.prisma.admins.findUnique({
        where: { admin_id: payment.pool.admin_id },
      });

      if (!admin) {
        return { verified: false, reason: 'Admin not found' };
      }

      if (!admin.binance_api_key_encrypted || !admin.binance_api_secret_encrypted) {
        return { verified: false, reason: 'Admin Binance API keys not configured' };
      }

      // Get admin's deposit history for the last 24 hours
      const now = Date.now();
      const startTime = now - 24 * 60 * 60 * 1000; // Last 24 hours

      const deposits = await this.adminBinanceService.getAdminDepositHistory(
        payment.pool.admin_id,
        'USDT', // Assuming USDT payments
        1, // Status 1 = success
        0,
        100,
        startTime,
        now,
      );

      if (!deposits || deposits.length === 0) {
        return { verified: false, reason: 'No successful deposits found in last 24 hours' };
      }

      // Expected amount
      const expectedAmount = payment.exact_amount_expected
        ? new Decimal(payment.exact_amount_expected.toString())
        : new Decimal(payment.total_amount.toString());

      // Look for EXACT match only
      for (const deposit of deposits) {
        const depositAmount = new Decimal(deposit.amount.toString());

        // Check for EXACT match only - no tolerance
        if (depositAmount.equals(expectedAmount)) {
          this.logger.log(
            `✓ EXACT MATCH: Found deposit of ${depositAmount} USDT for payment ${payment.submission_id} (expected: ${expectedAmount})`,
          );
          return {
            verified: true,
            reason: `Exact amount verified: ${depositAmount} USDT`,
            amount: depositAmount,
          };
        }
      }

      // No exact match found
      return {
        verified: false,
        reason: `No exact amount match found (expected: ${expectedAmount} USDT, will check again in 5 minutes)`,
      };
    } catch (error: any) {
      this.logger.error(`Error verifying payment via deposit: ${error.message}`);
      return { verified: false, reason: `Verification error: ${error.message}` };
    }
  }

  /**
   * Handle approved payment: update submission, create member, log transaction
   */
  private async handleApproved(payment: any, actualAmount: Decimal) {
    await this.prisma.$transaction(async (tx) => {
      // 1. Update payment submission
      await tx.vc_pool_payment_submissions.update({
        where: { submission_id: payment.submission_id },
        data: {
          status: 'verified' as any,
          binance_payment_status: 'verified',
          binance_amount_received_usdt: actualAmount,
          exact_amount_received: actualAmount,
          verified_at: new Date(),
        },
      });

      // 2. Confirm reservation
      await tx.vc_pool_seat_reservations.update({
        where: { reservation_id: payment.reservation_id },
        data: { status: 'confirmed' as any },
      });

      // 3. Calculate share percent
      const totalPoolValue = new Decimal(payment.pool.max_members)
        .times(payment.pool.contribution_amount);
      const sharePercent = new Decimal(payment.investment_amount)
        .dividedBy(totalPoolValue)
        .times(100);

      // 4. Create pool member
      const member = await tx.vc_pool_members.create({
        data: {
          pool_id: payment.pool_id,
          user_id: payment.user_id,
          payment_method: payment.payment_method,
          invested_amount_usdt: payment.investment_amount,
          share_percent: sharePercent,
          is_active: true,
        },
      });

      // 5. Update pool counters
      const updatedPool = await tx.vc_pools.update({
        where: { pool_id: payment.pool_id },
        data: {
          verified_members_count: { increment: 1 },
          reserved_seats_count: { decrement: 1 },
        },
      });

      // 6. Auto-transition pool to 'full' if all seats filled
      if (updatedPool.verified_members_count >= updatedPool.max_members) {
        await tx.vc_pools.update({
          where: { pool_id: payment.pool_id },
          data: { status: 'full' as any },
        });
        this.logger.log(`Pool ${payment.pool_id} is now full`);
      }

      // 7. Log audit transaction
      await tx.vc_pool_transactions.create({
        data: {
          pool_id: payment.pool_id,
          user_id: payment.user_id,
          payment_submission_id: payment.submission_id,
          member_id: member.member_id,
          transaction_type: 'payment_verified',
          amount_usdt: actualAmount,
          binance_tx_id: payment.tx_hash || payment.binance_tx_id,
          expected_amount: payment.exact_amount_expected || payment.total_amount,
          actual_amount_received: actualAmount,
          status: 'verified',
          resolved_at: new Date(),
          description: payment.tx_hash
            ? `Payment verified via on-chain deposit. TX Hash: ${payment.tx_hash}. Exact match: ${actualAmount} USDT`
            : `Payment verified via Binance P2P. Exact match: ${actualAmount} USDT`,
        },
      });
    });

    this.logger.log(
      `✓ Payment APPROVED: ${payment.submission_id} | User: ${payment.user_id} | Amount: ${actualAmount}`,
    );
  }

  /**
   * Handle rejected payment: update submission, release seat, log transaction
   */
  private async handleRejected(
    payment: any,
    reason: string,
    actualAmount?: Decimal,
  ) {
    await this.prisma.$transaction(async (tx) => {
      // 1. Update payment submission as rejected
      await tx.vc_pool_payment_submissions.update({
        where: { submission_id: payment.submission_id },
        data: {
          status: 'rejected' as any,
          binance_payment_status: 'rejected',
          binance_amount_received_usdt: actualAmount || null,
          exact_amount_received: actualAmount || null,
          rejection_reason: reason,
          refund_initiated_at: actualAmount ? new Date() : null,
          refund_reason: actualAmount ? reason : null,
        },
      });

      // 2. Release the seat reservation
      await tx.vc_pool_seat_reservations.update({
        where: { reservation_id: payment.reservation_id },
        data: { status: 'released' as any },
      });

      // 3. Decrement reserved seats
      await tx.vc_pools.update({
        where: { pool_id: payment.pool_id },
        data: { reserved_seats_count: { decrement: 1 } },
      });

      // 4. Log audit transaction with detailed error information
      await tx.vc_pool_transactions.create({
        data: {
          pool_id: payment.pool_id,
          user_id: payment.user_id,
          transaction_type: 'payment_rejected',
          amount_usdt: actualAmount || payment.total_amount,
          binance_tx_id: payment.tx_hash || payment.binance_tx_id,
          expected_amount: payment.exact_amount_expected || payment.total_amount,
          actual_amount_received: actualAmount || null,
          status: 'rejected',
          resolved_at: new Date(),
          description: actualAmount
            ? `Payment verification FAILED. Reason: ${reason}. User sent ${actualAmount} USDT but expected amount was ${payment.exact_amount_expected || payment.total_amount} USDT. Refund of ${actualAmount} USDT has been initiated.`
            : `Payment verification FAILED. Reason: ${reason}. No funds were received or TX not found. No refund needed.`,
        },
      });
    });

    this.logger.log(
      `✗ Payment REJECTED: ${payment.submission_id} | User: ${payment.user_id} | Reason: ${reason}`,
    );
  }

  /**
   * Get P2P order detail from Binance API
   */
  private async getP2POrderDetail(
    apiKey: string,
    apiSecret: string,
    orderNumber: string,
  ): Promise<BinanceP2POrderDetail | null> {
    try {
      const timestamp = Date.now();
      const params = `timestamp=${timestamp}`;
      const signature = this.signRequest(params, apiSecret);

      const body = {
        orderNumber,
      };

      const response = await axios.post(
        `${this.binanceApiUrl}/sapi/v1/c2c/orderMatch/getUserOrderDetail`,
        body,
        {
          headers: {
            'X-MBX-APIKEY': apiKey,
            'Content-Type': 'application/json',
          },
          params: {
            timestamp,
            signature,
          },
          timeout: 15000,
        },
      );

      if (response.data?.data) {
        return response.data.data as BinanceP2POrderDetail;
      }

      return null;
    } catch (error: any) {
      // If 404 or specific error, TX doesn't exist
      if (error.response?.status === 400 || error.response?.status === 404) {
        this.logger.warn(`Binance P2P order ${orderNumber} not found`);
        return null;
      }
      this.logger.error(`Binance API error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Create HMAC-SHA256 signature for Binance API
   */
  private signRequest(queryString: string, apiSecret: string): string {
    return crypto
      .createHmac('sha256', apiSecret)
      .update(queryString)
      .digest('hex');
  }

  /**
   * Decrypt Binance API key using AES-256-GCM
   */
  private decryptKey(encryptedKey: string): string {
    const encryptionKey = process.env.ENCRYPTION_KEY;
    if (!encryptionKey) {
      throw new Error('ENCRYPTION_KEY not found in environment variables');
    }
    return EncryptionUtil.decrypt(encryptedKey, encryptionKey);
  }
}
