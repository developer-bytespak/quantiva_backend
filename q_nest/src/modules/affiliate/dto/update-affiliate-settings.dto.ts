import {
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator';

export class UpdateAffiliateSettingsDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  full_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  country?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  tax_residency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  payout_instructions?: string;

  @IsOptional()
  @IsUrl({}, { message: 'tax_form_url must be a valid URL' })
  @MaxLength(500)
  tax_form_url?: string;
}
