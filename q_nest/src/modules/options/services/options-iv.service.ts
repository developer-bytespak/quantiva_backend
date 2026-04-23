import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';
import { OptionsBinanceService } from './options-binance.service';
import { OptionsAlpacaService } from './options-alpaca.service';
import { OptionCredentials } from './options-venue.interface';
import { ALPACA_DEFAULT_UNDERLYINGS } from './alpaca/alpaca-contract-specs';
import { FALLBACK_UNDERLYINGS } from '../options.config';
import axios from 'axios';

type Venue = 'BINANCE' | 'ALPACA';

@Injectable()
export class OptionsIvService {
  private readonly logger = new Logger(OptionsIvService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly optionsBinance: OptionsBinanceService,
    private readonly optionsAlpaca: OptionsAlpacaService,
  ) {}

  // ── Dynamic underlyings from Binance exchange info ──────

  async getAllUnderlyings(): Promise<string[]> {
    try {
      return await this.optionsBinance.getAllUnderlyings();
    } catch {
      // Fallback to known coins if Binance unreachable
      return FALLBACK_UNDERLYINGS;
    }
  }

  /** Curated Alpaca universe (keeps OPRA data costs bounded). */
  getAlpacaUnderlyings(): string[] {
    return [...ALPACA_DEFAULT_UNDERLYINGS];
  }

  /**
   * Alpaca market data requires authentication. IV snapshots run on a
   * schedule with no user in context, so we source creds from env.
   *
   * Primary: `ALPACA_SYSTEM_API_KEY` + `ALPACA_SYSTEM_API_SECRET` (lets ops
   * rotate options-cron creds independently from the stocks-market module).
   * Fallback: `ALPACA_API_KEY` + `ALPACA_SECRET_KEY` — the broader envs the
   * stocks-market and paper-trading modules already consume. Using the
   * fallback avoids forcing two env pairs when one platform Alpaca account
   * is enough.
   *
   * Returns null when neither pair is set — callers should skip Alpaca work
   * so the Binance path continues to function.
   */
  private systemAlpacaCreds(): OptionCredentials | null {
    const apiKey =
      process.env.ALPACA_SYSTEM_API_KEY || process.env.ALPACA_API_KEY;
    const apiSecret =
      process.env.ALPACA_SYSTEM_API_SECRET || process.env.ALPACA_SECRET_KEY;
    if (!apiKey || !apiSecret) return null;
    return { apiKey, apiSecret };
  }

  /**
   * Resolve an ATM implied-vol snapshot from Alpaca's chain endpoint.
   * Picks the call whose strike is closest to the underlying spot and
   * returns its `impliedVolatility`. Falls back to null if the chain has
   * no usable IV (e.g. weekend, market closed, or all-zero snapshot).
   */
  private async getAtmIvFromAlpaca(
    underlying: string,
    creds: OptionCredentials,
  ): Promise<number | null> {
    try {
      const chain = await this.optionsAlpaca.fetchOptionsChain(creds, underlying);
      if (!chain.contracts.length || !chain.underlyingPrice) return null;
      const spot = chain.underlyingPrice;
      let best: (typeof chain.contracts)[number] | null = null;
      let bestDist = Infinity;
      for (const c of chain.contracts) {
        if (c.type !== 'CALL') continue;
        if (!c.greeks?.impliedVolatility) continue;
        const dist = Math.abs(c.strike - spot);
        if (dist < bestDist) {
          bestDist = dist;
          best = c;
        }
      }
      const iv = best?.greeks?.impliedVolatility;
      return typeof iv === 'number' && Number.isFinite(iv) && iv > 0 ? iv : null;
    } catch (err: any) {
      this.logger.warn(`getAtmIvFromAlpaca failed for ${underlying}: ${err.message}`);
      return null;
    }
  }

  // ── Cron: snapshot IV every hour ─────────────────────

  @Cron('0 * * * *')
  async snapshotIv() {
    this.logger.log('Starting IV snapshot cron…');
    await Promise.all([this.snapshotBinanceIv(), this.snapshotAlpacaIv()]);
  }

  private async snapshotBinanceIv() {
    const underlyings = await this.getAllUnderlyings();
    this.logger.log(`Binance IV snapshot: ${underlyings.join(', ')}`);
    for (const underlying of underlyings) {
      try {
        const iv = await this.optionsBinance.getAtmIv(underlying);
        if (iv === null) continue;

        const [ivRank, ivPercentile] = await Promise.all([
          this.computeIvRank(underlying, iv, 'BINANCE'),
          this.computeIvPercentile(underlying, iv, 'BINANCE'),
        ]);

        await this.prisma.options_iv_history.create({
          data: {
            underlying,
            venue: 'BINANCE',
            iv_value: iv,
            iv_rank: ivRank,
            iv_percentile: ivPercentile,
          },
        });
        this.logger.log(`IV snapshot BINANCE ${underlying}: ${iv}`);
      } catch (err) {
        this.logger.error(`Binance IV snapshot failed for ${underlying}`, err);
      }
    }
  }

  private async snapshotAlpacaIv() {
    const creds = this.systemAlpacaCreds();
    if (!creds) {
      this.logger.warn(
        'Skipping Alpaca IV snapshot — set ALPACA_API_KEY + ALPACA_SECRET_KEY (or ALPACA_SYSTEM_API_KEY + ALPACA_SYSTEM_API_SECRET)',
      );
      return;
    }

    const underlyings = this.getAlpacaUnderlyings();
    this.logger.log(`Alpaca IV snapshot: ${underlyings.join(', ')}`);
    for (const underlying of underlyings) {
      try {
        const iv = await this.getAtmIvFromAlpaca(underlying, creds);
        if (iv === null) continue;

        const [ivRank, ivPercentile] = await Promise.all([
          this.computeIvRank(underlying, iv, 'ALPACA'),
          this.computeIvPercentile(underlying, iv, 'ALPACA'),
        ]);

        await this.prisma.options_iv_history.create({
          data: {
            underlying,
            venue: 'ALPACA',
            iv_value: iv,
            iv_rank: ivRank,
            iv_percentile: ivPercentile,
          },
        });
        this.logger.log(`IV snapshot ALPACA ${underlying}: ${iv}`);
      } catch (err) {
        this.logger.error(`Alpaca IV snapshot failed for ${underlying}`, err);
      }
    }
  }

  // ── IV Rank & Percentile (vs 1-year history, per venue) ──

  private async getOneYearIvValues(underlying: string, venue: Venue): Promise<number[]> {
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

    const history = await this.prisma.options_iv_history.findMany({
      where: {
        underlying,
        venue,
        recorded_at: { gte: oneYearAgo },
      },
      select: { iv_value: true },
      orderBy: { recorded_at: 'asc' },
    });

    return history.map((h) => Number(h.iv_value));
  }

  async computeIvRank(underlying: string, currentIv: number, venue: Venue = 'BINANCE'): Promise<number> {
    const values = await this.getOneYearIvValues(underlying, venue);
    if (values.length < 2) return 0.5;

    const min = values.reduce((m, v) => Math.min(m, v), Infinity);
    const max = values.reduce((m, v) => Math.max(m, v), -Infinity);
    if (max === min) return 0.5;

    return Math.max(0, Math.min(1, (currentIv - min) / (max - min)));
  }

  async computeIvPercentile(underlying: string, currentIv: number, venue: Venue = 'BINANCE'): Promise<number> {
    const values = await this.getOneYearIvValues(underlying, venue);
    if (values.length < 2) return 0.5;

    const below = values.filter((v) => v < currentIv).length;
    return below / values.length;
  }

  // ── Query helpers ──────────────────────────────────────

  async getLatestIv(underlying: string, venue: Venue = 'BINANCE') {
    return this.prisma.options_iv_history.findFirst({
      where: { underlying, venue },
      orderBy: { recorded_at: 'desc' },
    });
  }

  async getIvHistory(underlying: string, days = 90, venue: Venue = 'BINANCE') {
    const since = new Date();
    since.setDate(since.getDate() - days);

    return this.prisma.options_iv_history.findMany({
      where: {
        underlying,
        venue,
        recorded_at: { gte: since },
      },
      orderBy: { recorded_at: 'asc' },
    });
  }

  async getIvRankData(underlying: string, venue: Venue = 'BINANCE') {
    const latest = await this.getLatestIv(underlying, venue);
    if (!latest) return null;

    return {
      underlying,
      venue,
      currentIv: Number(latest.iv_value),
      ivRank: latest.iv_rank ? Number(latest.iv_rank) : null,
      ivPercentile: latest.iv_percentile ? Number(latest.iv_percentile) : null,
      recordedAt: latest.recorded_at,
    };
  }

  // ── Spot price (Binance public index endpoint) ──────────

  async getSpotPrice(underlying: string): Promise<number | null> {
    try {
      const url = `https://eapi.binance.com/eapi/v1/index?underlying=${underlying}USDT`;
      const { data } = await axios.get(url, { timeout: 5000 });
      const price = parseFloat(data?.indexPrice || '0');
      return price > 0 ? price : null;
    } catch (err: any) {
      this.logger.warn(`getSpotPrice failed for ${underlying}: ${err.message}`);
      return null;
    }
  }

  // ── Recent daily klines for momentum and volume scoring ──

  async getPriceData(underlying: string, limit = 60): Promise<number[] | null> {
    try {
      const symbol = `${underlying}USDT`;
      const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=${limit}`;
      const { data } = await axios.get(url, { timeout: 5000 });
      if (!Array.isArray(data) || data.length === 0) return null;
      // kline[4] is the close price
      return data.map((k: any[]) => parseFloat(k[4]));
    } catch (err: any) {
      this.logger.warn(`getPriceData failed for ${underlying}: ${err.message}`);
      return null;
    }
  }

  async getVolumeData(underlying: string, limit = 60): Promise<number[] | null> {
    try {
      const symbol = `${underlying}USDT`;
      const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=${limit}`;
      const { data } = await axios.get(url, { timeout: 5000 });
      if (!Array.isArray(data) || data.length === 0) return null;
      // kline[5] is the volume
      return data.map((k: any[]) => parseFloat(k[5]));
    } catch (err: any) {
      this.logger.warn(`getVolumeData failed for ${underlying}: ${err.message}`);
      return null;
    }
  }

  // ── Cleanup: trim IV history older than 1 year ──────────

  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async cleanupOldIvHistory() {
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

    const result = await this.prisma.options_iv_history.deleteMany({
      where: { recorded_at: { lt: oneYearAgo } },
    });
    if (result.count > 0) {
      this.logger.log(`Cleaned up ${result.count} IV history records older than 1 year`);
    }
  }
}
