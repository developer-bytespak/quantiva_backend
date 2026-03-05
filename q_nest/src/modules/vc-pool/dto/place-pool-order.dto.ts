import { IsString, IsIn, IsNumber, Min, IsOptional } from 'class-validator';

export class PlacePoolOrderDto {
  @IsString()
  symbol: string;

  @IsIn(['BUY', 'SELL'])
  side: 'BUY' | 'SELL';

  @IsIn(['MARKET', 'LIMIT'])
  type: 'MARKET' | 'LIMIT';

  @IsNumber()
  @Min(0)
  quantity: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number; // Required for LIMIT orders
}
