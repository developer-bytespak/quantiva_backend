import { IsOptional, IsString, MaxLength } from 'class-validator';

export class MarkPayoutPaidDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  payment_reference?: string;
}
