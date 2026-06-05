import { IsEmail, IsNotEmpty, IsString, Length } from 'class-validator';

export class SendAffiliateCodeDto {
  @IsEmail({}, { message: 'Invalid email format' })
  @IsNotEmpty()
  email: string;
}

export class VerifyAffiliateCodeDto {
  @IsEmail({}, { message: 'Invalid email format' })
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsNotEmpty()
  @Length(6, 6, { message: 'Code must be 6 digits' })
  code: string;
}
