import {
  IsNotEmpty,
  IsNumber,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class GrantQhqDto {
  /**
   * QHQ tokens to credit to the affiliate's linked platform account.
   * Bounded so a typo can't mint an absurd amount in one click.
   */
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(100_000)
  amount: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}
