import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { OptionsIvService } from './options-iv.service';
import { FALLBACK_UNDERLYINGS } from '../options.config';
import axios from 'axios';

@Injectable()
export class OptionsSignalService {
  private readonly logger = new Logger(OptionsSignalService.name);
  private readonly pythonApiUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly ivService: OptionsIvService,
  ) {
    this.pythonApiUrl =
      this.configService.get<string>('PYTHON_API_URL') || 'http://localhost:8000';
  }

  // ── Cron: generate signals every 6 hours ───────────────

  @Cron(CronExpression.EVERY_6_HOURS)
  async generateSignals() {
    this.logger.log('Starting AI options signal generation…');
    const underlyings = await this.ivService.getAllUnderlyings();
    this.logger.log(`Generating signals for: ${underlyings.join(', ')}`);
    for (const underlying of underlyings) {
      try {
        await this.generateForUnderlying(underlying);
      } catch (err) {
        this.logger.error(`Signal generation failed for ${underlying}`, err);
      }
    }
  }

  private async generateForUnderlying(underlying: string) {
    // 1. Gather IV context, spot price, recent prices, and volume in parallel
    const [ivData, spotPrice, priceData, volumeData] = await Promise.all([
      this.ivService.getIvRankData(underlying),
      this.ivService.getSpotPrice(underlying),
      this.ivService.getPriceData(underlying),
      this.ivService.getVolumeData(underlying),
    ]);

    // 2. Call Python engine
    const { data } = await axios.post(
      `${this.pythonApiUrl}/api/v1/options-signals/generate`,
      {
        underlying,
        iv_rank: ivData?.ivRank ?? null,
        iv_value: ivData?.currentIv ?? null,
        spot_price: spotPrice ?? null,
        price_data: priceData ?? null,
        volume_data: volumeData ?? null,
      },
      {
        timeout: 30_000,
        headers: { 'X-Internal-Api-Key': process.env.INTERNAL_API_KEY },
      },
    );

    if (!data.signals || !Array.isArray(data.signals)) return;

    // 3. Persist each signal
    for (const sig of data.signals) {
      await this.prisma.options_signals_ai.create({
        data: {
          underlying,
          strategy: sig.strategy,
          direction: sig.direction,
          score: sig.score,
          confidence: sig.confidence,
          iv_rank: sig.iv_rank ?? ivData?.ivRank ?? null,
          iv_value: sig.iv_value ?? ivData?.currentIv ?? null,
          spot_price: sig.spot_price ?? null,
          legs: sig.legs,
          reasoning: sig.reasoning ?? null,
          risk_reward: sig.risk_reward ?? null,
          max_profit: sig.max_profit ?? null,
          max_loss: sig.max_loss ?? null,
          expires_at: new Date(sig.expires_at),
        },
      });
    }

    this.logger.log(
      `Generated ${data.signals.length} AI signals for ${underlying}`,
    );
  }

  // ── Cron: cleanup expired signals ───────────────────────

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async cleanupExpiredSignals() {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const result = await this.prisma.options_signals_ai.deleteMany({
      where: { expires_at: { lt: sevenDaysAgo } },
    });
    if (result.count > 0) {
      this.logger.log(`Cleaned up ${result.count} expired AI signals (>7 days old)`);
    }
  }

  /**
   * Validate that a signal has not expired before allowing order placement.
   * Called from OptionsService.placeOrder when signalId is provided.
   */
  async validateSignalNotExpired(signalId: string): Promise<void> {
    const signal = await this.prisma.options_signals_ai.findUnique({
      where: { id: signalId },
      select: { expires_at: true, underlying: true, strategy: true },
    });

    if (!signal) {
      // Could be a legacy signal from options_signals table — skip check
      return;
    }

    if (signal.expires_at && signal.expires_at < new Date()) {
      throw new Error(
        `Signal for ${signal.underlying} (${signal.strategy}) expired at ${signal.expires_at.toISOString()}. Please use a fresh signal.`,
      );
    }
  }

  // ── Query helpers ──────────────────────────────────────

  async getActiveSignals(underlying?: string, limit = 20) {
    const now = new Date();
    return this.prisma.options_signals_ai.findMany({
      where: {
        ...(underlying ? { underlying } : {}),
        expires_at: { gt: now },
      },
      orderBy: { created_at: 'desc' },
      // Keep only the latest signal per (underlying, strategy) pair
      distinct: ['underlying', 'strategy'],
      take: limit,
    });
  }

  async getSignalById(id: string) {
    return this.prisma.options_signals_ai.findUnique({ where: { id } });
  }

  async getSignalHistory(underlying: string, days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    return this.prisma.options_signals_ai.findMany({
      where: {
        underlying,
        created_at: { gte: since },
      },
      orderBy: { created_at: 'desc' },
    });
  }
}
