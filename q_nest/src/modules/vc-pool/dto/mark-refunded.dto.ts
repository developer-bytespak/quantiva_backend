import { IsOptional, IsString, MaxLength } from 'class-validator';

export class MarkRefundedDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  binance_tx_id?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

