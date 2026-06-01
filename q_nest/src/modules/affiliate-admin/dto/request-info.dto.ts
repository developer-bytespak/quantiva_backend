import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class RequestInfoDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(5)
  @MaxLength(2000)
  message: string;
}
