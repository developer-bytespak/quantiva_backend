import { IsString, IsOptional, IsNotEmpty } from 'class-validator';

/**
 * Body sent by the iOS app after a StoreKit 2 purchase (and on Restore).
 * `transactionId` / `originalTransactionId` come straight from StoreKit.
 * `receipt` is optional — included for older StoreKit flows; when present we can
 * recover a transactionId from it, but the App Store Server API lookup is the
 * source of truth either way.
 */
export class VerifyApplePurchaseDto {
  @IsString()
  @IsNotEmpty({ message: 'transactionId is required' })
  transactionId: string;

  @IsOptional()
  @IsString()
  originalTransactionId?: string;

  @IsOptional()
  @IsString()
  productId?: string;

  @IsOptional()
  @IsString()
  receipt?: string;
}
