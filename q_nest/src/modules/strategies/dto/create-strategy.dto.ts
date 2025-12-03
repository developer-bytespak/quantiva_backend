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
import { StrategyType, RiskLevel } from '@prisma/client';

export class EntryRuleDto {
  @IsString()
  indicator: string;

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
  @IsString()
  indicator: string;

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
  @IsString()
  timeframe?: string; // '1h', '4h', '1d', etc.

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EntryRuleDto)
  entry_rules: EntryRuleDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExitRuleDto)
  exit_rules: ExitRuleDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => IndicatorConfigDto)
  indicators: IndicatorConfigDto[];

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
}

export class ValidateStrategyDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EntryRuleDto)
  entry_rules: EntryRuleDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExitRuleDto)
  exit_rules: ExitRuleDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => IndicatorConfigDto)
  indicators: IndicatorConfigDto[];

  @IsOptional()
  @IsString()
  timeframe?: string;
}

