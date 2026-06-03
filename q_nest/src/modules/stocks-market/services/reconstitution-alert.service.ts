import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

/**
 * Surfaces alerts during known index-reconstitution windows.
 *
 * Why: Russell rebalances semi-annually (last week of June + mid-December
 * starting 2026 per FTSE Russell). DJIA changes irregularly with 1-5 days
 * notice. S&P 500 / 400 review quarterly (3rd Friday of Mar/Jun/Sep/Dec).
 *
 * This service logs prominent ops messages during those windows so the team
 * knows to:
 *   - Re-run scripts/derive-russell-membership.ts (Russell rebalance days)
 *   - Re-fetch SP500/SP400 from Wikipedia / scripts/populate-option-b-universe (S&P rebal days)
 *   - Manually update data/dow-jones.service.ts hardcoded list (DJIA changes)
 *
 * No email/Slack integration yet — Logger output flows to Render logs which
 * the team monitors.
 */
@Injectable()
export class ReconstitutionAlertService {
  private readonly logger = new Logger(ReconstitutionAlertService.name);

  /** Daily 7 AM UTC — checks each day's reconstitution status. */
  @Cron('0 7 * * *', { name: 'reconstitution-alerts', timeZone: 'UTC' })
  async runDailyCheck() {
    const todayStr = new Date().toISOString().split('T')[0];
    const [yearStr, monthStr, dayStr] = todayStr.split('-');
    const year = Number(yearStr);
    const month = Number(monthStr); // 1-12
    const day = Number(dayStr);

    // Russell semi-annual reconstitution windows
    // (per FTSE Russell 2026+ schedule: last week of June + mid-December)
    if (month === 6 && day >= 24 && day <= 30) {
      this.logger.warn(
        `🚨 RUSSELL JUNE RECONSTITUTION WINDOW (${todayStr}): Russell 1000/2000/Midcap membership changes today. Re-run scripts/derive-russell-membership.ts to pick up the new ranking.`,
      );
    }
    if (month === 12 && day >= 12 && day <= 18) {
      this.logger.warn(
        `🚨 RUSSELL DECEMBER RECONSTITUTION WINDOW (${todayStr}): Russell 1000/2000/Midcap membership changes today. Re-run scripts/derive-russell-membership.ts.`,
      );
    }

    // S&P quarterly review (3rd Friday of Mar/Jun/Sep/Dec — but rebalance is the following Friday)
    const isQuarterEndMonth = month === 3 || month === 6 || month === 9 || month === 12;
    if (isQuarterEndMonth && day >= 19 && day <= 25) {
      this.logger.warn(
        `🚨 S&P QUARTERLY REVIEW WINDOW (${todayStr}): S&P 500 / S&P MidCap 400 may add or remove constituents this week. Re-fetch from Wikipedia: re-run scripts/populate-option-b-universe.ts (in --dry-run mode first).`,
      );
    }

    // Year-end reminder for hardcoded Dow list
    if (month === 1 && day === 5) {
      this.logger.log(
        `📅 Annual reminder: verify q_nest/src/modules/stocks-market/services/index-sources/dow-jones.service.ts hardcoded list against the official DJIA 30 (changes 0-2× per year).`,
      );
    }
  }
}
