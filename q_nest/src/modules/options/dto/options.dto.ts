import {
  IsString,
  IsNumber,
  IsEnum,
  IsOptional,
  IsDateString,
  IsNotEmpty,
  Min,
  Max,
  Matches,
} from 'class-validator';

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

  @IsString()
  @Matches(/^[A-Z]{2,10}-\d{6}-\d+-[CP]$/, {
    message: 'contractSymbol must match format like BTC-260327-100000-C',
  })
  contractSymbol: string; // e.g. BTC-260327-100000-C

  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Z]{2,10}$/, {
    message: 'underlying must be uppercase letters (e.g. BTC, ETH)',
  })
  underlying: string; // e.g. BTC

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
