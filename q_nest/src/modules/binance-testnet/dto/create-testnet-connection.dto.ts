import { IsString, IsNotEmpty, IsBoolean, IsOptional } from 'class-validator';

export class CreateTestnetConnectionDto {
  @IsString()
  @IsNotEmpty()
  api_key: string;

  @IsString()
  @IsNotEmpty()
  api_secret: string;

  @IsBoolean()
  @IsOptional()
  enable_trading: boolean = false;

  @IsString()
  @IsOptional()
  connection_name?: string;
}
