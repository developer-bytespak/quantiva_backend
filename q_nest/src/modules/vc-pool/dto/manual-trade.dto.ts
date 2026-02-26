import { IsString, IsEnum, IsNumber, IsOptional, IsUUID, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

enum TradeAction {
  BUY = 'BUY',
  SELL = 'SELL',
}

export class ManualTradeDto {
  @IsString()
  @MaxLength(20)
  asset_pair: string;

  @IsEnum(TradeAction, { message: 'action must be BUY or SELL' })
  action: 'BUY' | 'SELL';

  @IsNumber()
  @Type(() => Number)
  @Min(0.000000001)
  quantity: number;

  @IsNumber()
  @Type(() => Number)
  @Min(0.00000001)
  entry_price_usdt: number;

  @IsOptional()
  @IsUUID()
  strategy_id?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
