import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { AFFILIATE_COMMISSION_TIERS } from './commission-tier.constants';

export class ChangeTierDto {
  @IsIn(AFFILIATE_COMMISSION_TIERS as unknown as string[])
  commission_tier: (typeof AFFILIATE_COMMISSION_TIERS)[number];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}
