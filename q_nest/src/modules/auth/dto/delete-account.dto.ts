import { IsString, IsNotEmpty, IsOptional, Length } from 'class-validator';

/**
 * DTO for account deletion request
 * Requires password confirmation and 2FA code for security
 */
export class DeleteAccountDto {
  @IsString()
  @IsOptional()
  password: string;

  @IsString()
  @IsOptional()
  @Length(6, 6, { message: '2FA code must be exactly 6 digits' })
  twoFactorCode: string;

  @IsString()
  @IsOptional()
  reason?: string; // Optional: Feedback reason for account deletion
}
