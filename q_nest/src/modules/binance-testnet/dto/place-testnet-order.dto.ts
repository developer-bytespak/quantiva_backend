import { IsString, IsNumber, IsNotEmpty, IsIn, IsOptional, Min } from 'class-validator';

export class PlaceTestnetOrderDto {
  @IsString()
  @IsNotEmpty()
  symbol: string;

  @IsString()
  @IsNotEmpty()
  @IsIn(['BUY', 'SELL'])
  side: 'BUY' | 'SELL';

  @IsString()
  @IsNotEmpty()
  @IsIn(['MARKET', 'LIMIT'])
  type: 'MARKET' | 'LIMIT';

  @IsNumber()
  @IsNotEmpty()
  @Min(0)
  quantity: number;

  @IsNumber()
  @IsOptional()
  @Min(0)
  price?: number;

  @IsNumber()
  @IsOptional()
  @Min(0)
  stopLoss?: number; // Stop loss percentage (e.g., 0.05 for 5%)

  @IsNumber()
  @IsOptional()
  @Min(0)
  takeProfit?: number; // Take profit percentage (e.g., 0.10 for 10%)
}

