import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

export class UpdateProgramSettingsDto {
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  subscription_commission_pct?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(120)
  recurring_months_cap?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  attribution_window_days?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  refund_clawback_days?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100_000)
  payout_threshold_usd?: number;

  @IsOptional()
  @IsIn(['MONTHLY', 'QUARTERLY'])
  payout_cycle?: 'MONTHLY' | 'QUARTERLY';

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000)
  affiliate_signup_velocity_24h?: number;
}
