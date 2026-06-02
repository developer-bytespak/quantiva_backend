import { IsNumber, IsUUID, Max, Min } from 'class-validator';

/**
 * Body for the super-admin-only test endpoint that fires a fake subscription
 * payment for a given user — used to verify affiliate commission accrual
 * without involving Stripe or real money.
 */
export class SimulateSubscriptionPaymentDto {
  @IsUUID()
  user_id: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(10_000)
  amount_usd: number;
}
