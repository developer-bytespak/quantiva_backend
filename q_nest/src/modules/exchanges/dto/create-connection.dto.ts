import { IsString, IsNotEmpty, IsUUID, IsBoolean } from 'class-validator';

export class CreateConnectionDto {
  @IsUUID()
  @IsNotEmpty()
  exchange_id: string;

  @IsString()
  @IsNotEmpty()
  api_key: string;

  @IsString()
  @IsNotEmpty()
  api_secret: string;

  @IsBoolean()
  enable_trading: boolean;
}

