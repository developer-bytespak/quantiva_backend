import {
  IsNotEmpty,
  IsNumber,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class AdjustBalanceDto {
  /**
   * Positive credits the affiliate, negative debits. Bounded to a sane window
   * so a typo can't move thousands of dollars in one click.
   */
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(-10_000)
  @Max(10_000)
  delta_usd: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}
