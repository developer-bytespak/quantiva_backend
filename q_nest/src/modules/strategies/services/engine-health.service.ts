import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { PythonApiService } from '../../../kyc/integrations/python-api.service';
import axios from 'axios';

export type EngineStatus = 'ok' | 'fallback' | 'failed' | 'no_canary';
export type ProbeStatus = 'ok' | 'fail' | 'skip';

export interface EngineReport {
  status: EngineStatus;
  score: number | null;
  confidence: number | null;
  reason?: string;
}

export interface ThirdPartyReport {
  status: ProbeStatus;
  http_code?: number;
  latency_ms?: number;
  reason?: string;
}

@Injectable()
export class EngineHealthService {
  private readonly logger = new Logger(EngineHealthService.name);

  // 5 engines that fusion combines. Keep in sync with FusionEngine._WEIGHT_KEYS.
  private readonly ENGINE_KEYS = ['sentiment', 'trend', 'fundamental', 'event_risk', 'liquidity'];

  constructor(
    private prisma: PrismaService,
    private pythonApi: PythonApiService,
  ) {}

  async getHealth() {
    const [engines, thirdParty, signalFreshness] = await Promise.all([
      this.probeEngines(),
      this.probeThirdParties(),
      this.checkSignalFreshness(),
    ]);

    // Overall status: red if any engine is failed for both asset types or if signals
    // haven't been written in the last hour; yellow if any engine is on fallback;
    // green otherwise.
    const allEngineStatuses: EngineStatus[] = [
      ...Object.values(engines.crypto || {}).map((e) => e.status),
      ...Object.values(engines.stock || {}).map((e) => e.status),
    ];
    const anyFailed = allEngineStatuses.includes('failed');
    const anyFallback = allEngineStatuses.includes('fallback');
    const signalsStale = signalFreshness.minutes_since_newest > 60;
    const overall =
      anyFailed || signalsStale ? 'red' : anyFallback ? 'yellow' : 'green';

    return {
      timestamp: new Date().toISOString(),
      overall,
      engines,
      third_party: thirdParty,
      signal_freshness: signalFreshness,
    };
  }

  // Probe Python by generating a signal for a canary asset of each type.
  // Returns per-engine status derived from the response's engine_scores block.
  private async probeEngines(): Promise<{
    crypto: Record<string, EngineReport>;
    stock: Record<string, EngineReport>;
  }> {
    const [crypto, stock] = await Promise.all([
      this.probeAssetType('crypto', 'BTC'),
      this.probeAssetType('stock', 'AAPL'),
    ]);
    return { crypto, stock };
  }

  private async probeAssetType(
    assetType: 'crypto' | 'stock',
    canarySymbol: string,
  ): Promise<Record<string, EngineReport>> {
    // Find the canary asset in the DB. If missing, return no_canary on every engine.
    const asset = await this.prisma.assets.findFirst({
      where: { symbol: canarySymbol, asset_type: assetType },
    });

    if (!asset) {
      return Object.fromEntries(
        this.ENGINE_KEYS.map((k) => [
          k,
          { status: 'no_canary' as EngineStatus, score: null, confidence: null, reason: `${canarySymbol} not in assets table` },
        ]),
      );
    }

    // Use the latest known market price as canary market_data. If unavailable,
    // Python's engines will use their own fallback or skip; we'll still get a
    // useful per-engine status from the response.
    const latestTrending = await this.prisma.trending_assets.findFirst({
      where: { asset_id: asset.asset_id },
      orderBy: { poll_timestamp: 'desc' },
    });

    const marketData: Record<string, any> = {
      price: latestTrending?.price_usd ? Number(latestTrending.price_usd) : 0,
      volume_24h: latestTrending?.volume_24h ? Number(latestTrending.volume_24h) : 0,
      asset_type: assetType,
    };

    try {
      const signal = await this.pythonApi.generateSignal(asset.asset_id, asset.asset_id, {
        strategy_data: {
          // Equal weights so every engine has a chance to contribute.
          engine_weights: { sentiment: 0.2, trend: 0.2, fundamental: 0.2, event_risk: 0.2, liquidity: 0.2 },
        },
        market_data: marketData,
        asset_symbol: canarySymbol,
        exchange: assetType === 'crypto' ? 'binance' : 'alpaca',
      });

      const engineScores = signal?.engine_scores || {};
      const engineDetails = signal?.metadata?.engine_details || {};

      const report: Record<string, EngineReport> = {};
      for (const key of this.ENGINE_KEYS) {
        const scoreNode = engineScores[key];
        const detailNode = engineDetails[key];

        const rawScore = scoreNode?.score ?? null;
        const rawConfidence = detailNode?.confidence ?? scoreNode?.confidence ?? null;
        const errorFlag = detailNode?.error === true;
        const errorMessage = detailNode?.error_message || detailNode?.metadata?.reason;

        let status: EngineStatus;
        let reason: string | undefined;

        if (errorFlag || rawScore === null) {
          status = 'failed';
          reason = errorMessage || 'engine returned null';
        } else if (Number(rawScore) === 0 && (rawConfidence === null || Number(rawConfidence) === 0)) {
          status = 'fallback';
          reason = errorMessage || 'engine returned default 0 — no input data provided';
        } else {
          status = 'ok';
        }

        report[key] = {
          status,
          score: rawScore !== null ? Number(rawScore) : null,
          confidence: rawConfidence !== null ? Number(rawConfidence) : null,
          ...(reason ? { reason } : {}),
        };
      }
      return report;
    } catch (err: any) {
      this.logger.warn(`Engine probe for ${assetType} (${canarySymbol}) failed: ${err.message}`);
      return Object.fromEntries(
        this.ENGINE_KEYS.map((k) => [
          k,
          { status: 'failed' as EngineStatus, score: null, confidence: null, reason: `python_api error: ${err.message}` },
        ]),
      );
    }
  }

  // Lightweight third-party liveness probes. Uses the same URLs and auth
  // headers the engine code uses, so a green here means the engine's data
  // source is reachable from this host.
  private async probeThirdParties(): Promise<Record<string, ThirdPartyReport>> {
    const probes: Array<{ name: string; url: string; headers?: Record<string, string>; envKey?: string }> = [
      { name: 'binance', url: 'https://api.binance.com/api/v3/ping' },
      {
        name: 'alpaca',
        url: 'https://paper-api.alpaca.markets/v2/clock',
        envKey: 'ALPACA_API_KEY',
        headers: {
          'APCA-API-KEY-ID': process.env.ALPACA_API_KEY || '',
          'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY || '',
        },
      },
      {
        name: 'coingecko',
        url: 'https://pro-api.coingecko.com/api/v3/ping',
        envKey: 'COINGECKO_API_KEY',
        headers: { 'x-cg-pro-api-key': process.env.COINGECKO_API_KEY || '' },
      },
      {
        name: 'lunarcrush',
        url: 'https://lunarcrush.com/api4/public/coins/list/v1?limit=1',
        envKey: 'LUNARCRUSH_API_KEY',
        headers: { Authorization: `Bearer ${process.env.LUNARCRUSH_API_KEY || ''}` },
      },
      {
        name: 'finnhub',
        url: `https://finnhub.io/api/v1/quote?symbol=AAPL&token=${process.env.FINNHUB_API_KEY || ''}`,
        envKey: 'FINNHUB_API_KEY',
      },
      {
        name: 'fmp',
        url: `https://financialmodelingprep.com/stable/quote?symbol=AAPL&apikey=${process.env.FMP_API_KEY || ''}`,
        envKey: 'FMP_API_KEY',
      },
      {
        name: 'openai',
        url: 'https://api.openai.com/v1/models',
        envKey: 'OPENAI_API_KEY',
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY || ''}` },
      },
      {
        name: 'python_api',
        url: `${process.env.PYTHON_API_URL || 'http://localhost:8000'}/health`,
      },
    ];

    const results: Record<string, ThirdPartyReport> = {};
    await Promise.all(
      probes.map(async (p) => {
        if (p.envKey && !process.env[p.envKey]) {
          results[p.name] = { status: 'skip', reason: `${p.envKey} not configured` };
          return;
        }
        const t0 = Date.now();
        try {
          const res = await axios.get(p.url, { headers: p.headers, timeout: 8000 });
          results[p.name] = {
            status: res.status >= 200 && res.status < 300 ? 'ok' : 'fail',
            http_code: res.status,
            latency_ms: Date.now() - t0,
          };
        } catch (err: any) {
          results[p.name] = {
            status: 'fail',
            http_code: err?.response?.status,
            latency_ms: Date.now() - t0,
            reason: err?.message,
          };
        }
      }),
    );
    return results;
  }

  // Confirms the signal-generation cron is actually writing rows. If the
  // newest signal is too old, the cron is wedged regardless of engine health.
  private async checkSignalFreshness() {
    const newest = await this.prisma.strategy_signals.findFirst({
      orderBy: { timestamp: 'desc' },
      select: { timestamp: true },
    });

    const sinceOneHour = new Date(Date.now() - 60 * 60 * 1000);
    const lastHourCount = await this.prisma.strategy_signals.count({
      where: { timestamp: { gte: sinceOneHour } },
    });

    const minutesSince = newest?.timestamp
      ? Math.floor((Date.now() - new Date(newest.timestamp).getTime()) / 60000)
      : Infinity;

    return {
      newest_signal_at: newest?.timestamp?.toISOString() ?? null,
      minutes_since_newest: Number.isFinite(minutesSince) ? minutesSince : null,
      signals_last_hour: lastHourCount,
    };
  }
}
