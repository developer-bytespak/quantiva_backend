import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';
import { PythonApiService } from '../../../kyc/integrations/python-api.service';
import { PreBuiltStrategiesService } from './pre-built-strategies.service';
import { StrategyExecutionService } from './strategy-execution.service';
import { ExchangesService } from '../../exchanges/exchanges.service';
import { ConnectionStatus, StrategyType } from '@prisma/client';

// Keep in sync with the default profile in q_python fusion_engine.py.
const DEFAULT_ENGINE_WEIGHTS = {
  sentiment: 0.35,
  trend: 0.25,
  fundamental: 0.15,
  event_risk: 0.15,
  liquidity: 0.1,
} as const;

const VALID_TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;

// Shared 10-minute window used both by the dedup check on writes and by
// the custom-strategy skip-if-recent guard. One constant; two call sites.
const SIGNAL_DEDUP_WINDOW_MS = 10 * 60 * 1000;

@Injectable()
export class PreBuiltSignalsCronjobService {
  private readonly logger = new Logger(PreBuiltSignalsCronjobService.name);
  private readonly BATCH_SIZE = 10; // Process 10 assets at a time
  private readonly LLM_LIMIT = 10; // Generate LLM for top 10 signals per strategy
  private isRunning = false; // Prevent concurrent executions

  constructor(
    private prisma: PrismaService,
    private pythonApi: PythonApiService,
    private preBuiltStrategiesService: PreBuiltStrategiesService,
    private strategyExecutionService: StrategyExecutionService,
    @Inject(forwardRef(() => ExchangesService))
    private exchangesService: ExchangesService,
    private config: ConfigService,
  ) {}

  /**
   * When the `ENABLE_CRONS` env var is explicitly set to `"false"`, all
   * crons defined in this service skip execution. Used to prevent duplicate
   * cron firing when the same NestJS process is deployed to multiple hosts
   * (e.g., Render + a secondary AWS). Mirrors the pattern used in
   * news-cronjob.service.ts and coin-details-sync.cron.ts.
   */
  private get cronsEnabled(): boolean {
    return this.config.get('ENABLE_CRONS') !== 'false';
  }

  /**
   * Phase 5 — Build strategy_data for a Python `/signals/generate` call
   * with validation + type coercion.
   *
   * Why this exists: Prisma returns `Decimal` objects and nullable JSON
   * columns. Sending them raw to Python can produce `NaN` / parse errors
   * on the Python side. This helper:
   *   - Validates `timeframe` against the known enum and falls back to `1d`.
   *   - Coerces `stop_loss_value` / `take_profit_value` to numbers.
   *   - Warns (doesn't crash) when `engine_weights` sum drifts from 1.0 —
   *     Python normalizes internally but we want the drift visible in logs.
   */
  private buildStrategyData(strategy: {
    user_id: string | null;
    strategy_id: string;
    entry_rules: unknown;
    exit_rules: unknown;
    indicators: unknown;
    timeframe: string | null;
    engine_weights: unknown;
    stop_loss_value: unknown;
    take_profit_value: unknown;
  }): Record<string, any> {
    const toNumber = (v: unknown, fallback: number): number => {
      if (v === null || v === undefined) return fallback;
      const n = Number(v as any);
      return Number.isFinite(n) ? n : fallback;
    };

    const tf = strategy.timeframe as (typeof VALID_TIMEFRAMES)[number] | null;
    const timeframe = tf && VALID_TIMEFRAMES.includes(tf) ? tf : '1d';
    if (tf && !VALID_TIMEFRAMES.includes(tf)) {
      this.logger.warn(
        `Strategy ${strategy.strategy_id}: invalid timeframe "${tf}" — falling back to "1d"`,
      );
    }

    const rawWeights = strategy.engine_weights as Record<string, unknown> | null;
    if (rawWeights) {
      const sum = Object.values(rawWeights).reduce<number>(
        (s, v) => s + toNumber(v, 0),
        0,
      );
      if (Math.abs(sum - 1.0) > 0.05) {
        this.logger.warn(
          `Strategy ${strategy.strategy_id}: engine_weights sum to ${sum.toFixed(3)} (not 1.0) — Python will normalize`,
        );
      }
    }

    return {
      user_id: strategy.user_id ?? null,
      entry_rules: (strategy.entry_rules as any[]) || [],
      exit_rules: (strategy.exit_rules as any[]) || [],
      indicators: (strategy.indicators as any[]) || [],
      timeframe,
      engine_weights: rawWeights || { ...DEFAULT_ENGINE_WEIGHTS },
      stop_loss_value: toNumber(strategy.stop_loss_value, 0),
      take_profit_value: toNumber(strategy.take_profit_value, 0),
    };
  }

  /**
   * Phase 2b — Returns true when a signal for this (strategy, asset) was
   * already written within the last SIGNAL_DEDUP_WINDOW_MS. Used to stop
   * a second cron run (e.g., manual trigger after scheduled tick) from
   * producing duplicate rows.
   */
  private async hasRecentSignal(
    strategyId: string,
    assetId: string,
    userId: string | null,
  ): Promise<boolean> {
    const since = new Date(Date.now() - SIGNAL_DEDUP_WINDOW_MS);
    const recent = await this.prisma.strategy_signals.findFirst({
      where: {
        strategy_id: strategyId,
        asset_id: assetId,
        user_id: userId,
        timestamp: { gte: since },
      },
      select: { signal_id: true },
    });
    return recent !== null;
  }

  /**
   * Scheduled job that runs every 10 minutes
   * Fetches trending assets, runs sentiment analysis, and generates signals for all 4 pre-built strategies
   */
  @Cron('*/10 * * * *') // Every 10 minutes
  async generatePreBuiltSignals(options?: { connectionId?: string }): Promise<void> {
    if (!this.cronsEnabled) {
      return;
    }
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;

    try {
      const strategies = await this.preBuiltStrategiesService.getPreBuiltStrategies();
      if (strategies.length === 0) {
        return;
      }

      // Pass false for enrichWithRealtime — the cron only needs asset IDs to process,
      // not live Binance stats, which would fire 50 × weight-2 calls every 10 minutes.
      const trendingAssets = await this.preBuiltStrategiesService.getTopTrendingAssets(50, false);
      if (trendingAssets.length === 0) {
        return;
      }

      // Step 3: For pre-built (system) signals, never pass user connection_id so Python
      // uses the system candles endpoint (Binance/Alpaca from env) for OHLCV and trend score.
      const connectionInfo = { connectionId: null as string | null, exchange: 'binance' as string };

      // Step 4: Process each asset through sentiment analysis and signal generation
      let processedCount = 0;
      let errorCount = 0;

      // Process assets in batches
      for (let i = 0; i < trendingAssets.length; i += this.BATCH_SIZE) {
        const batch = trendingAssets.slice(i, i + this.BATCH_SIZE);

        await Promise.allSettled(
          batch.map(async (asset) => {
            try {
              await this.processAsset(asset, strategies, connectionInfo);
              processedCount++;
            } catch (error: any) {
              errorCount++;
            }
          }),
        );

        // Small delay between batches to avoid overwhelming APIs
        if (i + this.BATCH_SIZE < trendingAssets.length) {
          await this.sleep(500);
        }
      }

      // Step 5: Generate LLM explanations for top N signals per strategy
      await this.generateLLMExplanationsForTopSignals(strategies);

      await this.processActiveCustomStrategies(trendingAssets, connectionInfo);
    } catch (error: any) {
      this.logger.error(`Fatal error in pre-built signals generation: ${error.message}`, error.stack);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Process a single asset: run sentiment analysis and generate signals for all strategies
   */
  private async processAsset(
    asset: any,
    strategies: any[],
    connectionInfo: { connectionId: string | null; exchange: string } | null,
  ): Promise<void> {
    try {
      // Step 1: Run sentiment analysis (this also fetches news)
      await this.runSentimentAnalysis(asset);

      // Step 2: Generate signals for each pre-built strategy
      for (const strategy of strategies) {
        try {
          // Use executeStrategy but with system-level execution (no user_id)
          // We'll need to modify executeStrategy to accept connection info directly
          await this.executeStrategyForAsset(
            strategy.strategy_id,
            asset.asset_id,
            connectionInfo,
          );
        } catch (error: any) {
          // Continue with other strategies
        }
      }
    } catch (error: any) {
      throw error;
    }
  }

  /**
   * Run sentiment analysis for an asset
   */
  private async runSentimentAnalysis(asset: any): Promise<void> {
    try {
      if (!asset.symbol || !asset.asset_type) {
        return;
      }
      await this.pythonApi.post('/api/v1/sentiment/analyze', {
        asset_id: asset.symbol,
        asset_type: asset.asset_type,
      });
    } catch (error: any) {
      // Don't throw - continue with signal generation even if sentiment fails
    }
  }

  /**
   * Execute strategy on an asset (system-level, no user_id)
   */
  private async executeStrategyForAsset(
    strategyId: string,
    assetId: string,
    connectionInfo: { connectionId: string | null; exchange: string } | null,
  ): Promise<void> {
    // Get strategy
    const strategy = await this.prisma.strategies.findUnique({
      where: { strategy_id: strategyId },
    });

    if (!strategy) {
      throw new Error(`Strategy ${strategyId} not found`);
    }

    // Get asset
    const asset = await this.prisma.assets.findUnique({
      where: { asset_id: assetId },
    });

    if (!asset) {
      throw new Error(`Asset ${assetId} not found`);
    }

    // Get market data
    const marketData = await this.getMarketData(assetId, asset.asset_type);

    // Use provided connection info or default
    const connectionId = connectionInfo?.connectionId || null;
    const exchange = connectionInfo?.exchange || 'binance';

    // Prepare strategy data (Phase 5 — validated + coerced)
    const strategyData = this.buildStrategyData({
      ...strategy,
      user_id: null, // System-level execution (overrides strategy.user_id)
    });

    // Phase 2b — app-level dedup: skip if we already wrote a signal for
    // this (strategy, asset) in the last 10 minutes. Prevents duplicates
    // when scheduled + manual triggers race, or when two instances each
    // run the cron (before ENABLE_CRONS is properly set).
    if (await this.hasRecentSignal(strategyId, assetId, null)) {
      return;
    }

    try {
      // Call Python API to generate signal
      const assetSymbol = asset.symbol || assetId;
      const pythonSignal = await this.pythonApi.generateSignal(strategyId, assetId, {
        strategy_data: strategyData,
        market_data: marketData,
        connection_id: connectionId,
        exchange: exchange,
        asset_symbol: assetSymbol,
      });

      // Store signal in database (without LLM for now - we'll generate LLM in batch later)
      const signal = await this.prisma.strategy_signals.create({
        data: {
          strategy_id: strategyId,
          user_id: null, // System-generated signal
          asset_id: assetId,
          timestamp: new Date(),
          final_score: pythonSignal.final_score,
          action: pythonSignal.action,
          confidence: pythonSignal.confidence,
          sentiment_score: pythonSignal.engine_scores?.sentiment?.score || 0,
          trend_score: pythonSignal.engine_scores?.trend?.score || 0,
          fundamental_score: pythonSignal.engine_scores?.fundamental?.score || 0,
          liquidity_score: pythonSignal.engine_scores?.liquidity?.score || 0,
          event_risk_score: pythonSignal.engine_scores?.event_risk?.score || 0,
          engine_metadata: pythonSignal.engine_scores || {},
        },
      });

      // Store signal details if position sizing is available
      if (pythonSignal.position_sizing) {
        const stopLossValue = strategy.stop_loss_value ? Number(strategy.stop_loss_value) : null;
        const takeProfitValue = strategy.take_profit_value ? Number(strategy.take_profit_value) : null;

        await this.prisma.signal_details.create({
          data: {
            signal_id: signal.signal_id,
            entry_price: marketData.price,
            position_size: pythonSignal.position_sizing.position_size,
            position_value: pythonSignal.position_sizing.position_size * marketData.price,
            stop_loss: stopLossValue ? marketData.price * (1 - stopLossValue / 100) : null,
            take_profit_1: takeProfitValue ? marketData.price * (1 + takeProfitValue / 100) : null,
            metadata: pythonSignal.metadata || {},
          },
        });
      }
    } catch (error: any) {
      throw error;
    }
  }

  /**
   * Generate LLM explanations for top N signals per strategy
   */
  private async generateLLMExplanationsForTopSignals(strategies: any[]): Promise<void> {
    for (const strategy of strategies) {
      try {
        // Get all signals for this strategy (without explanations)
        const signals = await this.prisma.strategy_signals.findMany({
          where: {
            strategy_id: strategy.strategy_id,
            user_id: null, // Only system-generated signals
            explanations: {
              none: {}, // Signals without explanations
            },
          },
          include: {
            asset: true,
          },
          orderBy: {
            timestamp: 'desc',
          },
          take: 100, // Fetch enough to find top N
        });

        if (signals.length === 0) {
          continue;
        }

        // Sort signals by priority: action (BUY > SELL > HOLD), then final_score, then confidence
        const signalsWithScores = signals
          .filter((s) => s.action)
          .map((s) => {
            const actionPriority = s.action === 'BUY' ? 3 : s.action === 'SELL' ? 2 : 1;
            const finalScore = Number(s.final_score || 0);
            const confidence = Number(s.confidence || 0);
            const sortScore = actionPriority * 1000 + finalScore * 0.7 + confidence * 0.3;
            return { ...s, sortScore };
          })
          .sort((a, b) => (b.sortScore || 0) - (a.sortScore || 0))
          .slice(0, this.LLM_LIMIT);

        // Generate LLM explanations
        for (const signal of signalsWithScores) {
          try {
            const asset = signal.asset;
            if (!asset) {
              continue;
            }

            const assetSymbol = asset.symbol || signal.asset_id;

            // Construct engine_scores from signal fields
            const engineScores = {
              sentiment: { score: Number(signal.sentiment_score || 0) },
              trend: { score: Number(signal.trend_score || 0) },
              fundamental: { score: Number(signal.fundamental_score || 0) },
              liquidity: { score: Number(signal.liquidity_score || 0) },
              event_risk: { score: Number(signal.event_risk_score || 0) },
            };

            const finalScore = Number(signal.final_score || 0);
            const confidence = Number(signal.confidence || 0);

            if (signal.action) {
              const llmResponse = await this.pythonApi.post('/api/v1/llm/explain-signal', {
                signal_data: {
                  action: signal.action,
                  final_score: finalScore,
                  confidence: confidence,
                },
                engine_scores: engineScores,
                asset_id: assetSymbol,
                asset_type: asset.asset_type || 'crypto',
              });

              // Store explanation
              await this.prisma.signal_explanations.create({
                data: {
                  signal_id: signal.signal_id,
                  llm_model: llmResponse.data.model,
                  text: llmResponse.data.explanation,
                  explanation_status: 'generated',
                  error_message: null,
                  retry_count: 0,
                },
              });
            }
          } catch (error: any) {
            try {
              await this.prisma.signal_explanations.create({
                data: {
                  signal_id: signal.signal_id,
                  explanation_status: 'failed',
                  error_message: error.message,
                  text: 'Unable to generate explanation.',
                  retry_count: 0,
                },
              });
            } catch (dbError: any) {
              // Ignore
            }
          }
        }
      } catch (error: any) {
        // Ignore per-strategy LLM errors
      }
    }
  }

  /**
   * Get first available connection from database for OHLCV data
   */
  private async getFirstAvailableConnection(): Promise<{
    connectionId: string | null;
    exchange: string;
  } | null> {
    try {
      const connection = await this.prisma.user_exchange_connections.findFirst({
        where: {
          status: ConnectionStatus.active,
        },
        include: {
          exchange: true,
        },
        orderBy: {
          created_at: 'desc',
        },
      });

      if (connection && connection.exchange) {
        return {
          connectionId: connection.connection_id,
          exchange: connection.exchange.name.toLowerCase() || 'binance',
        };
      }

      return null;
    } catch (error: any) {
      return null;
    }
  }

  /**
   * Get market data for asset
   */
  private async getMarketData(assetId: string, assetType: string | null): Promise<any> {
    const trendingAsset = await this.prisma.trending_assets.findFirst({
      where: { asset_id: assetId },
      orderBy: { poll_timestamp: 'desc' },
    });

    return {
      price: trendingAsset ? Number(trendingAsset.price_usd || 0) : 0,
      volume_24h: trendingAsset ? Number(trendingAsset.market_volume || 0) : 0,
      asset_type: assetType || 'crypto',
    };
  }

  /**
   * Process all active custom CRYPTO (user) strategies.
   * Stock custom strategies are handled by StockSignalsCronjobService.
   *
   * Phase 4 refactor: the old version fired ~3 DB queries per (strategy ×
   * target_symbol) — a custom strategy with 100 targets meant ~300 round
   * trips plus 100 sentiment API calls, multiplied across every custom
   * strategy. This version pre-computes the union of all target symbols
   * across all strategies, batches the asset lookup/creation, pre-fetches
   * market data once, and pools sentiment calls per unique symbol.
   * Typical new cost: 3 bulk queries total + one sentiment call per
   * unique new symbol, regardless of how many strategies reference it.
   */
  private async processActiveCustomStrategies(
    trendingAssets: any[],
    connectionInfo: { connectionId: string | null; exchange: string } | null,
  ): Promise<void> {
    try {
      const customStrategies = await this.prisma.strategies.findMany({
        where: {
          type: StrategyType.user,
          is_active: true,
          user_id: { not: null },
          asset_type: 'crypto',
        },
        include: {
          user: {
            select: { user_id: true, email: true },
          },
        },
      });

      if (customStrategies.length === 0) {
        return;
      }

      // ----- Phase 4.1: compute the union of all symbols to process -----
      const trendingAssetsMap = new Map<string, any>();
      for (const asset of trendingAssets) {
        trendingAssetsMap.set(asset.symbol, asset);
      }

      // Per-strategy resolution of `assetsToProcess`, in one pass.
      const trendingSymbols = trendingAssets.map((a) => a.symbol);
      const perStrategySymbols = new Map<string, string[]>();
      const allSymbolsSet = new Set<string>();
      for (const strategy of customStrategies) {
        const targets = (strategy.target_assets as string[]) || [];
        const list = targets.length > 0 ? targets : trendingSymbols;
        perStrategySymbols.set(strategy.strategy_id, list);
        for (const s of list) allSymbolsSet.add(s);
      }
      const allSymbols = Array.from(allSymbolsSet);

      // ----- Phase 4.2: bulk resolve (find existing + create missing) -----
      const assetMap = new Map<string, any>();
      for (const a of trendingAssets) {
        if (a.symbol) assetMap.set(a.symbol, a);
      }

      const symbolsNotInTrending = allSymbols.filter((s) => !assetMap.has(s));

      if (symbolsNotInTrending.length > 0) {
        const existing = await this.prisma.assets.findMany({
          where: {
            symbol: { in: symbolsNotInTrending },
            asset_type: 'crypto',
          },
        });
        for (const a of existing) {
          if (a.symbol) assetMap.set(a.symbol, a);
        }

        const stillMissing = symbolsNotInTrending.filter((s) => !assetMap.has(s));
        if (stillMissing.length > 0) {
          await this.prisma.assets.createMany({
            data: stillMissing.map((symbol) => ({
              symbol,
              name: symbol,
              display_name: symbol,
              asset_type: 'crypto',
              is_active: true,
              first_seen_at: new Date(),
              last_seen_at: new Date(),
            })),
            skipDuplicates: true,
          });
          // createMany doesn't return rows — re-fetch the ones we just created.
          const created = await this.prisma.assets.findMany({
            where: { symbol: { in: stillMissing }, asset_type: 'crypto' },
          });
          for (const a of created) {
            if (a.symbol) assetMap.set(a.symbol, a);
          }
        }
      }

      // ----- Phase 4.3: pool sentiment analysis (once per unique new asset) -----
      // Only symbols NOT in trending need fresh sentiment — trending ones
      // were already hit by the pre-built loop earlier in this cron run.
      const freshSentimentTargets = symbolsNotInTrending
        .map((s) => assetMap.get(s))
        .filter((a) => a && a.asset_id);
      for (const asset of freshSentimentTargets) {
        try {
          await this.runSentimentAnalysis(asset);
        } catch {
          // Non-fatal; strategy exec still proceeds using whatever sentiment is cached.
        }
      }

      // ----- Phase 4.4: pre-fetch latest trending_assets market data in one query -----
      const assetIds = Array.from(assetMap.values())
        .map((a) => a.asset_id)
        .filter(Boolean);
      const marketDataMap = new Map<string, { price: number; volume_24h: number; asset_type: string }>();
      if (assetIds.length > 0) {
        const latest = await this.prisma.trending_assets.findMany({
          where: { asset_id: { in: assetIds } },
          orderBy: { poll_timestamp: 'desc' },
        });
        // Keep only the first (most recent) entry per asset_id.
        for (const row of latest) {
          if (!marketDataMap.has(row.asset_id)) {
            marketDataMap.set(row.asset_id, {
              price: Number(row.price_usd || 0),
              volume_24h: Number(row.market_volume || 0),
              asset_type: 'crypto',
            });
          }
        }
      }

      // ----- Phase 4.5: per-strategy execution (no more inner DB round-trips) -----
      let customSignalsGenerated = 0;
      let customErrors = 0;

      for (const strategy of customStrategies) {
        try {
          const symbols = perStrategySymbols.get(strategy.strategy_id) || [];
          const userConnectionInfo = await this.getUserConnection(
            strategy.user_id!,
            strategy.asset_type || 'crypto',
          );

          for (const symbol of symbols) {
            try {
              const asset = assetMap.get(symbol);
              if (!asset) continue; // Couldn't resolve; should be rare

              const marketData = marketDataMap.get(asset.asset_id) || {
                price: 0,
                volume_24h: 0,
                asset_type: 'crypto',
              };

              await this.executeCustomStrategyForAsset(
                strategy,
                asset,
                userConnectionInfo || connectionInfo,
                marketData, // pre-fetched; skip the getMarketData round-trip inside
              );
              customSignalsGenerated++;
            } catch {
              customErrors++;
            }
          }
        } catch {
          // Continue with next strategy
        }
      }

      if (customSignalsGenerated > 0 || customErrors > 0) {
        this.logger.log(
          `[processActiveCustomStrategies] signals=${customSignalsGenerated} errors=${customErrors} strategies=${customStrategies.length} symbols=${allSymbols.length}`,
        );
      }
    } catch (error: any) {
      this.logger.error(
        `[processActiveCustomStrategies] fatal: ${error?.message || error}`,
      );
    }
  }

  /**
   * Execute a custom strategy for a single asset.
   *
   * @param preFetchedMarketData Optional pre-resolved market data. When
   *   supplied (by the batched custom-strategy loop in
   *   processActiveCustomStrategies), skips the per-asset
   *   `trending_assets` round trip. Falls back to `getMarketData` when
   *   called from paths that don't have it pre-resolved.
   */
  private async executeCustomStrategyForAsset(
    strategy: any,
    asset: any,
    connectionInfo: { connectionId: string | null; exchange: string } | null,
    preFetchedMarketData?: { price: number; volume_24h: number; asset_type: string },
  ): Promise<void> {
    const marketData =
      preFetchedMarketData ??
      (await this.getMarketData(asset.asset_id, asset.asset_type));

    const connectionId = connectionInfo?.connectionId || null;
    const exchange = connectionInfo?.exchange || 'binance';

    const strategyData = this.buildStrategyData(strategy);

    try {
      // Phase 2b — same app-level dedup helper as the pre-built branch.
      if (
        await this.hasRecentSignal(
          strategy.strategy_id,
          asset.asset_id,
          strategy.user_id ?? null,
        )
      ) {
        return;
      }

      // Call Python API to generate signal
      const assetSymbol = asset.symbol || asset.asset_id;
      const pythonSignal = await this.pythonApi.generateSignal(strategy.strategy_id, asset.asset_id, {
        strategy_data: strategyData,
        market_data: marketData,
        connection_id: connectionId,
        exchange: exchange,
        asset_symbol: assetSymbol,
      });

      // Store signal in database with user_id
      const signal = await this.prisma.strategy_signals.create({
        data: {
          strategy_id: strategy.strategy_id,
          user_id: strategy.user_id, // Associate with user
          asset_id: asset.asset_id,
          timestamp: new Date(),
          final_score: pythonSignal.final_score,
          action: pythonSignal.action,
          confidence: pythonSignal.confidence,
          sentiment_score: pythonSignal.engine_scores?.sentiment?.score || 0,
          trend_score: pythonSignal.engine_scores?.trend?.score || 0,
          fundamental_score: pythonSignal.engine_scores?.fundamental?.score || 0,
          liquidity_score: pythonSignal.engine_scores?.liquidity?.score || 0,
          event_risk_score: pythonSignal.engine_scores?.event_risk?.score || 0,
          engine_metadata: pythonSignal.engine_scores || {},
        },
      });

      // Store signal details if position sizing is available
      if (pythonSignal.position_sizing) {
        const stopLossValue = strategy.stop_loss_value ? Number(strategy.stop_loss_value) : null;
        const takeProfitValue = strategy.take_profit_value ? Number(strategy.take_profit_value) : null;

        await this.prisma.signal_details.create({
          data: {
            signal_id: signal.signal_id,
            entry_price: marketData.price,
            position_size: pythonSignal.position_sizing.position_size,
            position_value: pythonSignal.position_sizing.position_size * marketData.price,
            stop_loss: stopLossValue ? marketData.price * (1 - stopLossValue / 100) : null,
            take_profit_1: takeProfitValue ? marketData.price * (1 + takeProfitValue / 100) : null,
            metadata: pythonSignal.metadata || {},
          },
        });
      }
    } catch (error: any) {
      throw error;
    }
  }

  /**
   * Get user-specific exchange connection
   */
  private async getUserConnection(
    userId: string,
    assetType: string,
  ): Promise<{ connectionId: string | null; exchange: string } | null> {
    try {
      const exchangeName = assetType === 'stock' ? 'alpaca' : 'binance';
      
      const connection = await this.prisma.user_exchange_connections.findFirst({
        where: {
          user_id: userId,
          status: ConnectionStatus.active,
          exchange: {
            name: { contains: exchangeName, mode: 'insensitive' },
          },
        },
        include: { exchange: true },
      });

      if (connection) {
        return {
          connectionId: connection.connection_id,
          exchange: connection.exchange?.name?.toLowerCase() || exchangeName,
        };
      }

      return null;
    } catch (error: any) {
      return null;
    }
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Manual trigger for testing/debugging
   */
  async triggerManualGeneration(options?: { connectionId?: string }): Promise<{
    message: string;
    processed: number;
    errors: number;
  }> {
    await this.generatePreBuiltSignals(options);
    return {
      message: 'Manual generation completed',
      processed: 0, // Would need to track this in the method
      errors: 0,
    };
  }
}
