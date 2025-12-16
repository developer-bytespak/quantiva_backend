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
}
