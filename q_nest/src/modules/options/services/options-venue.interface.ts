import {
  AvailableUnderlyingDto,
  OptionsAccountDto,
  OptionsChainResponseDto,
  OptionsPositionDto,
  GreeksDto,
} from '../dto/options.dto';

export interface OptionCredentials {
  apiKey: string;
  apiSecret: string;
}

export interface MultiLegOrderLeg {
  contractSymbol: string;
  side: 'buy' | 'sell';
  ratioQty: number;
  positionIntent: 'buy_to_open' | 'sell_to_open' | 'buy_to_close' | 'sell_to_close';
}

export interface MultiLegOrderInput {
  underlying: string;
  legs: MultiLegOrderLeg[];
  qty: number;
  type: 'market' | 'limit';
  limitPrice?: number;
  timeInForce?: 'day' | 'gtc';
}

export interface OptionsApprovalStatus {
  level: 0 | 1 | 2 | 3;
  status: 'approved' | 'pending' | 'rejected' | 'not_applied';
}

/**
 * Common surface area implemented by every venue-specific options adapter
 * (OptionsBinanceService, OptionsAlpacaService).
 *
 * OptionsService resolves the right implementation per request via
 * resolveVenueService(connectionId) and routes the call through this
 * interface so callers remain venue-agnostic.
 *
 * Not every method is meaningful on every venue — venues that cannot
 * support a capability should throw NotImplementedException so the caller
 * can surface a clean error (e.g. Binance has no Level 3 approval concept,
 * Alpaca has no per-contract IP ban handling).
 */
export interface IOptionsVenueService {
  // ── Public market data ──────────────────────────────────────
  getAvailableUnderlyings(): Promise<AvailableUnderlyingDto[]>;
  fetchOptionsChain(
    credentials: OptionCredentials | null,
    underlying: string,
    userId?: string,
  ): Promise<OptionsChainResponseDto>;
  fetchGreeks(
    credentials: OptionCredentials | null,
    contractSymbol: string,
    userId?: string,
  ): Promise<GreeksDto>;
  fetchOptionTicker(
    credentials: OptionCredentials | null,
    contractSymbol: string,
    userId?: string,
  ): Promise<any>;
  fetchOptionDepth(
    credentials: OptionCredentials | null,
    contractSymbol: string,
    limit?: number,
    userId?: string,
  ): Promise<any>;

  // ── Account / positions ─────────────────────────────────────
  fetchBalance(
    credentials: OptionCredentials,
    userId?: string,
  ): Promise<OptionsAccountDto>;
  fetchPositions(
    credentials: OptionCredentials,
    userId?: string,
  ): Promise<OptionsPositionDto[]>;

  // ── Orders ──────────────────────────────────────────────────
  placeOptionOrder(
    credentials: OptionCredentials,
    contractSymbol: string,
    side: 'buy' | 'sell',
    quantity: number,
    price: number,
    userId?: string,
  ): Promise<any>;
  placeMultiLegOrder(
    credentials: OptionCredentials,
    input: MultiLegOrderInput,
    userId?: string,
  ): Promise<any>;
  cancelOptionOrder(
    credentials: OptionCredentials,
    contractSymbol: string,
    brokerOrderId: string,
    userId?: string,
  ): Promise<any>;
  fetchOrder(
    credentials: OptionCredentials,
    contractSymbol: string,
    brokerOrderId: string,
    userId?: string,
  ): Promise<any>;
  fetchOpenOrders(
    credentials: OptionCredentials,
    contractSymbol?: string,
    userId?: string,
  ): Promise<any[]>;
  fetchOrderHistory(
    credentials: OptionCredentials,
    contractSymbol?: string,
    limit?: number,
    userId?: string,
  ): Promise<any[]>;

  // ── Venue-specific capabilities ─────────────────────────────
  /**
   * Per-account options approval status. Binance has no analog —
   * implementations should return a constant { level: 3, status: 'approved' }.
   * Alpaca reads `options_approved_level` from GET /v2/account.
   */
  getOptionsApprovalStatus(
    credentials: OptionCredentials,
    userId?: string,
  ): Promise<OptionsApprovalStatus>;

  /**
   * Contract multiplier for this venue. Binance crypto options = 0.01,
   * US equity options = 100. Used by risk aggregation and sizing math.
   */
  readonly contractMultiplier: number;
}
