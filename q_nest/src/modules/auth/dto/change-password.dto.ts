import { IsString, IsNotEmpty, MinLength, Length } from 'class-validator';

export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty()
  oldPassword: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(8, { message: 'New password must be at least 8 characters long' })
  newPassword: string;

  @IsString()
  @IsNotEmpty()
  @Length(6, 6, { message: '2FA code must be exactly 6 digits' })
  twoFactorCode: string;
}

