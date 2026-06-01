import { IsEmail, IsNotEmpty, IsString, MinLength } from 'class-validator';

export class AffiliateLoginDto {
  @IsEmail({}, { message: 'Invalid email format' })
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  password: string;
}
