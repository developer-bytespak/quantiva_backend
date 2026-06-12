import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { AlertDispatchService } from './alert-dispatch.service';

export interface NewBuySignalParams {
  assetId: string;
  symbol: string;
  name?: string | null;
  assetType: string; // 'stock' | 'crypto'
  strategyName?: string | null;
  confidence?: number | null; // 0..1
}

/**
 * Track C — New-Signal Alerts ("signals mail").
 * Called by the signal crons when a brand-new BUY signal is persisted (result.created === true).
 * Only users who ACTUALLY HOLD that asset (user_holdings join on asset_id) get notified — this
 * is what turns the 6–14k signals/day firehose into a relevant nudge instead of spam.
 * Designed to be called fire-and-forget from the hot signal loop; all errors are swallowed here.
 */
@Injectable()
export class SignalAlertsService {
  private readonly logger = new Logger(SignalAlertsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatch: AlertDispatchService,
    private readonly config: ConfigService,
  ) {}

  private get cooldownHours(): number {
    return Number(this.config.get('SIGNAL_ALERT_COOLDOWN_HOURS') ?? 8);
  }

  async onNewBuySignal(params: NewBuySignalParams): Promise<void> {
    try {
      const holders = await this.prisma.user_holdings.findMany({
        where: { asset_id: params.assetId, quantity: { gt: 0 } },
        select: { user_id: true, symbol: true },
        distinct: ['user_id'],
      });
      if (holders.length === 0) return;

      const display = params.name || params.symbol;
      const confidencePct =
        params.confidence != null ? `${Math.round(Number(params.confidence) * 100)}%` : '';
      const strategy = params.strategyName || 'A strategy';

      const title = `New BUY signal: ${display}`;
      const message = confidencePct
        ? `${strategy} just turned bullish on ${display} (${confidencePct} confidence) — an asset you hold.`
        : `${strategy} just turned bullish on ${display} — an asset you hold.`;

      for (const h of holders) {
        await this.dispatch.dispatch({
          userId: h.user_id,
          symbol: h.symbol,
          assetId: params.assetId,
          type: 'signal_alert',
          title,
          message,
          emailTemplate: 'signal_alert',
          emailVars: {
            assetName: display,
            action: 'BUY',
            strategyName: strategy,
            confidence: confidencePct,
          },
          cooldownHours: this.cooldownHours,
        });
      }
      this.logger.log(`Signal alert: BUY ${display} → ${holders.length} holder(s)`);
    } catch (err: any) {
      this.logger.warn(`Signal alert failed for asset ${params.assetId}: ${err?.message ?? err}`);
    }
  }
}
