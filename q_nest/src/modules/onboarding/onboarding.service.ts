import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { KycService } from '../../kyc/services/kyc.service';
import { ExchangesService } from '../exchanges/exchanges.service';
import { OnboardingStateService } from '../onboarding-emails/services/onboarding-state.service';
import { OnboardingState } from '../onboarding-emails/types';

const ACKNOWLEDGED_STATES: OnboardingState[] = [
  OnboardingState.PAID,
  OnboardingState.CONNECT_EXCHANGE,
  OnboardingState.COMPLETED,
];

export interface OnboardingProgressResponse {
  personal_info: { complete: boolean };
  kyc: {
    status: 'pending' | 'approved' | 'rejected' | 'review';
    review_reject_type: 'RETRY' | 'FINAL' | null;
    has_submission: boolean;
    rejection_reasons?: string[];
  };
  subscription: {
    tier: 'FREE' | 'PRO' | 'ELITE' | 'ELITE_PLUS';
    is_paid: boolean;
    acknowledged: boolean;
  };
  exchange: {
    connected: boolean;
    type: 'crypto' | 'stocks' | null;
  };
}

export interface FreeSignalTradesQuotaResponse {
  has_grant: boolean;
  granted: number;
  used: number;
  remaining: number;
}

export const FREE_SIGNAL_TRADES_GRANT = 5;

@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kycService: KycService,
    private readonly exchangesService: ExchangesService,
    private readonly onboardingStateService: OnboardingStateService,
  ) {}

  async getProgress(userId: string): Promise<OnboardingProgressResponse> {
    const [user, kyc, exchange] = await Promise.all([
      this.prisma.users.findUnique({
        where: { user_id: userId },
        select: {
          full_name: true,
          dob: true,
          nationality: true,
          current_tier: true,
          onboarding_state: true,
        },
      }),
      this.kycService.getStatus(userId).catch((err) => {
        this.logger.warn(`getProgress: kycService.getStatus failed for ${userId}: ${err?.message}`);
        return null;
      }),
      this.exchangesService.getActiveConnectionOrNull(userId).catch((err) => {
        this.logger.warn(`getProgress: getActiveConnectionOrNull failed for ${userId}: ${err?.message}`);
        return null;
      }),
    ]);

    if (!user) {
      throw new Error('User not found');
    }

    const personalInfoComplete = Boolean(user.full_name && user.dob && user.nationality);

    const kycStatus = (kyc?.status as 'pending' | 'approved' | 'rejected' | 'review' | undefined) ?? 'pending';
    const kycHasSubmission = (kyc as any)?.has_submission ?? false;
    const kycRejectType = ((kyc as any)?.review_reject_type ?? null) as 'RETRY' | 'FINAL' | null;
    const kycRejectionReasons = (kyc as any)?.rejection_reasons as string[] | undefined;

    const tier = (user.current_tier ?? 'FREE') as 'FREE' | 'PRO' | 'ELITE' | 'ELITE_PLUS';
    const isPaid = tier !== 'FREE';
    const acknowledged = ACKNOWLEDGED_STATES.includes(user.onboarding_state as OnboardingState);

    const exchangeConnected = Boolean(exchange);
    const exchangeType = exchange ? (exchange.exchange.type as 'crypto' | 'stocks') : null;

    return {
      personal_info: { complete: personalInfoComplete },
      kyc: {
        status: kycStatus,
        review_reject_type: kycRejectType,
        has_submission: kycHasSubmission,
        ...(kycRejectionReasons && kycRejectionReasons.length > 0
          ? { rejection_reasons: kycRejectionReasons }
          : {}),
      },
      subscription: {
        tier,
        is_paid: isPaid,
        acknowledged: acknowledged || isPaid,
      },
      exchange: {
        connected: exchangeConnected,
        type: exchangeType,
      },
    };
  }

  /**
   * Marks the subscription onboarding step as acknowledged when the user
   * explicitly chooses to stay on the FREE tier from the dashboard widget.
   * Idempotent — uses OnboardingStateService.advanceTo, which is one-way.
   * Also grants the one-time FREE-tier signal-trade quota (5 trades) so the
   * user can experience Top Trades execution without upgrading.
   */
  async acknowledgeFreeTier(userId: string): Promise<{ acknowledged: true; free_signal_trades_granted: number }> {
    await this.prisma.free_tier_signal_trades.upsert({
      where: { user_id: userId },
      create: { user_id: userId, trades_granted: FREE_SIGNAL_TRADES_GRANT, trades_used: 0 },
      update: {}, // idempotent: never re-grant or top up
    });
    await this.onboardingStateService.advanceTo(userId, OnboardingState.PAID);
    return { acknowledged: true, free_signal_trades_granted: FREE_SIGNAL_TRADES_GRANT };
  }

  async getFreeSignalTradesQuota(userId: string): Promise<FreeSignalTradesQuotaResponse> {
    const row = await this.prisma.free_tier_signal_trades.findUnique({
      where: { user_id: userId },
    });
    if (!row) {
      return { has_grant: false, granted: 0, used: 0, remaining: 0 };
    }
    return {
      has_grant: true,
      granted: row.trades_granted,
      used: row.trades_used,
      remaining: Math.max(0, row.trades_granted - row.trades_used),
    };
  }
}
