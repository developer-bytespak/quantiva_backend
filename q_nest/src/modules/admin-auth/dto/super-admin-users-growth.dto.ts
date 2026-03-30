import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, Min } from 'class-validator';

export class SuperAdminUsersGrowthDto {
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(2020)
  year?: number;

  @IsOptional()
  @IsIn(['FREE', 'PRO', 'ELITE'])
  subscription_plan?: 'FREE' | 'PRO' | 'ELITE';

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  active_only?: boolean;
}
