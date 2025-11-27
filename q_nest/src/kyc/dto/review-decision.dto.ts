import { IsNotEmpty, IsString, IsOptional } from 'class-validator';

export class ReviewDecisionDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

