import { IsIn, IsNotEmpty, IsNumber, Max, Min } from 'class-validator';

export class SpendForDiscountDto {
  /**
   * QHQ amount to spend. Tiers:
   *  50  QHQ → 5%  discount
   * 100  QHQ → 10% discount
   * 200  QHQ → 15% discount (max)
   */
  @IsNotEmpty()
  @IsNumber()
  @IsIn([50, 100, 200], { message: 'qhq_amount must be 50, 100, or 200' })
  qhq_amount: number;
}

export class AdminGrantDeductDto {
  @IsNotEmpty()
  user_id: string;

  @IsNotEmpty()
  @IsNumber()
  @Min(0.1)
  @Max(100000)
  amount: number;

  @IsNotEmpty()
  description: string;
}

export class UpdateRewardRuleDto {
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  amount: number;

  is_active?: boolean;
  description?: string;
}
