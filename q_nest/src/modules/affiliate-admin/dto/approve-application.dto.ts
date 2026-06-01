import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class ApproveApplicationDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(60)
  @Matches(/^[A-Za-z0-9_\-]+$/, {
    message:
      'referral_code may only contain letters, numbers, dashes, and underscores',
  })
  referral_code: string;

  /**
   * Commission rate to stamp on the affiliate at approval time. Fraction —
   * 0.20 = 20%. Frontend pre-fills with the current program default.
   */
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  commission_pct: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
