import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { BinanceService } from '../binance/binance.service';
import { AlpacaMarketService } from '../stocks-market/services/alpaca-market.service';
import { AlertDispatchService } from './alert-dispatch.service';

const QUOTE_SUFFIXES = ['USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD', 'USD'];
function toBaseSymbol(pair: string): string {
  const u = pair.toUpperCase();
  for (const q of QUOTE_SUFFIXES) if (u.length > q.length && u.endsWith(q)) return u.slice(0, -q.length);
  return u;
}

// Stablecoins / quote currencies have no meaningful self-quoted chart (USDT/USDT)
// and can't move enough to alert — pricing them just 400s "Invalid symbol".
const STABLECOINS = new Set(['USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD', 'USDP', 'DAI', 'USD']);

/**
 * Track A — Holding Price-Move Alerts.
 * Every 15 min: for each DISTINCT asset that some real user holds (from user_holdings),
 * compute the ~15-min % move from candles. If it crosses the threshold, alert every holder.
 * Crypto via Binance OHLCV, stocks via Alpaca bars (skipped when the market is closed —
 * detected by a stale latest bar). Reuses AlertDispatchService for cooldown + fan-out.
 */
@Injectable()
export class HoldingAlertsService {
  private readonly logger = new Logger(HoldingAlertsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly binance: BinanceService,
    private readonly alpacaMarket: AlpacaMarketService,
    private readonly dispatch: AlertDispatchService,
    private readonly config: ConfigService,
  ) {}

  private get cryptoThreshold(): number {
    return Number(this.config.get('HOLDING_ALERT_CRYPTO_PCT') ?? 5);
  }
  private get stockThreshold(): number {
    return Number(this.config.get('HOLDING_ALERT_STOCK_PCT') ?? 3);
  }
  private get cooldownHours(): number {
    return Number(this.config.get('HOLDING_ALERT_COOLDOWN_HOURS') ?? 4);
  }

  @Cron('*/15 * * * *', { name: 'holding-price-alerts' })
  async scheduledCheck(): Promise<void> {
    if (this.config.get('ENABLE_CRONS') === 'false') return;
    await this.checkAllHeldAssets();
  }

  async checkAllHeldAssets(): Promise<{ assets: number; triggered: number }> {
    const assets = await this.prisma.user_holdings.findMany({
      where: { quantity: { gt: 0 } },
      select: { symbol: true, asset_type: true },
      distinct: ['symbol', 'asset_type'],
    });

    this.logger.log(`Holding-alert check: ${assets.length} distinct held asset(s)`);
    let triggered = 0;

    for (const a of assets) {
      try {
        const pct = await this.percentChange15m(a.symbol, a.asset_type);
        if (pct === null) continue;
        const threshold = a.asset_type === 'crypto' ? this.cryptoThreshold : this.stockThreshold;
        if (Math.abs(pct) < threshold) continue;

        triggered++;
        await this.alertHolders(a.symbol, a.asset_type, pct);
      } catch (err: any) {
        this.logger.warn(`Holding-alert failed for ${a.symbol} (${a.asset_type}): ${err?.message ?? err}`);
      }
    }

    this.logger.log(`Holding-alert check done: ${triggered} asset(s) crossed threshold`);
    return { assets: assets.length, triggered };
  }

  /** ~15-min % change from the last two completed candles. null if unavailable / market closed. */
  private async percentChange15m(symbol: string, assetType: string): Promise<number | null> {
    if (assetType === 'crypto') {
      // Stablecoin holdings have no tradable chart — skip rather than 400.
      if (STABLECOINS.has(symbol.toUpperCase()) || STABLECOINS.has(toBaseSymbol(symbol))) {
        return null;
      }
      const candles = await this.binance.getOHLCV(toBaseSymbol(symbol), '15m', 3);
      if (!candles || candles.length < 2) return null;
      const prev = candles[candles.length - 2].close;
      const curr = candles[candles.length - 1].close;
      if (!prev) return null;
      return ((curr - prev) / prev) * 100;
    }

    // stock
    const bars = await this.alpacaMarket.getHistoricalBars(symbol, '15Min', 3);
    if (!bars || bars.length < 2) return null;
    const last = bars[bars.length - 1];
    // Market-closed guard: if the latest bar is older than ~45 min, prices are stale → skip.
    if (Date.now() - new Date(last.t).getTime() > 45 * 60 * 1000) return null;
    const prev = bars[bars.length - 2].c;
    if (!prev) return null;
    return ((last.c - prev) / prev) * 100;
  }

  private async alertHolders(symbol: string, assetType: string, pct: number): Promise<void> {
    const holders = await this.prisma.user_holdings.findMany({
      where: { symbol, asset_type: assetType, quantity: { gt: 0 } },
      select: { user_id: true, asset_id: true },
      distinct: ['user_id'],
    });
    if (holders.length === 0) return;

    const display = assetType === 'crypto' ? toBaseSymbol(symbol) : symbol;
    const up = pct >= 0;
    const pctAbs = Math.abs(pct).toFixed(2);
    const direction = up ? 'up' : 'down';
    const arrow = up ? '▲' : '▼';
    const title = `${display} ${arrow} ${pctAbs}%`;
    const message = `${display} moved ${up ? '+' : '-'}${pctAbs}% in the last 15 minutes.`;

    for (const h of holders) {
      await this.dispatch.dispatch({
        userId: h.user_id,
        symbol,
        assetId: h.asset_id,
        type: 'price_alert',
        title,
        message,
        emailTemplate: 'holding_move_alert',
        emailVars: { assetName: display, percent: pctAbs, direction },
        cooldownHours: this.cooldownHours,
      });
    }
  }
}
