import {
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class SetCommissionRateDto {
  /**
   * Fraction — 0.20 = 20%. Bounded to [0, 1].
   */
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  commission_pct: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}
