import { IsString, IsNotEmpty, IsOptional, Length } from 'class-validator';

/**
 * DTO for account deletion request
 * Requires password confirmation and 2FA code for security
 */
export class DeleteAccountDto {
  @IsString()
  @IsNotEmpty({ message: 'Password is required to delete account' })
  password: string;

  @IsString()
  @IsNotEmpty({ message: '2FA code is required to delete account' })
  @Length(6, 6, { message: '2FA code must be exactly 6 digits' })
  twoFactorCode: string;

  @IsString()
  @IsOptional()
  reason?: string; // Optional: Feedback reason for account deletion
}
