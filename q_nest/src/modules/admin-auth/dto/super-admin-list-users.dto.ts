import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export class SuperAdminListUsersDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsIn(['FREE', 'PRO', 'ELITE', 'ELITE_PLUS'])
  plan?: 'FREE' | 'PRO' | 'ELITE' | 'ELITE_PLUS';

  @IsOptional()
  @IsIn(['active', 'cancelled', 'trial', 'expired'])
  subscription_status?: 'active' | 'cancelled' | 'trial' | 'expired';

  @IsOptional()
  @IsIn(['pending', 'approved', 'rejected', 'review'])
  kyc_status?: 'pending' | 'approved' | 'rejected' | 'review';

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
