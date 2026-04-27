import { IsNotEmpty, IsString } from 'class-validator';

export class UnsubscribeDto {
  @IsString()
  @IsNotEmpty()
  token: string;
}
