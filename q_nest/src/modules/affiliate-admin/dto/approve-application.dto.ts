import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { AFFILIATE_COMMISSION_TIERS } from './commission-tier.constants';

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

  @IsOptional()
  @IsIn(AFFILIATE_COMMISSION_TIERS as unknown as string[])
  commission_tier?: (typeof AFFILIATE_COMMISSION_TIERS)[number];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
