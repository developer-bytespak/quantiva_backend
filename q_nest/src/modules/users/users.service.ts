import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { KycStatus } from '@prisma/client';
import { UpdatePersonalInfoDto } from './dto/update-personal-info.dto';
import { SumsubService } from '../../kyc/integrations/sumsub.service';
import { DeleteReason } from './dto/delete-self.dto';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private prisma: PrismaService,
    private sumsubService: SumsubService,
  ) {}

  async findAll() {
    return this.prisma.users.findMany();
  }

  async findOne(id: string) {
    return this.prisma.users.findUnique({
      where: { user_id: id },
    });
  }

  async findByEmail(email: string) {
    return this.prisma.users.findUnique({
      where: { email },
    });
  }

  async create(data: {
    email: string;
    username: string;
    password_hash?: string;
    email_verified?: boolean;
    kyc_status?: KycStatus;
  }) {
    return this.prisma.users.create({
      data,
    });
  }

  async update(id: string, data: {
    email?: string;
    username?: string;
    password_hash?: string;
    email_verified?: boolean;
    kyc_status?: KycStatus;
  }) {
    return this.prisma.users.update({
      where: { user_id: id },
      data,
    });
  }

  async delete(id: string) {
    // Prevent deleting a user who is involved in any active VC pool
    // (completed and cancelled pools should not block account deletion)
    const activePoolStatuses = ['open', 'full', 'active'];

    const [membershipsCount, seatReservationsCount, paymentSubmissionsCount] =
      await Promise.all([
        this.prisma.vc_pool_members.count({
          where: {
            user_id: id,
            is_active: true,
            pool: { status: { in: activePoolStatuses } },
          },
        }),
        this.prisma.vc_pool_seat_reservations.count({
          where: {
            user_id: id,
            status: { in: ['reserved', 'pending_payment'] },
            pool: { status: { in: activePoolStatuses } },
          },
        }),
        this.prisma.vc_pool_payment_submissions.count({
          where: {
            user_id: id,
            status: 'pending',
            pool: { status: { in: activePoolStatuses } },
          },
        }),
      ]);

    if (
      membershipsCount > 0 ||
      seatReservationsCount > 0 ||
      paymentSubmissionsCount > 0
    ) {
      throw new BadRequestException(
        'Cannot delete user: this account is linked to one or more active VC pools. ' +
          'Please remove the user from all active VC pools before deleting the account.',
      );
    }

    return this.prisma.users.delete({
      where: { user_id: id },
    });
  }

  /**
   * Self-deletion: user deletes their own account.
   *
   * Two reason modes:
   *  - "voluntary": legitimate user leaving — also deletes the Sumsub applicant
   *    so they can re-register and re-verify with the same ID in the future.
   *  - "final_rejection": user was permanently blocked by Sumsub (fraud/forgery/
   *    sanctions/duplicate) — we delete local data but preserve the Sumsub
   *    applicant so the same face + ID can never pass KYC again via a new account.
   *
   * Performs an ordered cascade delete in a single transaction. Prisma does not
   * have onDelete: Cascade set on most user-owned tables in this schema, so we
   * must remove dependents explicitly. Tables that already cascade (notifications,
   * payment_history, user_credits, qhq_*, trade_fees, monthly_fee_summaries,
   * subscription_usage, signal_details, signal_explanations, onboarding_email_
   * reminders) are handled by Prisma when we finally delete the users row.
   */
  async deleteSelf(userId: string, reason: DeleteReason) {
    const activePoolStatuses = ['open', 'full', 'active'];

    const [membershipsCount, seatReservationsCount, paymentSubmissionsCount] =
      await Promise.all([
        this.prisma.vc_pool_members.count({
          where: {
            user_id: userId,
            is_active: true,
            pool: { status: { in: activePoolStatuses } },
          },
        }),
        this.prisma.vc_pool_seat_reservations.count({
          where: {
            user_id: userId,
            status: { in: ['reserved', 'pending_payment'] },
            pool: { status: { in: activePoolStatuses } },
          },
        }),
        this.prisma.vc_pool_payment_submissions.count({
          where: {
            user_id: userId,
            status: 'pending',
            pool: { status: { in: activePoolStatuses } },
          },
        }),
      ]);

    if (
      membershipsCount > 0 ||
      seatReservationsCount > 0 ||
      paymentSubmissionsCount > 0
    ) {
      throw new BadRequestException(
        'Cannot delete account: you are linked to one or more active VC pools. ' +
          'Please exit all active VC pools before deleting your account.',
      );
    }

    // Capture Sumsub applicant ID BEFORE we delete kyc_verifications
    const kycRecord = await this.prisma.kyc_verifications.findFirst({
      where: { user_id: userId },
      select: { sumsub_applicant_id: true },
    });
    const sumsubApplicantId = kycRecord?.sumsub_applicant_id || null;

    // Ordered cascade delete — child tables first, then parent, then users row.
    await this.prisma.$transaction(async (tx) => {
      // Fetch nested parent IDs we need for transitive deletes
      const portfolios = await tx.portfolios.findMany({
        where: { user_id: userId },
        select: { portfolio_id: true },
      });
      const portfolioIds = portfolios.map((p) => p.portfolio_id);

      const orders = await tx.orders.findMany({
        where: { user_id: userId },
        select: { order_id: true },
      });
      const orderIds = orders.map((o) => o.order_id);

      const kycVerifications = await tx.kyc_verifications.findMany({
        where: { user_id: userId },
        select: { kyc_id: true },
      });
      const kycIds = kycVerifications.map((k) => k.kyc_id);

      // 1. Trade / options data
      if (orderIds.length) {
        await tx.order_executions.deleteMany({ where: { order_id: { in: orderIds } } });
      }
      await tx.orders.deleteMany({ where: { user_id: userId } });
      await tx.options_orders.deleteMany({ where: { user_id: userId } });
      await tx.options_positions.deleteMany({ where: { user_id: userId } });
      await tx.pending_queued_trades.deleteMany({ where: { user_id: userId } });
      await tx.auto_trade_evaluations.deleteMany({ where: { user_id: userId } });

      // 2. Portfolios & positions
      if (portfolioIds.length) {
        await tx.portfolio_positions.deleteMany({
          where: { portfolio_id: { in: portfolioIds } },
        });
        await tx.portfolio_snapshots.deleteMany({
          where: { portfolio_id: { in: portfolioIds } },
        });
      }
      await tx.portfolios.deleteMany({ where: { user_id: userId } });

      // 3. Strategies & signals
      await tx.strategy_signals.deleteMany({ where: { user_id: userId } });
      await tx.strategies.deleteMany({ where: { user_id: userId } });
      await tx.optimization_runs.deleteMany({ where: { user_id: userId } });

      // 4. VC pool data (non-active — active already blocked above)
      await tx.vc_pool_members.deleteMany({ where: { user_id: userId } });
      await tx.vc_pool_seat_reservations.deleteMany({ where: { user_id: userId } });
      await tx.vc_pool_payment_submissions.deleteMany({ where: { user_id: userId } });
      await tx.vc_pool_transactions.deleteMany({ where: { user_id: userId } });

      // 5. Subscriptions & auth state
      await tx.user_subscriptions.deleteMany({ where: { user_id: userId } });
      await tx.user_exchange_connections.deleteMany({ where: { user_id: userId } });
      await tx.user_sessions.deleteMany({ where: { user_id: userId } });
      await tx.two_factor_codes.deleteMany({ where: { user_id: userId } });
      await tx.user_settings.deleteMany({ where: { user_id: userId } });

      // 6. KYC docs → verifications
      if (kycIds.length) {
        await tx.kyc_documents.deleteMany({ where: { kyc_id: { in: kycIds } } });
        await tx.kyc_face_matches.deleteMany({ where: { kyc_id: { in: kycIds } } });
      }
      await tx.kyc_verifications.deleteMany({ where: { user_id: userId } });

      // 7. Finally the user row (cascades the tables with onDelete: Cascade)
      await tx.users.delete({ where: { user_id: userId } });
    });

    this.logger.log(`User ${userId} deleted locally (reason: ${reason})`);

    // Sumsub cleanup — only for voluntary deletions.
    // FINAL-rejection users must remain in Sumsub so they stay blocked forever.
    if (reason === 'voluntary' && sumsubApplicantId) {
      await this.sumsubService.deleteApplicant(sumsubApplicantId);
      this.logger.log(`Sumsub applicant ${sumsubApplicantId} deleted (voluntary)`);
    } else if (reason === 'final_rejection' && sumsubApplicantId) {
      this.logger.log(
        `Sumsub applicant ${sumsubApplicantId} preserved (final_rejection — user stays blocked)`,
      );
    }

    return { success: true, message: 'Account deleted' };
  }

  async getCurrentUserProfile(userId: string) {
    return this.prisma.users.findUnique({
      where: { user_id: userId },
      select: {
        user_id: true,
        email: true,
        username: true,
        full_name: true,
        phone_number: true,
        dob: true,
        nationality: true,
        gender: true,
        kyc_status: true,
        profile_pic_url: true,
      } as any,
    });
  }

  async updatePersonalInfo(userId: string, data: UpdatePersonalInfoDto) {
    // Convert dob string to Date object
    const dobDate = data.dob ? new Date(data.dob) : null;

    return this.prisma.users.update({
      where: { user_id: userId },
      data: {
        full_name: data.fullName,
        dob: dobDate,
        nationality: data.nationality,
        gender: data.gender,
        phone_number: data.phoneNumber,
      },
      select: {
        user_id: true,
        email: true,
        username: true,
        full_name: true,
        dob: true,
        nationality: true,
        gender: true,
        phone_number: true,
        created_at: true,
        updated_at: true,
      },
    });
  }

  async updateProfilePicture(userId: string, imageUrl: string) {
    return this.prisma.users.update({
      where: { user_id: userId },
      data: {
        profile_pic_url: imageUrl,
      } as any,
      select: {
        user_id: true,
        email: true,
        username: true,
        full_name: true,
        profile_pic_url: true,
        created_at: true,
        updated_at: true,
      } as any,
    });
  }

  async removeProfilePicture(userId: string) {
    const user = await this.prisma.users.findUnique({
      where: { user_id: userId },
      select: { profile_pic_url: true } as any,
    });
    const oldUrl = (user as any)?.profile_pic_url ?? null;

    await this.prisma.users.update({
      where: { user_id: userId },
      data: { profile_pic_url: null } as any,
    });

    return oldUrl;
  }
}

