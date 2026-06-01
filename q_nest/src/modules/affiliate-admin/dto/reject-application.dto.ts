import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class RejectApplicationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  reason: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  message?: string;
}
