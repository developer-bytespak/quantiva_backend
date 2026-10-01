import { ForbiddenException } from '@nestjs/common';

export const SIGNAL_EXECUTION_REQUIRES_PREMIUM = 'SIGNAL_EXECUTION_REQUIRES_PREMIUM';

/**
 * Thrown when a FREE-tier user tries to execute a Top Trades signal. The old
 * "5 free signal trades" allowance was retired in favour of the 7-day Premium
 * trial, so signal execution now requires a Premium (trial or paid) plan.
 */
export class SignalExecutionRequiresPremiumException extends ForbiddenException {
  constructor() {
    super({
      code: SIGNAL_EXECUTION_REQUIRES_PREMIUM,
      message:
        'Signal execution requires the Premium plan. Start your 7-day free trial from Settings to execute Top Trades.',
    });
  }
}

/** @deprecated kept as an alias for one release; use SignalExecutionRequiresPremiumException. */
export const FREE_SIGNAL_TRADE_QUOTA_EXHAUSTED = SIGNAL_EXECUTION_REQUIRES_PREMIUM;
