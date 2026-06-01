import {
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
} from 'class-validator';

export const AFFILIATE_CHANNELS = [
  'YOUTUBE',
  'X',
  'INSTAGRAM',
  'TIKTOK',
  'NEWSLETTER',
  'BLOG',
  'DISCORD_TELEGRAM',
  'PODCAST',
  'OTHER',
] as const;
export type AffiliateChannel = (typeof AFFILIATE_CHANNELS)[number];

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
  @IsUrl({}, { message: 'Channel URL must be a valid URL' })
  @MaxLength(500)
  channelUrl?: string;

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
