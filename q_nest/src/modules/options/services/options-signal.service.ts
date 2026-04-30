import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { OptionsIvService } from './options-iv.service';
import { OptionsAlpacaService } from './options-alpaca.service';
import { OptionCredentials } from './options-venue.interface';
import { ALPACA_CONTRACT_MULTIPLIER } from './alpaca/alpaca-contract-specs';
import {
  computeEv,
  computePop,
  relevantDaysToExpiry,
  type PopLeg,
} from './alpaca/pop-engine';
import axios from 'axios';

type Venue = 'BINANCE' | 'ALPACA';

// Strategy templates that COLLECT premium (net credit). Everything else
// pays a net debit. Source of truth: the Python engine's strategy templates
// — `iron_condor` and `short_put` are the only credit-receiving templates
// currently emitted to `options_signals_ai`.
const CREDIT_STRATEGIES = new Set(['iron_condor', 'short_put']);

/**
 * Pull a numeric value out of one of the engine's pre-formatted USD strings
 * (e.g. `"$5.50"`, `"$1,264"`, `"$-2.75"`). Returns null on `null`/`""` or
 * when no number is found. Tolerant of commas, currency symbols, and the
 * `$X.XX` vs `$X` shapes the engine emits across strategies.
 */
function parseUsdString(s: string | null | undefined): number | null {
  if (s == null || s === '') return null;
  const cleaned = String(s).replace(/[$,\s]/g, '');
  const m = cleaned.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

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

  // ── Cron: generate signals every hour (aligned to the top of the hour) ──
  //
  // Hourly regeneration keeps strikes aligned to current spot — a 30-min-old
  // "ATM call" picked when GOOG was at $367 isn't ATM anymore once GOOG
  // drifts to $373. Live-recomputing POP at read time would fix the
  // probability number but not the strike misalignment, so the right answer
  // is fresh signals on a tighter cadence. Per-strategy TTLs (in
  // options_strategies.py) drop to ~2h so a missed cron tick only leaves
  // stale signals visible briefly before they self-expire.

  private isGenerating = false;

  @Cron('0 * * * *')
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
    // Primary: a dedicated options-specific system key (lets ops rotate it
    // independently). Fallback: the broader ALPACA_API_KEY the stocks-market
    // and paper-trading modules already consume — avoids forcing two envs
    // when one platform Alpaca account serves everything.
    const apiKey =
      process.env.ALPACA_SYSTEM_API_KEY || process.env.ALPACA_API_KEY;
    const apiSecret =
      process.env.ALPACA_SYSTEM_API_SECRET || process.env.ALPACA_SECRET_KEY;
    if (!apiKey || !apiSecret) {
      this.logger.warn(
        'Skipping Alpaca signal generation — set ALPACA_API_KEY + ALPACA_SECRET_KEY (or ALPACA_SYSTEM_API_KEY + ALPACA_SYSTEM_API_SECRET)',
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
        // Python's engine validates against {'crypto','stock'} — pass the
        // right one so equity underlyings aren't rejected by the crypto
        // default. Aligns OCC vs Binance-dash symbol generation downstream.
        asset_type: venue === 'ALPACA' ? 'stock' : 'crypto',
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
    const rows = await this.prisma.options_signals_ai.findMany({
      where: {
        ...(underlying ? { underlying } : {}),
        ...(venue ? { venue } : {}),
        expires_at: { gt: now },
      },
      orderBy: { created_at: 'desc' },
      distinct: ['underlying', 'strategy'],
      take: limit,
    });
    return rows.map((r) => this.enrichSignal(r));
  }

  async getSignalById(id: string) {
    const row = await this.prisma.options_signals_ai.findUnique({ where: { id } });
    return row ? this.enrichSignal(row) : null;
  }

  async getSignalHistory(underlying: string, days = 30, venue?: Venue) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const rows = await this.prisma.options_signals_ai.findMany({
      where: {
        underlying,
        ...(venue ? { venue } : {}),
        created_at: { gte: since },
      },
      orderBy: { created_at: 'desc' },
    });
    return rows.map((r) => this.enrichSignal(r));
  }

  /**
   * Add `probabilityOfProfit`, `expectedValuePerUnit`, `expectedValueTotal`
   * to a raw signal row. Falls back to nulls whenever inputs are missing or
   * the strategy isn't recognised — the frontend hides those fields rather
   * than rendering "0%" or "$0".
   *
   * Inputs come from the signal row itself (spot, IV, legs JSON, strategy,
   * stored max_profit/max_loss strings). The contract multiplier is
   * approximated as 100 for ALPACA (US equity options) and 1 for BINANCE
   * (crypto options); the modal recomputes with the live multiplier when
   * the user opens it, but at signal-list level "1× crypto" is close enough
   * for the EV display to be directionally correct.
   */
  private enrichSignal(row: any) {
    const legsRaw = (row.legs as any[]) ?? [];
    const legs: PopLeg[] = legsRaw.map((l) => ({
      side: l.side,
      type: l.type,
      strike: Number(l.strike),
      expiry: l.expiry,
      ratio: l.ratio,
    }));

    const spot = row.spot_price != null ? Number(row.spot_price) : 0;
    const iv = row.iv_value != null ? Number(row.iv_value) : 0;
    const days = relevantDaysToExpiry(row.strategy, legs);

    const maxProfitPerUnit = parseUsdString(row.max_profit);
    const maxLossPerUnit = parseUsdString(row.max_loss);

    // Reconstruct signed netPerUnit from the engine-stored max numbers.
    // Debit strategies: the max_loss IS the debit you paid (positive net).
    // Credit strategies: the max_profit IS the credit you received
    // (negative net under our sign convention).
    const isCredit = CREDIT_STRATEGIES.has(row.strategy);
    const netPerUnit = isCredit
      ? -(maxProfitPerUnit ?? 0)
      : maxLossPerUnit ?? 0;

    const nullEnrichment = {
      probabilityOfProfit: null as number | null,
      expectedValuePerUnit: null as number | null,
      expectedValueTotal: null as number | null,
    };

    if (!days || spot <= 0 || iv <= 0 || netPerUnit === 0) {
      return { ...row, ...nullEnrichment };
    }

    const pop = computePop({
      strategy: row.strategy,
      legs,
      spotPrice: spot,
      ivValue: iv,
      daysToExpiry: days,
      netPerUnit,
    });

    if (pop == null || maxProfitPerUnit == null || maxLossPerUnit == null) {
      return {
        ...row,
        ...nullEnrichment,
        probabilityOfProfit: pop !== null ? Math.round(pop * 1e4) / 1e4 : null,
      };
    }

    const evPerUnit = computeEv(pop, maxProfitPerUnit, maxLossPerUnit);
    const multiplier = row.venue === 'ALPACA' ? ALPACA_CONTRACT_MULTIPLIER : 1;
    const evTotal = evPerUnit * multiplier;

    return {
      ...row,
      probabilityOfProfit: Math.round(pop * 1e4) / 1e4,
      expectedValuePerUnit: Math.round(evPerUnit * 100) / 100,
      expectedValueTotal: Math.round(evTotal * 100) / 100,
    };
  }
}
