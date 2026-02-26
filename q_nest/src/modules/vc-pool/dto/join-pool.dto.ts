import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

enum PaymentMethodEnum {
  stripe = 'stripe',
  binance = 'binance',
}

export class JoinPoolDto {
  @IsEnum(PaymentMethodEnum, { message: 'payment_method must be stripe or binance' })
  payment_method: 'stripe' | 'binance';

  @IsOptional()
  @IsString()
  @MaxLength(100)
  user_binance_uid?: string;
}
