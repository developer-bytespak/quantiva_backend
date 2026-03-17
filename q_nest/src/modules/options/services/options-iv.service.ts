import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';
import { OptionsBinanceService } from './options-binance.service';
import axios from 'axios';

const TRACKED_UNDERLYINGS = ['BTC', 'ETH'];

@Injectable()
export class OptionsIvService {
  private readonly logger = new Logger(OptionsIvService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly optionsBinance: OptionsBinanceService,
  ) {}

  // ── Dynamic underlyings from Binance exchange info ──────

  async getAllUnderlyings(): Promise<string[]> {
    try {
      return await this.optionsBinance.getAllUnderlyings();
    } catch {
      // Fallback to known coins if Binance unreachable
      return TRACKED_UNDERLYINGS;
    }
  }

  // ── Cron: snapshot IV every 4 hours ─────────────────────

  @Cron(CronExpression.EVERY_4_HOURS)
  async snapshotIv() {
    this.logger.log('Starting IV snapshot cron…');
    const underlyings = await this.getAllUnderlyings();
    this.logger.log(`Snapshotting IV for: ${underlyings.join(', ')}`);
    for (const underlying of underlyings) {
      try {
        const iv = await this.optionsBinance.getAtmIv(underlying);
        if (iv === null) continue;

        await this.prisma.options_iv_history.create({
          data: {
            underlying,
            iv_value: iv,
            iv_rank: await this.computeIvRank(underlying, iv),
          },
        });
        this.logger.log(`IV snapshot ${underlying}: ${iv}`);
      } catch (err) {
        this.logger.error(`IV snapshot failed for ${underlying}`, err);
      }
    }
  }

  // ── IV Rank (percentile vs 1-year history) ─────────────

  async computeIvRank(underlying: string, currentIv: number): Promise<number> {
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

    const history = await this.prisma.options_iv_history.findMany({
      where: {
        underlying,
        recorded_at: { gte: oneYearAgo },
      },
      select: { iv_value: true },
      orderBy: { recorded_at: 'asc' },
    });

    if (history.length < 2) return 0.5; // not enough data

    const values = history.map((h) => Number(h.iv_value));
    const below = values.filter((v) => v < currentIv).length;
    return below / values.length;
  }

  // ── Query helpers ──────────────────────────────────────

  async getLatestIv(underlying: string) {
    return this.prisma.options_iv_history.findFirst({
      where: { underlying },
      orderBy: { recorded_at: 'desc' },
    });
  }

  async getIvHistory(underlying: string, days = 90) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    return this.prisma.options_iv_history.findMany({
      where: {
        underlying,
        recorded_at: { gte: since },
      },
      orderBy: { recorded_at: 'asc' },
    });
  }

  async getIvRankData(underlying: string) {
    const latest = await this.getLatestIv(underlying);
    if (!latest) return null;

    return {
      underlying,
      currentIv: Number(latest.iv_value),
      ivRank: latest.iv_rank ? Number(latest.iv_rank) : null,
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

  // ── Recent daily closes for momentum scoring ────────────

  async getPriceData(underlying: string, limit = 20): Promise<number[] | null> {
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
}
