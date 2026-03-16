import { IsNotEmpty, IsOptional, IsString, IsDateString, MaxLength } from 'class-validator';

export class SubmitBinanceTxDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  binance_tx_id?: string;

  @IsOptional()
  @IsDateString({}, { message: 'binance_tx_timestamp must be a valid ISO date string' })
  binance_tx_timestamp?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  tx_hash?: string;
}
