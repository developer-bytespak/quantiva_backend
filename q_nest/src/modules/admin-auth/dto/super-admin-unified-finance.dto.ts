import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Min } from 'class-validator';

export class SuperAdminUnifiedFinanceDto {
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(2020)
  year?: number;

  @IsOptional()
  @IsIn(['PRO', 'ELITE'])
  plan_tier?: 'PRO' | 'ELITE';

  @IsOptional()
  @IsIn(['MONTHLY', 'QUARTERLY', 'YEARLY'])
  billing_period?: 'MONTHLY' | 'QUARTERLY' | 'YEARLY';

  @IsOptional()
  @IsIn(['JOIN', 'CANCEL', 'COMPLETION'])
  vc_collection_source?: 'JOIN' | 'CANCEL' | 'COMPLETION';
}