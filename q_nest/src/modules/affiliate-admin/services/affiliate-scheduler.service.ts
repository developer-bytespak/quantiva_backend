import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';
import { AffiliateAdminService } from './affiliate-admin.service';

@Injectable()
export class AffiliateSchedulerService {
  private readonly logger = new Logger(AffiliateSchedulerService.name);

  constructor(
    private prisma: PrismaService,
    private affiliateAdminService: AffiliateAdminService,
  ) {}

  /**
   * Monthly payout batch. Runs on the 1st of each month at 03:00 UTC. Same
   * code path the super admin can trigger manually via
   * POST /admin/super-admin/affiliates/payouts/run.
   *
   * Idempotent: only ACCRUED commission_events with payout_id IS NULL are
   * included, so a re-run on the same day picks up only newly accrued rows.
   */
  @Cron('0 3 1 * *', {
    name: 'affiliate-monthly-payout-batch',
    timeZone: 'UTC',
  })
  async runMonthlyPayoutBatch(): Promise<void> {
    this.logger.log('Running monthly affiliate payout batch');
    try {
      const result = await this.affiliateAdminService.generatePayoutBatch(null);
      this.logger.log(
        `Monthly payout batch complete: created ${result.created_payouts.length} payouts for ${result.period}`,
      );
    } catch (err: any) {
      this.logger.error(
        `Monthly affiliate payout batch failed: ${err?.message}`,
      );
    }
  }

  /**
   * Weekly fraud sweep. For each APPROVED affiliate, count signups in the
   * last 24h. If above the configured velocity threshold, write an audit log
   * row so the super admin sees a flagged list in the audit-log tab.
   *
   * Note: the attribution service already enforces this threshold inline (it
   * refuses to attribute when over). This sweep catches any below-threshold-
   * but-still-suspicious-cumulative patterns and ensures regular trail entries
   * even when nothing fires inline.
   */
  @Cron('0 9 * * 0', {
    name: 'affiliate-weekly-fraud-sweep',
    timeZone: 'UTC',
  })
  async runWeeklyFraudSweep(): Promise<void> {
    this.logger.log('Running weekly affiliate fraud-velocity sweep');
    try {
      const settings = await this.prisma.affiliate_program_settings.findFirst({
        where: { is_active: true },
        orderBy: { version: 'desc' },
        select: { affiliate_signup_velocity_24h: true },
      });
      if (!settings) return;
      const threshold = settings.affiliate_signup_velocity_24h;
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const grouped = await this.prisma.affiliate_referrals.groupBy({
        by: ['affiliate_id'],
        where: { attributed_at: { gte: since } },
        _count: { _all: true },
      });

      let flagged = 0;
      for (const row of grouped) {
        if (row._count._all < threshold) continue;
        await this.prisma.affiliate_audit_log.create({
          data: {
            affiliate_id: row.affiliate_id,
            action: 'AFFILIATE_VELOCITY_FLAG_SWEEP',
            metadata: {
              recent_signups_24h: row._count._all,
              threshold,
              swept_at: new Date().toISOString(),
            },
          },
        });
        flagged += 1;
      }

      this.logger.log(
        `Velocity sweep complete: flagged ${flagged} / ${grouped.length} affiliates over ${threshold}/24h`,
      );
    } catch (err: any) {
      this.logger.error(`Weekly fraud sweep failed: ${err?.message}`);
    }
  }
}
