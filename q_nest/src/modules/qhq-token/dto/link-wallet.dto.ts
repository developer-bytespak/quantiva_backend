import { IsEthereumAddress, IsNotEmpty } from 'class-validator';

export class LinkWalletDto {
  @IsNotEmpty()
  @IsEthereumAddress()
  wallet_address: string;
}
