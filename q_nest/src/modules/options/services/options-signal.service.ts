import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { OptionsIvService } from './options-iv.service';
import { OptionsAlpacaService } from './options-alpaca.service';
import { OptionCredentials } from './options-venue.interface';
import { ALPACA_CONTRACT_MULTIPLIER } from './alpaca/alpaca-contract-specs';
import axios from 'axios';

type Venue = 'BINANCE' | 'ALPACA';

@Injectable()
export class OptionsSignalService {
  private readonly logger = new Logger(OptionsSignalService.name);
  private readonly pythonApiUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly ivService: OptionsIvService,
    private readonly optionsAlpaca: OptionsAlpacaService,
  ) {
    this.pythonApiUrl =
      this.configService.get<string>('PYTHON_API_URL') || 'http://localhost:8000';
  }

  // ── Cron: generate signals every 2 hours (aligned to even UTC hours) ──

  private isGenerating = false;

  @Cron('0 */2 * * *')
  async generateSignals() {
    if (this.isGenerating) {
      this.logger.warn('Signal generation already in progress, skipping this run');
      return;
    }
    this.isGenerating = true;
    try {
      this.logger.log('Starting AI options signal generation…');
      await Promise.all([
        this.generateBinanceSignals(),
        this.generateAlpacaSignals(),
      ]);
    } finally {
      this.isGenerating = false;
    }
  }

  private async generateBinanceSignals() {
    const underlyings = await this.ivService.getAllUnderlyings();
    this.logger.log(`Binance signal generation: ${underlyings.join(', ')}`);
    for (const underlying of underlyings) {
      try {
        await this.generateForUnderlying('BINANCE', underlying);
      } catch (err) {
        this.logger.error(`Binance signal generation failed for ${underlying}`, err);
      }
    }
  }

  private async generateAlpacaSignals() {
    const apiKey = process.env.ALPACA_SYSTEM_API_KEY;
    const apiSecret = process.env.ALPACA_SYSTEM_API_SECRET;
    if (!apiKey || !apiSecret) {
      this.logger.debug(
        'Skipping Alpaca signal generation — ALPACA_SYSTEM_API_KEY not configured',
      );
      return;
    }

    const underlyings = this.ivService.getAlpacaUnderlyings();
    this.logger.log(`Alpaca signal generation: ${underlyings.join(', ')}`);
    for (const underlying of underlyings) {
      try {
        await this.generateForUnderlying('ALPACA', underlying, { apiKey, apiSecret });
      } catch (err) {
        this.logger.error(`Alpaca signal generation failed for ${underlying}`, err);
      }
    }
  }

  /**
   * Shared signal-generation path. Gathers IV/spot/price/volume context,
   * calls the Python engine with venue-specific `contract_multiplier` so the
   * engine's sizing math rounds to integer contracts for Alpaca (vs fractional
   * BTC-denominated qty for Binance), then persists each returned signal
   * with `venue` tagged for later filtering.
   */
  private async generateForUnderlying(
    venue: Venue,
    underlying: string,
    alpacaCreds?: OptionCredentials,
  ) {
    // 1. IV context — read from options_iv_history, scoped to this venue.
    const ivData = await this.ivService.getIvRankData(underlying, venue);

    // 2. Spot price + time-series context.
    //    Binance: pulled from Binance public klines (existing path).
    //    Alpaca:  pulled from the options chain's dailyBar (no separate
    //             equity klines endpoint wired up yet; price_data/volume_data
    //             are left null so the engine relies on signal scores).
    let spotPrice: number | null = null;
    let priceData: number[] | null = null;
    let volumeData: number[] | null = null;

    if (venue === 'BINANCE') {
      [spotPrice, priceData, volumeData] = await Promise.all([
        this.ivService.getSpotPrice(underlying),
        this.ivService.getPriceData(underlying),
        this.ivService.getVolumeData(underlying),
      ]);
    } else if (venue === 'ALPACA' && alpacaCreds) {
      try {
        const chain = await this.optionsAlpaca.fetchOptionsChain(alpacaCreds, underlying);
        spotPrice = chain.underlyingPrice || null;
      } catch (err: any) {
        this.logger.warn(
          `Could not fetch Alpaca spot for ${underlying}: ${err.message}`,
        );
      }
    }

    const contractMultiplier =
      venue === 'ALPACA' ? ALPACA_CONTRACT_MULTIPLIER : 0.01;

    const { data } = await axios.post(
      `${this.pythonApiUrl}/api/v1/options-signals/generate`,
      {
        underlying,
        venue,
        contract_multiplier: contractMultiplier,
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

    for (const sig of data.signals) {
      await this.prisma.options_signals_ai.create({
        data: {
          underlying,
          venue,
          strategy: sig.strategy,
          direction: sig.direction,
          score: sig.score,
          confidence: sig.confidence,
          iv_rank: sig.iv_rank ?? ivData?.ivRank ?? null,
          iv_value: sig.iv_value ?? ivData?.currentIv ?? null,
          spot_price: sig.spot_price ?? spotPrice ?? null,
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
      `Generated ${data.signals.length} ${venue} AI signals for ${underlying}`,
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

  async getActiveSignals(underlying?: string, limit = 20, venue?: Venue) {
    const now = new Date();
    return this.prisma.options_signals_ai.findMany({
      where: {
        ...(underlying ? { underlying } : {}),
        ...(venue ? { venue } : {}),
        expires_at: { gt: now },
      },
      orderBy: { created_at: 'desc' },
      distinct: ['underlying', 'strategy'],
      take: limit,
    });
  }

  async getSignalById(id: string) {
    return this.prisma.options_signals_ai.findUnique({ where: { id } });
  }

  async getSignalHistory(underlying: string, days = 30, venue?: Venue) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    return this.prisma.options_signals_ai.findMany({
      where: {
        underlying,
        ...(venue ? { venue } : {}),
        created_at: { gte: since },
      },
      orderBy: { created_at: 'desc' },
    });
  }
}
