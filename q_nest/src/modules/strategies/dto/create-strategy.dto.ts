import {
  IsString,
  IsOptional,
  IsEnum,
  IsArray,
  IsNumber,
  IsObject,
  ValidateNested,
  IsBoolean,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';

// Define local enums to avoid Prisma client initialization issues with class-validator
// These must match the Prisma schema enums exactly
export enum StrategyType {
  admin = 'admin',
  user = 'user',
}

export enum RiskLevel {
  low = 'low',
  medium = 'medium',
  high = 'high',
}

export enum AssetType {
  crypto = 'crypto',
  stock = 'stock',
}

// Engine weights for score-based signal generation (like pre-built strategies)
export class EngineWeightsDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  sentiment?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  trend?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  fundamental?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  event_risk?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  liquidity?: number;
}

export class EntryRuleDto {
  // Support both "indicator" (legacy) and "field" (new score-based) for rules
  @IsOptional()
  @IsString()
  indicator?: string;

  @IsOptional()
  @IsString()
  field?: string; // e.g., 'final_score', 'metadata.engine_details.sentiment.score'

  @IsString()
  operator: string; // '>', '<', '>=', '<=', '==', 'cross_above', 'cross_below'

  @IsNumber()
  value: number;

  @IsOptional()
  @IsString()
  timeframe?: string;

  @IsOptional()
  @IsString()
  logic?: string; // 'AND', 'OR' for combining multiple conditions
}

export class ExitRuleDto {
  // Support both "indicator" (legacy) and "field" (new score-based) for rules
  @IsOptional()
  @IsString()
  indicator?: string;

  @IsOptional()
  @IsString()
  field?: string; // e.g., 'final_score', 'metadata.engine_details.sentiment.score'

  @IsString()
  operator: string;

  @IsNumber()
  value: number;

  @IsOptional()
  @IsString()
  timeframe?: string;

  @IsOptional()
  @IsString()
  logic?: string;
}

export class IndicatorConfigDto {
  @IsString()
  name: string; // 'MA20', 'RSI', 'MACD', etc.

  @IsOptional()
  @IsObject()
  parameters?: Record<string, any>; // e.g., { period: 14, fast: 12, slow: 26 }

  @IsOptional()
  @IsString()
  timeframe?: string; // '1h', '4h', '1d', etc.
}

export class CreateStrategyDto {
  @IsOptional()
  @IsString()
  user_id?: string;

  @IsString()
  name: string;

  @IsEnum(StrategyType)
  type: StrategyType;

  @IsOptional()
  @IsString()
  description?: string;

  @IsEnum(RiskLevel)
  risk_level: RiskLevel;

  @IsOptional()
  @IsEnum(AssetType)
  asset_type?: AssetType; // 'crypto' | 'stock' - defaults to 'crypto'

  @IsOptional()
  @IsString()
  timeframe?: string; // '1h', '4h', '1d', etc.

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EntryRuleDto)
  entry_rules?: EntryRuleDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExitRuleDto)
  exit_rules?: ExitRuleDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => IndicatorConfigDto)
  indicators?: IndicatorConfigDto[];

  @IsOptional()
  @IsString()
  stop_loss_type?: string; // 'percentage', 'atr', 'fixed'

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  stop_loss_value?: number;

  @IsOptional()
  @IsString()
  take_profit_type?: string; // 'percentage', 'ratio', 'fixed'

  @IsOptional()
  @IsNumber()
  @Min(0)
  take_profit_value?: number;

  @IsOptional()
  @IsString()
  schedule_cron?: string; // Cron expression, e.g., '0 */4 * * *' for every 4 hours

  @IsArray()
  @IsString({ each: true })
  target_assets: string[]; // Array of asset symbols

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  auto_trade_threshold?: number;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => EngineWeightsDto)
  engine_weights?: EngineWeightsDto;
}

export class ValidateStrategyDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EntryRuleDto)
  entry_rules?: EntryRuleDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExitRuleDto)
  exit_rules?: ExitRuleDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => IndicatorConfigDto)
  indicators?: IndicatorConfigDto[];

  @IsOptional()
  @IsString()
  timeframe?: string;
}

