import {
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

export class CreateVcPoolAdminDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsOptional()
  @IsString()
  full_name?: string;

  @IsOptional()
  @IsBoolean()
  is_super_admin?: boolean;

  @IsString()
  @IsNotEmpty({ message: 'Current password is required' })
  currentPassword: string;
}
