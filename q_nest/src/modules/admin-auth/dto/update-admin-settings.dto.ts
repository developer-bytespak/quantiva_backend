import {
  IsString,
  IsOptional,
  IsNumber,
  Min,
  Max,
  IsInt,
} from 'class-validator';

export class UpdateBinanceSettingsDto {
  @IsString()
  @IsOptional()
  binance_uid?: string;

  @IsString()
  @IsOptional()
  wallet_address?: string;

  @IsString()
  @IsOptional()
  payment_network?: string;
}

export class UpdateFeeSettingsDto {
  @IsNumber()
  @Min(0)
  @Max(100)
  default_pool_fee_percent: number;

  @IsNumber()
  @Min(0)
  @Max(100)
  default_admin_profit_fee_percent: number;

  @IsNumber()
  @Min(0)
  @Max(100)
  default_cancellation_fee_percent: number;

  @IsInt()
  @Min(1)
  @Max(1440)
  default_payment_window_minutes: number;
}
