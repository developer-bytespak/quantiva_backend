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

  /**
   * Guards against deleting a user with outstanding VC pool commitments.
   * Throws BadRequestException if they have any active membership, held seat,
   * or pending payment on an open/full/active pool.
   */
  private async assertNoActivePoolTies(userId: string): Promise<void> {
    const activePoolStatuses: ('open' | 'full' | 'active')[] = [
      'open',
      'full',
      'active',
    ];
    // Must match SeatReservationStatus enum in schema.prisma
    const activeReservationStatuses: ('reserved' | 'confirmed')[] = [
      'reserved',
      'confirmed',
    ];

    const [memberships, seatReservations, paymentSubmissions] =
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
            status: { in: activeReservationStatuses },
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

    if (memberships > 0 || seatReservations > 0 || paymentSubmissions > 0) {
      throw new BadRequestException(
        'Cannot delete account: you are linked to one or more active VC pools. ' +
          'Please exit all active VC pools before deleting your account.',
      );
    }
  }

  /**
   * Full cascade delete for a user. Shared by admin `delete(id)` and
   * self-service `deleteSelf(id, reason)`.
   *
   * Uses Prisma relation filter subqueries (e.g. `{ signal: whereUser }`)
   * rather than pre-fetched ID lists so thousands of linked rows work without
   * hitting Postgres's 32767 bind-variable limit. Based on the proven pattern
   * in scripts/delete-users.js.
   *
   * Schema has onDelete: Cascade on ~15 tables (notifications, payment_history,
   * user_credits, qhq_*, trade_fees, subscription_usage, signal_details,
   * signal_explanations, onboarding_email_reminders, monthly_fee_summaries) —
   * Prisma handles those automatically on the final `users.delete`. Everything
   * else is removed explicitly here.
   */
  private async cascadeDeleteUser(userId: string): Promise<void> {
    const whereUser = { user_id: userId };
    const whereViaPortfolio = { portfolio: whereUser };
    const whereViaStrategy = { strategy: whereUser };
    const whereViaSignal = { signal: whereUser };
    const whereViaOptimization = { optimization_runs: whereUser };
    const whereViaKyc = { kyc_verifications: whereUser };
    const whereViaMember = { member: whereUser };
    const whereViaReservation = { reservation: whereUser };
    const whereViaSubscription = { subscription: whereUser };
    const whereViaOrder = { order: { portfolio: whereUser } };
    const whereViaOptionsOrder = { originating_order: whereUser };

    await this.prisma.$transaction(
      async (tx) => {
        // ── Signal children (auto_trade_evaluations has no user_id — only via signal) ──
        await tx.auto_trade_evaluations.deleteMany({ where: whereViaSignal });
        await tx.signal_details.deleteMany({ where: whereViaSignal });
        await tx.signal_explanations.deleteMany({ where: whereViaSignal });
        await tx.options_signals.deleteMany({ where: whereViaSignal });

        // Null orders referencing this user's signals before dropping the signals
        await tx.orders.updateMany({
          where: { signal: whereUser },
          data: { signal_id: null },
        });

        // ── Order / portfolio tree ──
        await tx.order_executions.deleteMany({ where: whereViaOrder });
        await tx.orders.deleteMany({ where: whereViaPortfolio });
        await tx.portfolio_positions.deleteMany({ where: whereViaPortfolio });
        await tx.portfolio_snapshots.deleteMany({ where: whereViaPortfolio });
        await tx.drawdown_history.deleteMany({ where: whereViaPortfolio });

        // ── Optimization children ──
        await tx.optimization_allocations.deleteMany({ where: whereViaOptimization });
        await tx.rebalance_suggestions.deleteMany({ where: whereViaOptimization });

        // ── Options ──
        await tx.options_positions.deleteMany({ where: whereViaOptionsOrder });
        await tx.options_positions.deleteMany({ where: whereUser });
        await tx.options_orders.deleteMany({ where: whereUser });

        // ── Strategy tree ──
        await tx.strategy_signals.deleteMany({ where: whereUser });
        await tx.strategy_parameters.deleteMany({ where: whereViaStrategy });
        await tx.strategy_execution_jobs.deleteMany({ where: whereViaStrategy });
        await tx.strategies.updateMany({
          where: { template: whereUser },
          data: { template_id: null },
        });
        await tx.strategies.deleteMany({ where: whereUser });
        await tx.portfolios.deleteMany({ where: whereUser });
        await tx.optimization_runs.deleteMany({ where: whereUser });

        // ── KYC ──
        await tx.kyc_documents.deleteMany({ where: whereViaKyc });
        await tx.kyc_face_matches.deleteMany({ where: whereViaKyc });
        await tx.kyc_verifications.deleteMany({ where: whereUser });

        // ── Exchange connections ──
        await tx.user_exchange_connections.deleteMany({ where: whereUser });

        // ── VC pool tree ──
        await tx.vc_pool_cancellations.deleteMany({ where: whereViaMember });
        await tx.vc_pool_payouts.deleteMany({ where: whereViaMember });
        await tx.vc_pool_transactions.updateMany({
          where: { member: whereUser },
          data: { member_id: null },
        });
        await tx.vc_pool_transactions.deleteMany({ where: whereUser });
        await tx.vc_pool_payment_submissions.deleteMany({ where: whereViaReservation });
        await tx.vc_pool_payment_submissions.deleteMany({ where: whereUser });
        await tx.vc_pool_seat_reservations.deleteMany({ where: whereUser });
        await tx.vc_pool_members.deleteMany({ where: whereUser });

        // ── Subscriptions (has cascade, but be explicit to survive flag drift) ──
        await tx.subscription_usage.deleteMany({ where: whereViaSubscription });
        await tx.payment_history.deleteMany({ where: whereViaSubscription });
        await tx.subscription_usage.deleteMany({ where: whereUser });
        await tx.payment_history.deleteMany({ where: whereUser });
        await tx.user_subscriptions.deleteMany({ where: whereUser });

        // ── Misc ──
        await tx.risk_events.deleteMany({ where: whereUser });
        await tx.notifications.deleteMany({ where: whereUser });
        await tx.onboarding_email_reminders.deleteMany({ where: whereUser });
        await tx.contact_submissions.updateMany({
          where: whereUser,
          data: { user_id: null },
        });
        await tx.pending_queued_trades.deleteMany({ where: whereUser });

        // ── Credits / fees / QHQ ──
        await tx.user_credits.deleteMany({ where: whereUser });
        await tx.trade_fees.deleteMany({ where: whereUser });
        await tx.monthly_fee_summaries.deleteMany({ where: whereUser });
        await tx.qhq_balances.deleteMany({ where: whereUser });
        await tx.qhq_transactions.deleteMany({ where: whereUser });
        await tx.qhq_wallet_links.deleteMany({ where: whereUser });

        // ── Auth state ──
        await tx.user_sessions.deleteMany({ where: whereUser });
        await tx.two_factor_codes.deleteMany({ where: whereUser });
        await tx.user_settings.deleteMany({ where: whereUser });

        // ── Finally, the user ──
        await tx.users.delete({ where: whereUser });
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
  }

  /**
   * Admin delete — uses the shared cascade. Originally relied on raw
   * users.delete() which fails because most user-owned tables don't have
   * onDelete: Cascade set.
   */
  async delete(id: string) {
    await this.assertNoActivePoolTies(id);
    await this.cascadeDeleteUser(id);
    this.logger.log(`User ${id} deleted by admin`);
    return { success: true };
  }

  /**
   * Self-deletion: user deletes their own account.
   *
   *  - "voluntary": legitimate user leaving — also deletes the Sumsub applicant
   *    so they can re-register and re-verify with the same ID in the future.
   *  - "final_rejection": user was permanently blocked by Sumsub (fraud/forgery/
   *    sanctions/duplicate) — we delete local data but preserve the Sumsub
   *    applicant so the same face + ID can never pass KYC again.
   */
  async deleteSelf(userId: string, reason: DeleteReason) {
    await this.assertNoActivePoolTies(userId);

    // Capture Sumsub applicant ID BEFORE cascade deletes kyc_verifications
    const kycRecord = await this.prisma.kyc_verifications.findFirst({
      where: { user_id: userId },
      select: { sumsub_applicant_id: true },
    });
    const sumsubApplicantId = kycRecord?.sumsub_applicant_id || null;

    await this.cascadeDeleteUser(userId);

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

