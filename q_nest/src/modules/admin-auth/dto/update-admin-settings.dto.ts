import {
  IsString,
  IsOptional,
  IsNumber,
  Min,
  Max,
  IsInt,
  IsNotEmpty,
  IsIn,
} from 'class-validator';

export const ALLOWED_PAYMENT_NETWORKS = ['TRC20', 'ERC20', 'BEP20'] as const;
export type PaymentNetwork = (typeof ALLOWED_PAYMENT_NETWORKS)[number];

export class UpdateBinanceSettingsDto {
  @IsString()
  @IsOptional()
  binance_uid?: string;

  @IsString()
  @IsOptional()
  wallet_address?: string;

  @IsIn(ALLOWED_PAYMENT_NETWORKS, {
    message: `payment_network must be one of: ${ALLOWED_PAYMENT_NETWORKS.join(', ')}`,
  })
  @IsOptional()
  payment_network?: PaymentNetwork;
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

  @IsString()
  @IsNotEmpty()
  @IsOptional()
  currentPassword?: string;
}
