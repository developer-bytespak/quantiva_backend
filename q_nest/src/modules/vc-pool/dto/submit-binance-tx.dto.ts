import { IsNotEmpty, IsString, IsDateString, MaxLength } from 'class-validator';

export class SubmitBinanceTxDto {
  @IsNotEmpty({ message: 'binance_tx_id is required' })
  @IsString()
  @MaxLength(255)
  binance_tx_id: string;

  @IsNotEmpty({ message: 'binance_tx_timestamp is required' })
  @IsDateString({}, { message: 'binance_tx_timestamp must be a valid ISO date string' })
  binance_tx_timestamp: string;
}
