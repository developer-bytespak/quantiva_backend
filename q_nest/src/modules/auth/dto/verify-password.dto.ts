import { IsString, IsNotEmpty } from 'class-validator';

/**
 * DTO for password verification request
 * Used to verify password before sensitive operations like account deletion
 */
export class VerifyPasswordDto {
  @IsString()
  @IsNotEmpty({ message: 'Password is required' })
  password: string;
}
