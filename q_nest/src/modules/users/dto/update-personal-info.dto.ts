import { IsString, IsOptional, IsDateString, IsEnum, MinLength, MaxLength, Matches } from 'class-validator';

export enum Gender {
  MALE = 'male',
  FEMALE = 'female',
  OTHER = 'other',
  PREFER_NOT_TO_SAY = 'prefer-not-to-say',
}

export class UpdatePersonalInfoDto {
  @IsString()
  @MinLength(2, { message: 'Full name must be at least 2 characters long' })
  @MaxLength(120, { message: 'Full name must not exceed 120 characters' })
  fullName: string;

  @IsDateString({}, { message: 'Date of birth must be a valid date' })
  dob: string;

  @IsString()
  @MinLength(2, { message: 'Nationality must be at least 2 characters long' })
  nationality: string;

  @IsOptional()
  @IsEnum(Gender, { message: 'Gender must be one of: male, female, other, prefer-not-to-say' })
  gender?: Gender;

  @IsOptional()
  @IsString()
  @Matches(/^\+?[1-9]\d{1,14}$/, { message: 'Phone number must be a valid international format' })
  phoneNumber?: string;
}

