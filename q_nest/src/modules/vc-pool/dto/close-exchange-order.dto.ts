import { IsNumber, Min } from 'class-validator';

export class CloseExchangeOrderDto {
  @IsNumber()
  @Min(0)
  exit_price_usdt: number;
}
