import { IsString, IsNotEmpty, MinLength } from 'class-validator';

export class AdminChangePasswordDto {
  @IsString()
  @IsNotEmpty({ message: 'Current password is required' })
  oldPassword: string;

  @IsString()
  @IsNotEmpty({ message: 'New password is required' })
  @MinLength(8, { message: 'New password must be at least 8 characters long' })
  newPassword: string;
}
