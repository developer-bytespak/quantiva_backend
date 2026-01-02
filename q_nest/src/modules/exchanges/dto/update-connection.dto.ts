import { IsString, IsNotEmpty, MinLength, IsOptional } from 'class-validator';

export class UpdateConnectionDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(10, {
    message: 'API Key must be at least 10 characters',
  })
  api_key: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(10, {
    message: 'API Secret must be at least 10 characters',
  })
  api_secret: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(6, {
    message: 'Password must be at least 6 characters',
  })
  password: string;

  @IsString()
  @IsOptional()
  @MinLength(6, {
    message: 'Passphrase must be at least 6 characters',
  })
  passphrase?: string;
}
