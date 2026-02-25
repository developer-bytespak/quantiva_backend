import {
  IsString,
  IsOptional,
  IsNumber,
  IsInt,
  Min,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class UpdatePoolDto {
  @IsOptional()
  @IsString()
  @MaxLength(150)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  coin_type?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(0.00000001)
  contribution_amount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2)
  max_members?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  duration_days?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  pool_fee_percent?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  admin_profit_fee_percent?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  cancellation_fee_percent?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  payment_window_minutes?: number;
}
