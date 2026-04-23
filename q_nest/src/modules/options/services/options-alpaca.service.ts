import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import {
  AvailableUnderlyingDto,
  OptionsAccountDto,
  OptionsChainResponseDto,
  OptionContractDto,
  OptionsPositionDto,
  OptionTypeEnum,
  GreeksDto,
} from '../dto/options.dto';
import {
  IOptionsVenueService,
  OptionCredentials,
  MultiLegOrderInput,
  OptionsApprovalStatus,
} from './options-venue.interface';
import { AlpacaOptionsClient } from './alpaca/alpaca-options-client';
import { parseOccSymbol, tryParseOccSymbol } from './alpaca/occ-symbol';
import {
  ALPACA_CONTRACT_MULTIPLIER,
  ALPACA_DEFAULT_UNDERLYINGS,
} from './alpaca/alpaca-contract-specs';
import { computeGreeksFromMarket } from './alpaca/greeks-engine';
import { getDividendYield, getRiskFreeRate } from './alpaca/market-params';

/**
 * Alpaca US stock options adapter.
 *
 * Phase 2 implements read-only surface: chain, per-contract snapshot,
 * positions, account balance, options approval level.
 * Order placement + multi-leg mleg are stubbed for Phase 3.
 */
@Injectable()
export class OptionsAlpacaService implements IOptionsVenueService {
  private readonly logger = new Logger(OptionsAlpacaService.name);

  readonly contractMultiplier = ALPACA_CONTRACT_MULTIPLIER;

  /**
   * Credentials are passed per-call (not cached on the instance) so this
   * service stays stateless and safe across users.
   */
  private client(credentials: OptionCredentials | null): AlpacaOptionsClient {
    if (!credentials) {
      throw new BadRequestException(
        'Alpaca options calls require an authenticated connection (no public/anonymous data feed)',
      );
    }
    return new AlpacaOptionsClient(credentials);
  }

  // ── Public market data ────────────────────────────────────────────

  async getAvailableUnderlyings(): Promise<AvailableUnderlyingDto[]> {
    // Alpaca has no "list underlyings" endpoint; we seed a curated universe
    // and fill contract counts + spot prices opportunistically when users
    // drill into a symbol.
    return ALPACA_DEFAULT_UNDERLYINGS.map((symbol) => ({
      symbol,
      indexPrice: 0,
      contractCount: 0,
    }));
  }

  async fetchOptionsChain(
    credentials: OptionCredentials | null,
    underlying: string,
    _userId?: string,
  ): Promise<OptionsChainResponseDto> {
    const api = this.client(credentials);
    try {
      // Fetch the underlying stock price in parallel with the first options page
      // so we have the correct spot price for ITM/ATM/OTM and P&L diagrams.
      const stockPricePromise = api.getStockSnapshot(underlying).catch(() => null);

      // Paginate through all contracts — SPY/QQQ have thousands of strikes.
      // Alpaca returns next_page_token when more pages exist; null/absent = done.
      const snapshots: Record<string, any> = {};
      let pageToken: string | undefined;
      let pageCount = 0;
      const MAX_PAGES = 10; // safety cap: 10 × ~1000 contracts = 10 000 max

      do {
        const snap: any = await api.getOptionsChainSnapshot(underlying, {
          limit: 1000,
          ...(pageToken ? { page_token: pageToken } : {}),
        });
        const page: Record<string, any> = snap?.snapshots || snap || {};
        Object.assign(snapshots, page);
        pageToken = snap?.next_page_token ?? undefined;
        pageCount++;
      } while (pageToken && pageCount < MAX_PAGES);

      const contracts: OptionContractDto[] = [];
      const expirySet = new Set<string>();

      // We need the spot price first so per-contract greek computation
      // doesn't have to duplicate the parallel await below. Resolve it here
      // synchronously relative to the loop (the fetch is already in flight).
      const stockSnapForLoop: any = await stockPricePromise;
      const stockData =
        stockSnapForLoop?.[underlying.toUpperCase()] ?? stockSnapForLoop?.[underlying];
      const rawSpot =
        stockData?.latestTrade?.p ??
        stockData?.latestQuote?.ap ??
        stockData?.dailyBar?.c ??
        0;
      const spot = Number.isFinite(Number(rawSpot)) ? Number(rawSpot) : 0;

      for (const [occSymbol, data] of Object.entries(snapshots)) {
        const parsed = tryParseOccSymbol(occSymbol);
        if (!parsed) continue;
        expirySet.add(parsed.expiry);

        const lq = (data as any)?.latestQuote || {};
        const lt = (data as any)?.latestTrade || {};

        const bid = parseFloat(lq.bp ?? '0') || 0;
        const ask = parseFloat(lq.ap ?? '0') || 0;
        const mark = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
        const last = parseFloat(lt.p ?? '0') || 0;
        const referencePrice = mark > 0 ? mark : last;

        const g = this.computeGreeksLocal(parsed, spot, referencePrice);

        contracts.push({
          symbol: occSymbol,
          underlying: parsed.underlying,
          strike: parsed.strike,
          expiry: parsed.expiry,
          type: parsed.type,
          bidPrice: bid,
          askPrice: ask,
          markPrice: mark,
          lastPrice: last,
          volume: parseInt((data as any)?.dailyBar?.v ?? '0', 10) || 0,
          openInterest: 0, // not included in snapshot payload
          greeks: {
            delta: g.delta,
            gamma: g.gamma,
            theta: g.theta,
            vega: g.vega,
            impliedVolatility: g.iv > 0 ? g.iv : undefined,
          },
          contractSize: ALPACA_CONTRACT_MULTIPLIER,
        });
      }

      contracts.sort((a, b) => {
        if (a.expiry !== b.expiry) return a.expiry.localeCompare(b.expiry);
        if (a.type !== b.type) return a.type === OptionTypeEnum.CALL ? -1 : 1;
        return a.strike - b.strike;
      });

      return {
        underlying: underlying.toUpperCase(),
        underlyingPrice: spot,
        expiryDates: Array.from(expirySet).sort(),
        contracts,
        timestamp: Date.now(),
      };
    } catch (error: any) {
      this.logger.error(
        `fetchOptionsChain failed for ${underlying}: ${
          error?.response?.data?.message || error.message
        }`,
      );
      return {
        underlying: underlying.toUpperCase(),
        underlyingPrice: 0,
        expiryDates: [],
        contracts: [],
        timestamp: Date.now(),
      };
    }
  }

  /**
   * Alpaca's indicative feed doesn't return greeks — we compute them
   * ourselves via Black-Scholes-Merton with IV solved by Newton-Raphson
   * from the option's mid price. Requires a single extra stock-snapshot
   * fetch for the underlying spot. See `alpaca/greeks-engine.ts` for the
   * math and `alpaca/market-params.ts` for risk-free rate / div yields.
   */
  async fetchGreeks(
    credentials: OptionCredentials | null,
    contractSymbol: string,
    _userId?: string,
  ): Promise<GreeksDto> {
    const api = this.client(credentials);
    const parsed = tryParseOccSymbol(contractSymbol);
    if (!parsed) {
      this.logger.warn(`fetchGreeks: cannot parse OCC symbol ${contractSymbol}`);
      return { delta: 0, gamma: 0, theta: 0, vega: 0 };
    }

    try {
      // Snapshot for the contract + stock snapshot for the underlying spot, in
      // parallel — halves the latency vs sequential.
      const [snap, stockSnap] = await Promise.all([
        api.getOptionSnapshot(contractSymbol),
        api.getStockSnapshot(parsed.underlying).catch(() => null),
      ]);
      const row: any = snap?.snapshots?.[contractSymbol] || snap?.[contractSymbol] || {};
      const bid = Number(row?.latestQuote?.bp ?? 0);
      const ask = Number(row?.latestQuote?.ap ?? 0);
      const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : Number(row?.latestTrade?.p ?? 0);

      const stock: any = (stockSnap as any)?.[parsed.underlying] ?? (stockSnap as any)?.[parsed.underlying?.toUpperCase()];
      const spot = Number(
        stock?.latestTrade?.p ?? stock?.latestQuote?.ap ?? stock?.dailyBar?.c ?? 0,
      );

      const greeks = this.computeGreeksLocal(parsed, spot, mid);
      return {
        delta: greeks.delta,
        gamma: greeks.gamma,
        theta: greeks.theta,
        vega: greeks.vega,
        impliedVolatility: greeks.iv > 0 ? greeks.iv : undefined,
      };
    } catch (error: any) {
      this.logger.warn(
        `fetchGreeks failed for ${contractSymbol}: ${error?.response?.data?.message || error.message}`,
      );
      return { delta: 0, gamma: 0, theta: 0, vega: 0 };
    }
  }

  /**
   * Pure BS-greek computation given a parsed OCC symbol, the underlying
   * spot, and the option's reference price (usually the mid). Shared by
   * `fetchGreeks` and the per-contract loop in `fetchOptionsChain`.
   */
  private computeGreeksLocal(
    parsed: { underlying: string; strike: number; expiry: string; type: any },
    spot: number,
    marketPrice: number,
  ): { delta: number; gamma: number; theta: number; vega: number; iv: number } {
    if (!spot || !marketPrice || !Number.isFinite(spot) || !Number.isFinite(marketPrice)) {
      return { delta: 0, gamma: 0, theta: 0, vega: 0, iv: 0 };
    }
    // Time to expiry in years. Add a half-day buffer so 0DTE options don't
    // blow up the IV solver with tte≈0 right at the open.
    const nowMs = Date.now();
    const expiryMs = new Date(`${parsed.expiry}T20:00:00Z`).getTime(); // 4pm ET ~= 20:00 UTC
    const tteMs = Math.max(0, expiryMs - nowMs);
    const tte = tteMs / (1000 * 60 * 60 * 24 * 365);
    if (tte <= 0) return { delta: 0, gamma: 0, theta: 0, vega: 0, iv: 0 };

    return computeGreeksFromMarket({
      spot,
      strike: parsed.strike,
      rate: getRiskFreeRate(),
      dividendYield: getDividendYield(parsed.underlying),
      tte,
      type: String(parsed.type).toUpperCase() === 'CALL' ? 'CALL' : 'PUT',
      marketPrice,
    });
  }

  async fetchOptionTicker(
    credentials: OptionCredentials | null,
    contractSymbol: string,
    _userId?: string,
  ): Promise<any> {
    const api = this.client(credentials);
    try {
      const snap: any = await api.getOptionSnapshot(contractSymbol);
      const row = snap?.snapshots?.[contractSymbol] || snap?.[contractSymbol] || {};
      return {
        symbol: contractSymbol,
        lastPrice: row?.latestTrade?.p ?? 0,
        bidPrice: row?.latestQuote?.bp ?? 0,
        askPrice: row?.latestQuote?.ap ?? 0,
        volume: row?.dailyBar?.v ?? 0,
        open: row?.dailyBar?.o ?? 0,
        high: row?.dailyBar?.h ?? 0,
        low: row?.dailyBar?.l ?? 0,
        close: row?.dailyBar?.c ?? 0,
      };
    } catch (error: any) {
      this.logger.error(
        `fetchOptionTicker failed for ${contractSymbol}: ${error.message}`,
      );
      throw error;
    }
  }

  async fetchOptionDepth(
    credentials: OptionCredentials | null,
    contractSymbol: string,
    _limit?: number,
    _userId?: string,
  ): Promise<any> {
    // Alpaca does not expose an L2 book for options — only latest bid/ask.
    const api = this.client(credentials);
    try {
      const quote: any = await api.getOptionLatestQuote(contractSymbol);
      const q = quote?.quotes?.[contractSymbol] || {};
      const bp = Number(q.bp ?? 0);
      const ap = Number(q.ap ?? 0);
      const bs = Number(q.bs ?? 0);
      const as = Number(q.as ?? 0);
      return {
        bids: bp ? [[bp.toString(), bs.toString()]] : [],
        asks: ap ? [[ap.toString(), as.toString()]] : [],
      };
    } catch (error: any) {
      this.logger.warn(`fetchOptionDepth failed for ${contractSymbol}: ${error.message}`);
      return { bids: [], asks: [] };
    }
  }

  // ── Account / positions ───────────────────────────────────────────

  async fetchBalance(
    credentials: OptionCredentials,
    _userId?: string,
  ): Promise<OptionsAccountDto> {
    const api = this.client(credentials);
    try {
      const account: any = await api.getAccount();
      return {
        totalBalance: parseFloat(account?.equity ?? '0') || 0,
        availableBalance:
          parseFloat(account?.options_buying_power ?? account?.buying_power ?? '0') || 0,
        unrealizedPnl:
          parseFloat(account?.equity ?? '0') - parseFloat(account?.last_equity ?? '0') || 0,
        marginBalance: parseFloat(account?.portfolio_value ?? '0') || 0,
      };
    } catch (error: any) {
      this.logger.warn(`fetchBalance failed: ${error?.response?.data?.message || error.message}`);
      return { totalBalance: 0, availableBalance: 0, unrealizedPnl: 0, marginBalance: 0 };
    }
  }

  async fetchPositions(
    credentials: OptionCredentials,
    _userId?: string,
  ): Promise<OptionsPositionDto[]> {
    const api = this.client(credentials);
    try {
      const positions: any[] = await api.getAllPositions();
      const optionsOnly = positions.filter((p) => p?.asset_class === 'us_option');

      return optionsOnly
        .map((p) => {
          const occ = p.symbol;
          const parsed = tryParseOccSymbol(occ);
          if (!parsed) return null;
          const qty = parseFloat(p.qty ?? '0') || 0;
          return {
            positionId: '',
            contractSymbol: occ,
            underlying: parsed.underlying,
            strike: parsed.strike,
            expiry: parsed.expiry,
            optionType: parsed.type,
            quantity: qty,
            avgPremium: parseFloat(p.avg_entry_price ?? '0') || 0,
            currentPremium: parseFloat(p.current_price ?? p.market_value ?? '0') || 0,
            unrealizedPnl: parseFloat(p.unrealized_pl ?? '0') || 0,
            realizedPnl: 0,
            greeks: { delta: 0, gamma: 0, theta: 0, vega: 0 },
            isOpen: qty !== 0,
          } as OptionsPositionDto;
        })
        .filter(Boolean) as OptionsPositionDto[];
    } catch (error: any) {
      this.logger.warn(`fetchPositions failed: ${error?.response?.data?.message || error.message}`);
      return [];
    }
  }

  // ── Orders ────────────────────────────────────────────────────────

  /**
   * Place a single-leg options order via `POST /v2/orders`.
   *
   * Returns a normalized order shape whose fields parallel what the
   * Binance adapter returns (`orderId`, `status`, `executedQty`, `avgPrice`)
   * so OptionsService.placeOrder can persist results uniformly across venues.
   */
  async placeOptionOrder(
    credentials: OptionCredentials,
    contractSymbol: string,
    side: 'buy' | 'sell',
    quantity: number,
    price: number,
    _userId?: string,
  ): Promise<any> {
    const api = this.client(credentials);
    // Single-leg options orders on Alpaca require integer quantity, day TIF,
    // and a market|limit type. We always send limit since callers provide a
    // price; a true market order is rare for options and can be added later.
    const qty = Math.max(1, Math.round(quantity));
    const body: Record<string, any> = {
      symbol: contractSymbol,
      qty: String(qty),
      side,
      type: 'limit',
      time_in_force: 'day',
      limit_price: price.toFixed(2),
    };

    try {
      const order = await api.createOrder(body);
      return this.normalizeOrder(order);
    } catch (error: any) {
      this.logger.error(`placeOptionOrder (Alpaca) failed: ${error.message}`);
      throw new BadRequestException(error.message || 'Alpaca order placement failed');
    }
  }

  /**
   * Place a multi-leg (mleg) order — up to 4 legs filled atomically.
   * Input uses the venue-agnostic shape from [options-venue.interface.ts]
   * (`legs[]` with `contractSymbol`, `side`, `ratioQty`, `positionIntent`).
   */
  async placeMultiLegOrder(
    credentials: OptionCredentials,
    input: MultiLegOrderInput,
    _userId?: string,
  ): Promise<any> {
    if (!input.legs || input.legs.length < 2) {
      throw new BadRequestException('Multi-leg orders require at least 2 legs');
    }
    if (input.legs.length > 4) {
      throw new BadRequestException('Alpaca allows at most 4 legs per mleg order');
    }

    const api = this.client(credentials);
    const qty = Math.max(1, Math.round(input.qty));
    const body: Record<string, any> = {
      order_class: 'mleg',
      qty: String(qty),
      type: input.type === 'market' ? 'market' : 'limit',
      time_in_force: input.timeInForce === 'gtc' ? 'gtc' : 'day',
      legs: input.legs.map((leg) => ({
        symbol: leg.contractSymbol,
        ratio_qty: String(Math.max(1, Math.round(leg.ratioQty))),
        side: leg.side,
        position_intent: leg.positionIntent,
      })),
    };
    if (body.type === 'limit' && input.limitPrice !== undefined) {
      body.limit_price = input.limitPrice.toFixed(2);
    }

    try {
      const order = await api.createOrder(body);
      return this.normalizeOrder(order);
    } catch (error: any) {
      this.logger.error(`placeMultiLegOrder (Alpaca) failed: ${error.message}`);
      throw new BadRequestException(error.message || 'Alpaca multi-leg order failed');
    }
  }

  async cancelOptionOrder(
    credentials: OptionCredentials,
    _contractSymbol: string,
    brokerOrderId: string,
    _userId?: string,
  ): Promise<any> {
    const api = this.client(credentials);
    try {
      await api.cancelOrder(brokerOrderId);
      return { success: true };
    } catch (error: any) {
      this.logger.warn(`cancelOptionOrder (Alpaca) failed: ${error?.response?.data?.message || error.message}`);
      throw new BadRequestException(
        error?.response?.data?.message || error.message || 'Cancel failed',
      );
    }
  }

  async fetchOrder(
    credentials: OptionCredentials,
    _contractSymbol: string,
    brokerOrderId: string,
    _userId?: string,
  ): Promise<any> {
    const api = this.client(credentials);
    const order = await api.getOrder(brokerOrderId);
    return this.normalizeOrder(order);
  }

  async fetchOpenOrders(
    credentials: OptionCredentials,
    contractSymbol?: string,
    _userId?: string,
  ): Promise<any[]> {
    const api = this.client(credentials);
    const orders = await api.listOrders({
      status: 'open',
      limit: 100,
      symbols: contractSymbol,
      nested: true,
    });
    return orders.filter((o: any) => o?.asset_class === 'us_option' || this.hasOptionLeg(o))
      .map((o: any) => this.normalizeOrder(o));
  }

  async fetchOrderHistory(
    credentials: OptionCredentials,
    contractSymbol?: string,
    limit: number = 50,
    _userId?: string,
  ): Promise<any[]> {
    const api = this.client(credentials);
    const orders = await api.listOrders({
      status: 'closed',
      limit,
      symbols: contractSymbol,
      nested: true,
      direction: 'desc',
    });
    return orders.filter((o: any) => o?.asset_class === 'us_option' || this.hasOptionLeg(o))
      .map((o: any) => this.normalizeOrder(o));
  }

  private hasOptionLeg(order: any): boolean {
    const legs = order?.legs;
    return Array.isArray(legs) && legs.some((l: any) => l?.asset_class === 'us_option');
  }

  /**
   * Shape an Alpaca order response so its fields align with what Binance
   * returns. Keeps OptionsService persistence paths venue-agnostic.
   * - `orderId`       — Alpaca's UUID (lives in `broker_order_id` column)
   * - `status`        — Alpaca status string ('new'|'filled'|...), passed through
   *                     and translated by OptionsService.mapOrderStatus
   * - `executedQty`   — `filled_qty`
   * - `avgPrice`      — `filled_avg_price`
   * - `symbol`        — first leg's symbol for mleg (or top-level for single-leg)
   * - `legs`          — passed through so the persistence layer can expand mleg
   */
  private normalizeOrder(order: any): any {
    if (!order) return order;
    const firstLegSymbol = Array.isArray(order.legs) && order.legs[0]?.symbol
      ? order.legs[0].symbol
      : order.symbol;
    return {
      orderId: order.id,
      id: order.id,
      status: order.status,
      executedQty: order.filled_qty ?? '0',
      avgPrice: order.filled_avg_price ?? null,
      symbol: firstLegSymbol,
      side: order.side,
      qty: order.qty,
      type: order.type,
      order_class: order.order_class,
      legs: order.legs,
      created_at: order.created_at,
      updated_at: order.updated_at,
      _raw: order,
    };
  }

  // ── Exercise position ─────────────────────────────────────────────

  async exercisePosition(
    credentials: OptionCredentials,
    positionIdOrSymbol: string,
    _userId?: string,
  ): Promise<any> {
    const api = this.client(credentials);
    return api.exercisePosition(positionIdOrSymbol);
  }

  // ── Options approval level ────────────────────────────────────────

  async getOptionsApprovalStatus(
    credentials: OptionCredentials,
    _userId?: string,
  ): Promise<OptionsApprovalStatus> {
    const api = this.client(credentials);
    try {
      const account: any = await api.getAccount();
      const approvedLevel = Number(
        account?.options_approved_level ?? account?.options_trading_level ?? 0,
      );
      const level = (Math.max(0, Math.min(3, approvedLevel)) as 0 | 1 | 2 | 3);
      return {
        level,
        status: level > 0 ? 'approved' : 'not_applied',
      };
    } catch (error: any) {
      this.logger.warn(
        `getOptionsApprovalStatus failed: ${error?.response?.data?.message || error.message}`,
      );
      return { level: 0, status: 'not_applied' };
    }
  }
}
