import { IsNumber, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class CloseTradeDto {
  @IsNumber()
  @Type(() => Number)
  @Min(0.00000001)
  exit_price_usdt: number;
}
