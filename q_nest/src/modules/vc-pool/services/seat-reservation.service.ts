import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { JoinPoolDto } from '../dto/join-pool.dto';
import { VcPoolEmailService } from './vc-pool-email.service';

const POOL_STATUS = { open: 'open', full: 'full' } as const;
const RESERVATION_STATUS = { reserved: 'reserved', confirmed: 'confirmed' } as const;
const SUBMISSION_STATUS = { pending: 'pending', processing: 'processing' } as const;

@Injectable()
export class SeatReservationService {
  private readonly logger = new Logger(SeatReservationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly vcPoolEmailService: VcPoolEmailService,
  ) {}

  async joinPool(userId: string, poolId: string, dto: JoinPoolDto) {
    const pool = await this.prisma.vc_pools.findUnique({
      where: { pool_id: poolId },
      include: { admin: { select: { binance_uid: true, wallet_address: true, payment_network: true, email: true } } },
    });

    if (!pool) throw new NotFoundException('Pool not found');
    if (pool.status !== POOL_STATUS.open) {
      throw new BadRequestException('Pool is not open for joining');
    }

    // Check KYC
    const user = await this.prisma.users.findUnique({
      where: { user_id: userId },
      select: { kyc_status: true, current_tier: true, email: true, username: true, full_name: true },
    });
    if (!user) throw new NotFoundException('User not found');
    if (user.kyc_status !== 'approved') {
      throw new ForbiddenException(
        `KYC verification required. Current status: ${user.kyc_status}`,
      );
    }

    // Check for existing active membership
    const existingMember = await this.prisma.vc_pool_members.findUnique({
      where: { pool_id_user_id: { pool_id: poolId, user_id: userId } },
    });
    if (existingMember && existingMember.is_active) {
      throw new ConflictException('You are already a member of this pool');
    }

    // If user has cancelled before (is_active: false), reactivate them (REJOIN)
    let memberToUse = existingMember;
    let isRejoin = false;
    
    if (existingMember && !existingMember.is_active) {
      // User is rejoining after cancellation
      isRejoin = true;
      this.logger.log(`User ${userId} is rejoining pool ${poolId} after previous cancellation`);
      
      memberToUse = await this.prisma.vc_pool_members.update({
        where: { member_id: existingMember.member_id },
        data: {
          is_active: false,  // ✅ REJOIN: Keep inactive until new TX is verified (same flow as initial join)
          exited_at: null,  // Clear exit timestamp
          joined_at: new Date(),  // Update join date
        },
      });
    } else if (!existingMember) {
      // NEW JOIN - Create member record immediately
      memberToUse = await this.prisma.vc_pool_members.create({
        data: {
          pool_id: poolId,
          user_id: userId,
          payment_method: dto.payment_method as any,
          invested_amount_usdt: Number(pool.contribution_amount),
          share_percent: 0,  // Will be calculated after payment approval
          is_active: false,  // Will be set to true after payment is verified
          user_wallet_address: dto.user_wallet_address || null,
          user_binance_uid: dto.user_binance_uid || null,
        },
      });
      isRejoin = false;
    }

    // Check for existing active reservation
    const existingReservation = await this.prisma.vc_pool_seat_reservations.findUnique({
      where: { pool_id_user_id: { pool_id: poolId, user_id: userId } },
    });

    // ✅ If active reservation exists and not expired → UPDATE wallet address instead of throwing error
    if (
      existingReservation &&
      existingReservation.status === RESERVATION_STATUS.reserved &&
      existingReservation.expires_at > new Date()
    ) {
      this.logger.log(
        `User ${userId} updating wallet address for existing reservation in pool ${poolId}`,
      );

      // Update member record with new wallet address
      const updatedMember = await this.prisma.vc_pool_members.update({
        where: { member_id: memberToUse.member_id },
        data: {
          user_wallet_address: dto.user_wallet_address || memberToUse.user_wallet_address,
          user_binance_uid: dto.user_binance_uid || memberToUse.user_binance_uid,
        },
      });

      // Update payment submission with new wallet address
      let submission = await this.prisma.vc_pool_payment_submissions.findFirst({
        where: { reservation_id: existingReservation.reservation_id },
      });

      if (!submission) {
        // If submission doesn't exist yet, create it
        const submissionStatus =
          dto.payment_method === 'stripe'
            ? SUBMISSION_STATUS.processing
            : SUBMISSION_STATUS.pending;

        const investmentAmount = Number(pool.contribution_amount);
        const poolFeeAmount = investmentAmount * Number(pool.pool_fee_percent) / 100;
        const totalAmount = investmentAmount + poolFeeAmount;

        submission = await this.prisma.vc_pool_payment_submissions.create({
          data: {
            pool_id: poolId,
            user_id: userId,
            reservation_id: existingReservation.reservation_id,
            payment_method: dto.payment_method as any,
            investment_amount: investmentAmount,
            pool_fee_amount: poolFeeAmount,
            total_amount: totalAmount,
            payment_deadline: existingReservation.expires_at,
            status: submissionStatus as any,
            user_wallet_address: dto.user_wallet_address || null,
          },
        });
      } else {
        // Update existing submission with new wallet address
        submission = await this.prisma.vc_pool_payment_submissions.update({
          where: { submission_id: submission.submission_id },
          data: {
            user_wallet_address: dto.user_wallet_address || submission.user_wallet_address,
          },
        });
      }

      // Calculate remaining time on existing deadline
      const minutesRemaining = Math.max(
        0,
        Math.floor((existingReservation.expires_at.getTime() - Date.now()) / 60000),
      );

      this.logger.log(
        `Wallet address updated for user ${userId} in pool ${poolId} (${minutesRemaining} minutes remaining)`,
      );

      // Return updated reservation response
      if (dto.payment_method === 'binance') {
        const adminAddress = pool.admin?.wallet_address || pool.admin?.binance_uid;
        const network = pool.admin?.payment_network || 'BSC';
        const investmentAmount = Number(pool.contribution_amount);
        const poolFeeAmount = investmentAmount * Number(pool.pool_fee_percent) / 100;
        const totalAmount = investmentAmount + poolFeeAmount;

        return {
          member_id: updatedMember.member_id,
          reservation_id: existingReservation.reservation_id,
          submission_id: submission.submission_id,
          is_rejoin: isRejoin,
          wallet_updated: true,
          total_amount: totalAmount,
          investment_amount: investmentAmount,
          pool_fee_amount: poolFeeAmount,
          coin: pool.coin_type,
          admin_binance_uid: pool.admin?.binance_uid,
          admin_wallet_address: pool.admin?.wallet_address || null,
          payment_network: network,
          deposit_coin: 'USDT',
          deposit_method: 'on_chain',
          deadline: existingReservation.expires_at,
          minutes_remaining: minutesRemaining,
          payment_method: 'binance',
          instructions: [
            '1. Open Binance → Click Send → Withdraw Crypto',
            '2. Select USDT as the coin',
            `3. Paste the admin deposit address: ${adminAddress}`,
            `4. Select Network: ${network} (BEP-20)`,
            `5. Enter the exact amount: ${totalAmount} USDT`,
            '6. Click Withdraw and confirm the transaction',
            '7. Copy the TX Hash from the confirmation',
            '8. Come back and paste the TX Hash to verify your payment',
          ],
        };
      }

      // Stripe
      const investmentAmount = Number(pool.contribution_amount);
      const poolFeeAmount = investmentAmount * Number(pool.pool_fee_percent) / 100;
      const totalAmount = investmentAmount + poolFeeAmount;

      return {
        member_id: updatedMember.member_id,
        reservation_id: existingReservation.reservation_id,
        submission_id: submission.submission_id,
        is_rejoin: isRejoin,
        wallet_updated: true,
        total_amount: totalAmount,
        investment_amount: investmentAmount,
        pool_fee_amount: poolFeeAmount,
        coin: pool.coin_type,
        deadline: existingReservation.expires_at,
        minutes_remaining: minutesRemaining,
        payment_method: 'stripe',
        message: 'Wallet address updated. Ready for payment.',
      };
    }

    // Check seat availability
    const available = pool.max_members - pool.reserved_seats_count - pool.verified_members_count;
    if (available <= 0) {
      throw new ConflictException('No seats available');
    }

    // Binance UID required for binance method
    if (dto.payment_method === 'binance' && !pool.admin?.wallet_address && !pool.admin?.binance_uid) {
      throw new BadRequestException('Admin has not configured wallet address');
    }

    // Calculate payment
    const investmentAmount = Number(pool.contribution_amount);
    const poolFeeAmount = investmentAmount * Number(pool.pool_fee_percent) / 100;
    const totalAmount = investmentAmount + poolFeeAmount;

    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + pool.payment_window_minutes);

    // Atomic transaction: reserve seat + create payment submission
    const result = await this.prisma.$transaction(async (tx) => {
      // Delete stale reservation + linked submission if exists (expired/released)
      if (existingReservation) {
        await tx.vc_pool_payment_submissions.deleteMany({
          where: { reservation_id: existingReservation.reservation_id },
        });
        await tx.vc_pool_seat_reservations.delete({
          where: { reservation_id: existingReservation.reservation_id },
        });
      }

      const reservation = await tx.vc_pool_seat_reservations.create({
        data: {
          pool_id: poolId,
          user_id: userId,
          payment_method: dto.payment_method as any,
          expires_at: expiresAt,
          status: RESERVATION_STATUS.reserved as any,
        },
      });

      await tx.vc_pools.update({
        where: { pool_id: poolId },
        data: { reserved_seats_count: { increment: 1 } },
      });

      const submissionStatus =
        dto.payment_method === 'stripe'
          ? SUBMISSION_STATUS.processing
          : SUBMISSION_STATUS.pending;

      const submission = await tx.vc_pool_payment_submissions.create({
        data: {
          pool_id: poolId,
          user_id: userId,
          reservation_id: reservation.reservation_id,
          payment_method: dto.payment_method as any,
          investment_amount: investmentAmount,
          pool_fee_amount: poolFeeAmount,
          total_amount: totalAmount,
          payment_deadline: expiresAt,
          status: submissionStatus as any,
          user_wallet_address: dto.user_wallet_address || null,
        },
      });

      return { reservation, submission };
    });

    this.logger.log(
      `User ${userId} reserved seat in pool ${poolId} (${dto.payment_method})`,
    );

    // Send join request email to admin
    this.vcPoolEmailService.sendJoinRequestToAdmin({
      adminEmail: pool.admin?.email || '',
      poolName: pool.name,
      userName: user.full_name || user.username || 'Unknown',
      userEmail: user.email,
      contributionAmount: totalAmount,
      coinType: pool.coin_type,
      paymentMethod: dto.payment_method,
    });

    const minutesRemaining = Math.max(
      0,
      Math.floor((expiresAt.getTime() - Date.now()) / 60000),
    );

    if (dto.payment_method === 'binance') {
      const adminAddress = pool.admin?.wallet_address || pool.admin?.binance_uid;
      const network = pool.admin?.payment_network || 'BSC';
      return {
        member_id: memberToUse.member_id,
        reservation_id: result.reservation.reservation_id,
        submission_id: result.submission.submission_id,
        is_rejoin: isRejoin,
        total_amount: totalAmount,
        investment_amount: investmentAmount,
        pool_fee_amount: poolFeeAmount,
        coin: pool.coin_type,
        admin_binance_uid: pool.admin?.binance_uid,
        admin_wallet_address: pool.admin?.wallet_address || null,
        payment_network: network,
        deposit_coin: 'USDT',
        deposit_method: 'on_chain',
        deadline: expiresAt,
        minutes_remaining: minutesRemaining,
        payment_method: 'binance',
        instructions: [
          '1. Open Binance → Click Send → Withdraw Crypto',
          '2. Select USDT as the coin',
          `3. Paste the admin deposit address: ${adminAddress}`,
          `4. Select Network: ${network} (BEP-20)`,
          `5. Enter the exact amount: ${totalAmount} USDT`,
          '6. Click Withdraw and confirm the transaction',
          '7. Copy the TX Hash from the confirmation',
          '8. Come back and paste the TX Hash to verify your payment',
        ],
      };
    }

    // Stripe (bypassed in Phase 1)
    return {
      member_id: memberToUse.member_id,
      reservation_id: result.reservation.reservation_id,
      submission_id: result.submission.submission_id,
      is_rejoin: isRejoin,
      total_amount: totalAmount,
      investment_amount: investmentAmount,
      pool_fee_amount: poolFeeAmount,
      coin: pool.coin_type,
      deadline: expiresAt,
      minutes_remaining: minutesRemaining,
      payment_method: 'stripe',
      message: 'Join request submitted. Awaiting admin approval.',
    };
  }

  async getPaymentStatus(userId: string, poolId: string) {
    const pool = await this.prisma.vc_pools.findUnique({
      where: { pool_id: poolId },
    });
    if (!pool) throw new NotFoundException('Pool not found');

    const membership = await this.prisma.vc_pool_members.findUnique({
      where: { pool_id_user_id: { pool_id: poolId, user_id: userId } },
      select: { member_id: true, is_active: true, joined_at: true, payment_method: true },
    });

    const reservation = await this.prisma.vc_pool_seat_reservations.findUnique({
      where: { pool_id_user_id: { pool_id: poolId, user_id: userId } },
      select: {
        reservation_id: true,
        status: true,
        expires_at: true,
        payment_method: true,
      },
    });

    let submission = null;
    if (reservation) {
      submission = await this.prisma.vc_pool_payment_submissions.findFirst({
        where: { reservation_id: reservation.reservation_id },
        select: {
          submission_id: true,
          payment_method: true,
          status: true,
          total_amount: true,
          investment_amount: true,
          pool_fee_amount: true,
          screenshot_url: true,
          rejection_reason: true,
          payment_deadline: true,
          verified_at: true,
          binance_tx_id: true,
          tx_hash: true,
          binance_payment_status: true,
          exact_amount_expected: true,
          user_wallet_address: true,
        },
      });
    }

    // Check for cancellation if member exists
    let cancellationInfo = null;
    if (membership) {
      const cancellation = await this.prisma.vc_pool_cancellations.findUnique({
        where: { member_id: membership.member_id },
        select: {
          cancellation_id: true,
          status: true,
          requested_at: true,
          invested_amount: true,
          fee_amount: true,
          refund_amount: true,
          reviewed_at: true,
          refunded_at: true,
        },
      });

      if (cancellation) {
        // Detect rejoin: member is inactive (waiting for new payment), has a new reservation,
        // but old cancellation is already 'processed' — this is a REJOIN in progress
        const isRejoinInProgress =
          !membership.is_active &&
          reservation &&
          reservation.status === 'reserved' &&
          cancellation.status === 'processed';

        cancellationInfo = {
          has_cancellation: true,
          is_historical: isRejoinInProgress, // frontend: if true, ignore cancellation steps — show join/payment flow instead
          cancellation_id: cancellation.cancellation_id,
          status: cancellation.status,
          requested_at: cancellation.requested_at,
          approved_at: cancellation.reviewed_at,
          refunded_at: cancellation.refunded_at,
          contribution_amount: Number(cancellation.invested_amount),
          cancellation_fee_amount: Number(cancellation.fee_amount),
          refund_amount: Number(cancellation.refund_amount),
        };
      }
    }

    // Detect if user has completed rejoin (active member with a processed old cancellation)
    // In this case, user should be able to request exit again
    const canRequestExit =
      membership?.is_active === true &&
      (cancellationInfo === null ||
        cancellationInfo.status === 'processed' ||
        cancellationInfo.status === 'rejected');

    const minutesRemaining = reservation?.expires_at
      ? Math.max(0, Math.floor((reservation.expires_at.getTime() - Date.now()) / 60000))
      : null;

    return {
      pool_id: poolId,
      membership: membership
        ? { exists: true, is_active: membership.is_active, joined_at: membership.joined_at, payment_method: membership.payment_method }
        : { exists: false, is_active: false, joined_at: null, payment_method: null },
      reservation: reservation
        ? { ...reservation, minutes_remaining: minutesRemaining }
        : { reservation_id: null, status: null, expires_at: null, payment_method: null, minutes_remaining: null },
      payment: submission ?? {
        submission_id: null,
        payment_method: null,
        status: null,
        total_amount: null,
        investment_amount: null,
        pool_fee_amount: null,
        screenshot_url: null,
        rejection_reason: null,
        payment_deadline: null,
        verified_at: null,
        binance_tx_id: null,
        tx_hash: null,
        binance_payment_status: null,
        exact_amount_expected: null,
        user_wallet_address: null,
      },
      cancellation: cancellationInfo ?? {
        has_cancellation: false,
        is_historical: false,
        cancellation_id: null,
        status: null,
        requested_at: null,
        approved_at: null,
        refunded_at: null,
        contribution_amount: null,
        cancellation_fee_amount: null,
        refund_amount: null,
      },
      can_request_exit: canRequestExit,
    };
  }
}
