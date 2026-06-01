import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export const AFFILIATE_CHANNELS = [
  'YOUTUBE',
  'X',
  'INSTAGRAM',
  'TIKTOK',
  'DISCORD',
  'TELEGRAM',
  'OTHER',
] as const;
export type AffiliateChannel = (typeof AFFILIATE_CHANNELS)[number];

export class AffiliateAdditionalChannelDto {
  @IsIn(AFFILIATE_CHANNELS as unknown as string[])
  type: AffiliateChannel;

  @IsOptional()
  @IsUrl({}, { message: 'Channel URL must be a valid URL' })
  @MaxLength(500)
  url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  customName?: string;
}

export class AffiliateSignupDto {
  @IsEmail({}, { message: 'Invalid email format' })
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(8, { message: 'Password must be at least 8 characters long' })
  password: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(120)
  displayName: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(120)
  fullName: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  country?: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  taxResidency?: string;

  @IsIn(AFFILIATE_CHANNELS as unknown as string[])
  primaryChannel: AffiliateChannel;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  primaryChannelCustomName?: string;

  @IsOptional()
  @IsUrl({}, { message: 'Channel URL must be a valid URL' })
  @MaxLength(500)
  channelUrl?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => AffiliateAdditionalChannelDto)
  additionalChannels?: AffiliateAdditionalChannelDto[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  audienceSize?: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(250, { message: 'Pitch must be 250 characters or fewer' })
  pitch: string;
}
