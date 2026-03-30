import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class ConfirmClaimDto {
  @IsNotEmpty()
  @IsString()
  @Matches(/^0x[a-fA-F0-9]{64}$/, { message: 'tx_hash must be a valid hex transaction hash' })
  tx_hash: string;

  @IsNotEmpty()
  @IsString()
  amount: string; // decimal string e.g. "100.5"
}
