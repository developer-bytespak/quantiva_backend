import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { Decimal } from '@prisma/client/runtime/library';
import { AdminBinanceService } from '../../admin-auth/services/admin-binance.service';

@Injectable()
export class BinanceVerificationService {
  private readonly logger = new Logger(BinanceVerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adminBinanceService: AdminBinanceService,
  ) {}

  /**
   * Verify pending payments by checking the admin's Binance / Binance.US deposit history.
   * Routes to the correct exchange (Binance.com or Binance.US) via AdminBinanceService.
   */
  async verifyPaymentsByDepositHistory(): Promise<{
    processed: number;
    approved: number;
    rejected: number;
    errors: number;
  }> {
    this.logger.log('Starting Binance deposit history verification cycle...');

    const stats = { processed: 0, approved: 0, rejected: 0, errors: 0 };

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
   * Verify a single payment by checking the admin's deposit history.
   * Match priority:
   *   1. tx_hash exact match (strongest signal — disambiguates duplicate amounts)
   *   2. exact amount match (fallback when user submitted no tx_hash)
   */
  private async verifyPaymentViaDeposit(payment: any): Promise<{
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

      // Pull the admin's deposit history for the last 24h.
      // AdminBinanceService routes to BinanceService or BinanceUSService based on
      // the admin's connected exchange.
      const now = Date.now();
      const startTime = now - 24 * 60 * 60 * 1000;

      let deposits: any[];
      try {
        deposits = await this.adminBinanceService.getAdminDepositHistory(
          payment.pool.admin_id,
          'USDT',
          1, // status = success
          0,
          100,
          startTime,
          now,
        );
      } catch (err: any) {
        return {
          verified: false,
          reason: `Could not fetch admin deposit history: ${err.message}`,
        };
      }

      if (!deposits || deposits.length === 0) {
        return { verified: false, reason: 'No successful deposits found in last 24 hours' };
      }

      const expectedAmount = payment.exact_amount_expected
        ? new Decimal(payment.exact_amount_expected.toString())
        : new Decimal(payment.total_amount.toString());

      const submittedHash: string | null = payment.tx_hash || null;
      const submittedHashLower = submittedHash ? submittedHash.toLowerCase() : null;

      // 1. Strongest match: tx_hash from user matches deposit.txId
      if (submittedHashLower) {
        const byHash = deposits.find(
          (d) => typeof d.txId === 'string' && d.txId.toLowerCase() === submittedHashLower,
        );
        if (byHash) {
          const depositAmount = new Decimal(byHash.amount.toString());
          if (depositAmount.equals(expectedAmount)) {
            this.logger.log(
              `✓ TX HASH MATCH: deposit ${byHash.txId} of ${depositAmount} USDT for payment ${payment.submission_id}`,
            );
            return {
              verified: true,
              reason: `TX hash verified: ${depositAmount} USDT`,
              amount: depositAmount,
            };
          }
          // Hash matched but amount didn't — surface a clear reason.
          return {
            verified: false,
            reason: `TX hash matched a deposit, but amount differs: received ${depositAmount} USDT vs expected ${expectedAmount} USDT`,
            amount: depositAmount,
          };
        }
      }

      // 2. Fallback: exact amount match (no tx_hash provided, or hash not yet visible)
      for (const deposit of deposits) {
        const depositAmount = new Decimal(deposit.amount.toString());
        if (depositAmount.equals(expectedAmount)) {
          this.logger.log(
            `✓ EXACT AMOUNT MATCH: ${depositAmount} USDT for payment ${payment.submission_id}`,
          );
          return {
            verified: true,
            reason: `Exact amount verified: ${depositAmount} USDT`,
            amount: depositAmount,
          };
        }
      }

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

      await tx.vc_pool_seat_reservations.update({
        where: { reservation_id: payment.reservation_id },
        data: { status: 'confirmed' as any },
      });

      const totalPoolValue = new Decimal(payment.pool.max_members)
        .times(payment.pool.contribution_amount);
      const sharePercent = new Decimal(payment.investment_amount)
        .dividedBy(totalPoolValue)
        .times(100);

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

      const updatedPool = await tx.vc_pools.update({
        where: { pool_id: payment.pool_id },
        data: {
          verified_members_count: { increment: 1 },
          reserved_seats_count: { decrement: 1 },
        },
      });

      if (updatedPool.verified_members_count >= updatedPool.max_members) {
        await tx.vc_pools.update({
          where: { pool_id: payment.pool_id },
          data: { status: 'full' as any },
        });
        this.logger.log(`Pool ${payment.pool_id} is now full`);
      }

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
          description: `Payment verified via on-chain deposit. Exact match: ${actualAmount} USDT`,
        },
      });
    });

    this.logger.log(
      `✓ Payment APPROVED: ${payment.submission_id} | User: ${payment.user_id} | Amount: ${actualAmount}`,
    );
  }
}
