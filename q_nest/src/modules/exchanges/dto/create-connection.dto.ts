import { IsString, IsNotEmpty, IsUUID, IsBoolean, Matches } from 'class-validator';

export class CreateConnectionDto {
  @IsUUID()
  @IsNotEmpty()
  exchange_id: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Za-z0-9]{64}$/, {
    message: 'API key must be a valid Binance API key format (64 alphanumeric characters)',
  })
  api_key: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Za-z0-9]{64}$/, {
    message: 'API secret must be a valid Binance API secret format (64 alphanumeric characters)',
  })
  api_secret: string;

  @IsBoolean()
  enable_trading: boolean;
}

