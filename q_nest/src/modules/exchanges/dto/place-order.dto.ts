import { IsString, IsNotEmpty, IsIn, IsNumber, IsPositive, IsOptional, Min, Max } from 'class-validator';

export class PlaceOrderDto {
  @IsString()
  @IsNotEmpty()
  symbol: string;

  @IsIn(['BUY', 'SELL'])
  side: 'BUY' | 'SELL';

  @IsIn(['MARKET', 'LIMIT'])
  type: 'MARKET' | 'LIMIT';

  @IsNumber()
  @IsPositive()
  quantity: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  price?: number;

  /** Stop-loss as a decimal fraction, e.g. 0.05 = 5% below entry. Defaults to 0.05. */
  @IsOptional()
  @IsNumber()
  @Min(0.001)
  @Max(0.5)
  stopLoss?: number;

  /** Take-profit as a decimal fraction, e.g. 0.10 = 10% above entry. Defaults to 0.10. */
  @IsOptional()
  @IsNumber()
  @Min(0.001)
  @Max(5)
  takeProfit?: number;
}

