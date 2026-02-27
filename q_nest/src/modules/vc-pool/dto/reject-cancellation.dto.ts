import { IsString, MaxLength } from 'class-validator';

export class RejectCancellationDto {
  @IsString()
  @MaxLength(500)
  rejection_reason: string;
}

