import { ForbiddenException } from '@nestjs/common';

export const FREE_SIGNAL_TRADE_QUOTA_EXHAUSTED = 'FREE_SIGNAL_TRADE_QUOTA_EXHAUSTED';

export class FreeSignalTradeQuotaExhaustedException extends ForbiddenException {
  constructor(granted: number) {
    super({
      code: FREE_SIGNAL_TRADE_QUOTA_EXHAUSTED,
      message: `You've used all ${granted} of your free signal trades. Upgrade to PRO for unlimited Top Trades executions.`,
      remaining: 0,
      granted,
    });
  }
}
