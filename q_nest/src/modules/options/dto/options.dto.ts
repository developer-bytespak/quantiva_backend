import {
  IsString,
  IsNumber,
  IsEnum,
  IsOptional,
  IsDateString,
  IsNotEmpty,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  ValidateNested,
  Min,
  Max,
  Matches,
} from 'class-validator';
import { Type } from 'class-transformer';

// ── Enums ──────────────────────────────────────────────────

export enum OptionTypeEnum {
  CALL = 'CALL',
  PUT = 'PUT',
}

export enum OptionSide {
  BUY = 'BUY',
  SELL = 'SELL',
}

// ── Request DTOs ───────────────────────────────────────────

export class PlaceOptionOrderDto {
  @IsString()
  @IsNotEmpty()
  connectionId: string;

  /**
   * Contract symbol — format depends on the venue behind `connectionId`:
   *   - Binance crypto options: BTC-260327-100000-C
   *   - Alpaca US equity options (OCC-21): AAPL240621C00150000
   */
  @IsString()
  @Matches(/^([A-Z]{2,10}-\d{6}-\d+(?:\.\d+)?-[CP]|[A-Z]{1,6}\d{6}[CP]\d{8})$/, {
    message:
      'contractSymbol must be Binance format (BTC-260327-100000-C, XRP-260327-2.5-C) or OCC format (AAPL240621C00150000)',
  })
  contractSymbol: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Z]{1,10}$/, {
    message: 'underlying must be uppercase letters (e.g. BTC, AAPL)',
  })
  underlying: string;

  @IsNumber()
  @Min(0)
  strike: number;

  @IsDateString()
  expiry: string;

  @IsEnum(OptionTypeEnum)
  @IsNotEmpty()
  optionType: OptionTypeEnum;

  @IsEnum(OptionSide)
  @IsNotEmpty()
  side: OptionSide;

  @IsNumber()
  @Min(0.0001, { message: 'quantity must be at least 0.0001' })
  @Max(10000, { message: 'quantity cannot exceed 10000' })
  quantity: number;

  @IsNumber()
  @Min(0.00000001, { message: 'price must be positive' })
  @Max(1000000, { message: 'price cannot exceed 1000000' })
  price: number; // limit price (premium per contract)

  @IsOptional()
  @IsString()
  signalId?: string;
}

// ── Multi-leg (mleg) order DTOs ────────────────────────────
//
// Shape intentionally mirrors Alpaca's `legs[]` payload: Binance has no
// mleg primitive, so this DTO is currently Alpaca-only (routed via
// `OptionsAlpacaService.placeMultiLegOrder`). A future Binance path would
// iterate these legs as individual orders inside a shared group_id.

export enum MultiLegPositionIntent {
  BUY_TO_OPEN = 'buy_to_open',
  SELL_TO_OPEN = 'sell_to_open',
  BUY_TO_CLOSE = 'buy_to_close',
  SELL_TO_CLOSE = 'sell_to_close',
}

export class MultiLegOrderLegDto {
  @IsString()
  @IsNotEmpty()
  contractSymbol: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^(buy|sell)$/)
  side: 'buy' | 'sell';

  @IsNumber()
  @Min(1, { message: 'ratioQty must be at least 1' })
  @Max(100, { message: 'ratioQty cannot exceed 100' })
  ratioQty: number;

  @IsEnum(MultiLegPositionIntent)
  positionIntent: MultiLegPositionIntent;
}

export class PlaceMultiLegOrderDto {
  @IsString()
  @IsNotEmpty()
  connectionId: string;

  @IsString()
  @IsNotEmpty()
  underlying: string;

  @IsNumber()
  @Min(1)
  @Max(10000)
  qty: number;

  @IsString()
  @Matches(/^(market|limit)$/, { message: 'type must be "market" or "limit"' })
  type: 'market' | 'limit';

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Max(1000000)
  limitPrice?: number;

  @IsOptional()
  @IsString()
  @Matches(/^(day|gtc)$/)
  timeInForce?: 'day' | 'gtc';

  @IsOptional()
  @IsString()
  signalId?: string;

  // 2–4 legs, validated elementwise. The @Type() decorator is required for
  // ValidateNested to know which class to construct from the plain JSON.
  @IsArray()
  @ArrayMinSize(2, { message: 'legs must contain at least 2 entries' })
  @ArrayMaxSize(4, { message: 'legs cannot contain more than 4 entries' })
  @ValidateNested({ each: true })
  @Type(() => MultiLegOrderLegDto)
  legs: MultiLegOrderLegDto[];
}

export class CancelOptionOrderDto {
  @IsString()
  connectionId: string;

  @IsString()
  contractSymbol: string;

  @IsString()
  orderId: string; // our DB order_id or binance order_id
}

// ── Response DTOs ──────────────────────────────────────────

export class GreeksDto {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  impliedVolatility?: number;
}

export class OptionContractDto {
  symbol: string;        // BTC-260327-100000-C
  underlying: string;    // BTC
  strike: number;
  expiry: string;        // ISO date
  type: OptionTypeEnum;
  bidPrice: number;
  askPrice: number;
  markPrice: number;
  lastPrice: number;
  volume: number;
  openInterest: number;
  greeks: GreeksDto;
  contractSize: number;
}

export class OptionsChainResponseDto {
  underlying: string;
  underlyingPrice: number;
  expiryDates: string[];
  contracts: OptionContractDto[];
  timestamp: number;
}

export class OptionsAccountDto {
  totalBalance: number;
  availableBalance: number;
  unrealizedPnl: number;
  marginBalance: number;
}

export class OptionsPositionDto {
  positionId: string;
  contractSymbol: string;
  underlying: string;
  strike: number;
  expiry: string;
  optionType: OptionTypeEnum;
  quantity: number;
  avgPremium: number;
  currentPremium: number;
  unrealizedPnl: number;
  realizedPnl: number;
  greeks: GreeksDto;
  isOpen: boolean;
  venue?: string;
}

export class OptionsOrderDto {
  orderId: string;
  contractSymbol: string;
  underlying: string;
  strike: number;
  expiry: string;
  optionType: OptionTypeEnum;
  side: string;
  quantity: number;
  price: number;
  filledQuantity: number;
  avgFillPrice: number;
  fee: number;
  status: string;
  binanceOrderId: string;
  maxLoss: number;
  createdAt: string;
}

export class OptionsRecommendationDto {
  signalId: string;
  assetSymbol: string;
  signalAction: string; // BUY / SELL
  signalConfidence: number;
  finalScore: number;

  recommendedType: OptionTypeEnum;
  recommendedStrike: number;
  recommendedExpiry: string;
  estimatedPremium: number;
  maxLoss: number;
  recommendedQuantity: number;

  ivRank: number;
  ivValue: number;
  greeks: GreeksDto;
  liquidityOk: boolean;
  reasoning: string;
  confidenceAdjustment: number;
}

export class AvailableUnderlyingDto {
  symbol: string;     // BTC
  indexPrice: number;  // current underlying price
  contractCount: number; // number of active option contracts
}
