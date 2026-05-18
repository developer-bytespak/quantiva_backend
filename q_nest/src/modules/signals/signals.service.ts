import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SignalAction, OrderType } from '@prisma/client';
import { PythonApiService } from '../../kyc/integrations/python-api.service';
import { BinanceService } from '../binance/binance.service';
import { ALPACA_SUPPORTED_CRYPTO } from '../exchanges/integrations/alpaca.service';
import { parsePagination, paginate, PaginatedResponse } from '../../common/utils/pagination';

@Injectable()
export class SignalsService {
  private readonly logger = new Logger(SignalsService.name);

  constructor(
    private prisma: PrismaService,
    private pythonApi: PythonApiService,
    private binanceService: BinanceService,
  ) {}

  async findAll(page?: number, limit?: number): Promise<PaginatedResponse<any>> {
    const { take, skip, page: p, limit: l } = parsePagination(page, limit);
    const where = {};
    const [data, total] = await this.prisma.$transaction([
      this.prisma.strategy_signals.findMany({
        where,
        take,
        skip,
        orderBy: { timestamp: 'desc' },
        include: {
          asset: { select: { asset_id: true, symbol: true, name: true, logo_url: true } },
          strategy: { select: { strategy_id: true, name: true } },
        },
      }),
      this.prisma.strategy_signals.count({ where }),
    ]);
    return paginate(data, total, p, l);
  }

  async findOne(id: string) {
    return this.prisma.strategy_signals.findUnique({
      where: { signal_id: id },
      include: {
        strategy: true,
        user: true,
        asset: true,
        details: true,
        explanations: true,
        orders: true,
      },
    });
  }

  async findByStrategy(strategyId: string, page?: number, limit?: number): Promise<PaginatedResponse<any>> {
    const { take, skip, page: p, limit: l } = parsePagination(page, limit);
    const where = { strategy_id: strategyId };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.strategy_signals.findMany({
        where,
        take,
        skip,
        orderBy: { timestamp: 'desc' },
        include: {
          asset: { select: { asset_id: true, symbol: true, name: true, logo_url: true } },
          strategy: { select: { strategy_id: true, name: true } },
        },
      }),
      this.prisma.strategy_signals.count({ where }),
    ]);
    return paginate(data, total, p, l);
  }

  async findByUser(userId: string, page?: number, limit?: number): Promise<PaginatedResponse<any>> {
    const { take, skip, page: p, limit: l } = parsePagination(page, limit);
    const where = { user_id: userId };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.strategy_signals.findMany({
        where,
        take,
        skip,
        orderBy: { timestamp: 'desc' },
        include: {
          asset: { select: { asset_id: true, symbol: true, name: true, logo_url: true } },
          strategy: { select: { strategy_id: true, name: true } },
        },
      }),
      this.prisma.strategy_signals.count({ where }),
    ]);
    return paginate(data, total, p, l);
  }

  /**
   * Return latest signal per asset. Keeps full history in DB; this returns a deduped
   * view by selecting the most-recent signal (timestamp desc) per asset.
   * Optionally enriches with realtime OHLCV data from Binance.
   */
  async findLatestSignals(options?: { 
    strategyId?: string; 
    userId?: string; 
    limit?: number;
    enrichWithRealtime?: boolean;
  }) {
    const where: any = {};
    if (options?.strategyId) where.strategy_id = options.strategyId;
    if (options?.userId) where.user_id = options.userId;

    // Fetch signals ordered by timestamp desc so the first occurrence per asset is the latest
    const signals = await this.prisma.strategy_signals.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      include: { asset: true, explanations: true, strategy: true, user: true, details: true },
      // Optionally cap the number of rows fetched to something reasonable
      take: options?.limit || undefined,
    });

    // Step 1: Deduplicate signals by asset (keep latest per asset, no API calls yet)
    const seen = new Map<string, any>();
    for (const s of signals) {
      const assetId = s.asset?.asset_id || s.asset_id;
      if (!assetId) continue; // skip malformed rows

      // Filter for Alpaca-supported cryptocurrencies only
      const assetSymbol = s.asset?.symbol || '';
      const baseSymbol = assetSymbol.replace(/USDT?$/, ''); // Remove USDT or USDC suffix
      if (!ALPACA_SUPPORTED_CRYPTO.includes(baseSymbol)) {
        continue; // Skip unsupported assets
      }

      if (!seen.has(assetId)) {
        // Normalize shape: ensure `explanations` array exists; fallback to legacy `explanation`
        const explanations = (s.explanations && s.explanations.length > 0)
          ? s.explanations
          : (s['explanation'] ? [{ text: s['explanation'] }] : []);

        seen.set(assetId, {
          signal_id: s.signal_id,
          strategy_id: s.strategy_id,
          asset: s.asset || null,
          timestamp: s.timestamp,
          action: s.action,
          confidence: s.confidence ?? null,
          final_score: s.final_score ?? null,
          explanations,
          details: s.details?.[0] || null,
          realtime_data: null,
        });
      }
    }

    // Step 2: Enrich all unique assets with realtime Binance data in parallel
    if (options?.enrichWithRealtime) {
      const entries = [...seen.entries()].filter(([, s]) => s.asset?.symbol);
      const results = await Promise.allSettled(
        entries.map(([assetId, s]) =>
          this.binanceService.getEnrichedMarketData(s.asset.symbol)
            .then(data => ({ assetId, data }))
        )
      );

      let enrichedCount = 0;
      for (const r of results) {
        if (r.status === 'fulfilled') {
          const signal = seen.get(r.value.assetId);
          if (signal) {
            signal.realtime_data = r.value.data;
            enrichedCount++;
          }
        }
      }
      this.logger.log(`Enriched ${enrichedCount}/${entries.length} signals with realtime data (parallel)`);
    }

    return Array.from(seen.values()).sort((a, b) => {
      const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return tb - ta;
    });
  }

  async create(data: {
    strategy_id?: string;
    user_id?: string;
    asset_id?: string;
    timestamp?: Date;
    final_score?: number;
    action: SignalAction;
    confidence?: number;
    sentiment_score?: number;
    trend_score?: number;
    fundamental_score?: number;
    liquidity_score?: number;
    event_risk_score?: number;
  }) {
    // BUY-only persistence: HOLD/SELL are evaluated but not written.
    // Engine liveness is still observable via cron heartbeat logs.
    if (data.action !== SignalAction.BUY) {
      return null;
    }

    // Prevent duplicate signals for same strategy + asset within short execution window
    try {
      if (data.strategy_id && data.asset_id) {
        const recent = await this.prisma.strategy_signals.findFirst({
          where: {
            strategy_id: data.strategy_id,
            asset_id: data.asset_id,
          },
          orderBy: { timestamp: 'desc' },
        });

        if (recent) {
          const recentTs = recent.timestamp ? new Date(recent.timestamp).getTime() : 0;
          const nowTs = (data.timestamp ? new Date(data.timestamp).getTime() : Date.now());
          const windowMs = 10 * 60 * 1000; // 10 minutes — matches cron interval
          if (nowTs - recentTs < windowMs) {
            // Return existing recent signal to avoid duplicate insert
            return recent;
          }
        }
      }
    } catch (err: any) {
      // If the duplicate-check fails for any reason, fall back to creating the record
      this.logger.warn(`Duplicate check failed: ${err?.message || err}`);
    }

    return this.prisma.strategy_signals.create({
      data: {
        strategy_id: data.strategy_id,
        user_id: data.user_id,
        asset_id: data.asset_id,
        timestamp: data.timestamp,
        final_score: data.final_score,
        action: data.action,
        confidence: data.confidence,
        sentiment_score: data.sentiment_score,
        trend_score: data.trend_score,
        fundamental_score: data.fundamental_score,
        liquidity_score: data.liquidity_score,
        event_risk_score: data.event_risk_score,
      },
      include: {
        strategy: true,
        user: true,
        asset: true,
      },
    });
  }

  async update(id: string, data: {
    final_score?: number;
    action?: SignalAction;
    confidence?: number;
    sentiment_score?: number;
    trend_score?: number;
    fundamental_score?: number;
    liquidity_score?: number;
    event_risk_score?: number;
  }) {
    return this.prisma.strategy_signals.update({
      where: { signal_id: id },
      data,
    });
  }

  async delete(id: string) {
    return this.prisma.strategy_signals.delete({
      where: { signal_id: id },
    });
  }

  async createDetail(signalId: string, data: {
    entry_price?: number;
    position_size?: number;
    position_value?: number;
    stop_loss?: number;
    take_profit_1?: number;
    take_profit_2?: number;
    leverage?: number;
    order_type?: OrderType;
    time_in_force?: string;
    metadata?: any;
  }) {
    return this.prisma.signal_details.create({
      data: {
        signal_id: signalId,
        entry_price: data.entry_price,
        position_size: data.position_size,
        position_value: data.position_value,
        stop_loss: data.stop_loss,
        take_profit_1: data.take_profit_1,
        take_profit_2: data.take_profit_2,
        leverage: data.leverage,
        order_type: data.order_type,
        time_in_force: data.time_in_force,
        metadata: data.metadata,
      },
    });
  }

  async createExplanation(
    signalId: string,
    data: {
      llm_model?: string;
      text?: string;
      explanation_status?: string | null;
      error_message?: string | null;
      retry_count?: number;
    },
  ) {
      // Ensure only one explanation per signal. If exists, return it.
      try {
        const existing = await this.prisma.signal_explanations.findFirst({
          where: { signal_id: signalId },
          orderBy: { created_at: 'desc' },
        });
        if (existing) return existing;
      } catch (err: any) {
        this.logger.warn(`Explanation lookup failed: ${err?.message || err}`);
      }

      return this.prisma.signal_explanations.create({
        data: {
          signal_id: signalId,
          llm_model: data.llm_model,
          text: data.text,
          explanation_status: data.explanation_status || 'generated',
          error_message: data.error_message || null,
          retry_count: data.retry_count || 0,
        },
      });
  }

    async getExplanationBySignalId(signalId: string) {
      return this.prisma.signal_explanations.findFirst({
        where: { signal_id: signalId },
        orderBy: { created_at: 'desc' },
      });
    }

    async findExplanationByStrategyAndAsset(strategyId: string, assetId: string) {
      return this.prisma.signal_explanations.findFirst({
        where: {
          signal: {
            strategy_id: strategyId,
            asset_id: assetId,
          },
        },
        include: { signal: true },
        orderBy: { created_at: 'desc' },
      });
    }

  async generateSignalFromPython(
    strategyId: string,
    assetId: string,
    strategyData: any,
    marketData: any,
    ohlcvData?: any,
    orderBook?: any,
    portfolioValue?: number,
  ) {
    try {
      // Call Python API to generate signal
      const pythonSignal = await this.pythonApi.generateSignal(strategyId, assetId, {
        strategy_data: strategyData,
        market_data: marketData,
        ohlcv_data: ohlcvData,
        order_book: orderBook,
        portfolio_value: portfolioValue,
      });

      // Store signal in database (returns null for HOLD/SELL — only BUYs persist)
      // Score fields use ?? null so engines that returned null (failed or no
      // data) survive into the DB instead of being coerced to a misleading 0.
      const signal = await this.create({
        strategy_id: strategyId,
        user_id: strategyData.user_id,
        asset_id: assetId,
        timestamp: new Date(),
        final_score: pythonSignal.final_score,
        action: pythonSignal.action as SignalAction,
        confidence: pythonSignal.confidence,
        sentiment_score: pythonSignal.engine_scores?.sentiment?.score ?? pythonSignal.engine_scores?.sentiment ?? null,
        trend_score: pythonSignal.engine_scores?.trend?.score ?? pythonSignal.engine_scores?.trend ?? null,
        fundamental_score: pythonSignal.engine_scores?.fundamental?.score ?? pythonSignal.engine_scores?.fundamental ?? null,
        liquidity_score: pythonSignal.engine_scores?.liquidity?.score ?? pythonSignal.engine_scores?.liquidity ?? null,
        event_risk_score: pythonSignal.engine_scores?.event_risk?.score ?? pythonSignal.engine_scores?.event_risk ?? null,
      });

      if (!signal) {
        // Action was HOLD/SELL and the BUY-only filter skipped persistence.
        return null;
      }

      // Store signal details if position sizing is available
      if (pythonSignal.position_sizing) {
        await this.createDetail(signal.signal_id, {
          entry_price: marketData.price,
          position_size: pythonSignal.position_sizing.position_size,
          position_value: pythonSignal.position_sizing.position_size * marketData.price,
          stop_loss: strategyData.stop_loss_value
            ? marketData.price * (1 - strategyData.stop_loss_value / 100)
            : undefined,
          take_profit_1: strategyData.take_profit_value
            ? marketData.price * (1 + strategyData.take_profit_value / 100)
            : undefined,
          metadata: pythonSignal.metadata,
        });
      }

      return signal;
    } catch (error: any) {
      this.logger.error(`Error generating signal: ${error.message}`);
      throw error;
    }
  }
}

