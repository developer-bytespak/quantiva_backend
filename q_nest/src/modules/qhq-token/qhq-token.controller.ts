import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  UseGuards,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { QhqTokenService } from './qhq-token.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { LinkWalletDto } from './dto/link-wallet.dto';
import { ConfirmClaimDto } from './dto/claim-tokens.dto';
import { SpendForDiscountDto } from './dto/spend-qhq.dto';

@Controller('qhq')
@UseGuards(JwtAuthGuard)
export class QhqTokenController {
  constructor(private readonly qhqService: QhqTokenService) {}

  /** GET /qhq/balance — off-chain pending balance + lifetime stats */
  @Get('balance')
  async getBalance(@CurrentUser() user: any) {
    return this.qhqService.getBalance(user.sub);
  }

  /** GET /qhq/transactions?page=1&limit=20 — paginated transaction history */
  @Get('transactions')
  async getTransactions(
    @CurrentUser() user: any,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
  ) {
    return this.qhqService.getTransactionHistory(
      user.sub,
      parseInt(page, 10),
      parseInt(limit, 10),
    );
  }

  /** GET /qhq/wallet — get linked wallet */
  @Get('wallet')
  async getWallet(@CurrentUser() user: any) {
    return this.qhqService.getLinkedWallet(user.sub);
  }

  /** POST /qhq/wallet/link — link MetaMask/WalletConnect wallet address */
  @Post('wallet/link')
  @HttpCode(HttpStatus.OK)
  async linkWallet(@CurrentUser() user: any, @Body() dto: LinkWalletDto) {
    return this.qhqService.linkWallet(user.sub, dto.wallet_address);
  }

  /** DELETE /qhq/wallet — unlink and delete user's wallet address */
  @Delete('wallet')
  @HttpCode(HttpStatus.OK)
  async deleteWallet(@CurrentUser() user: any) {
    return this.qhqService.unlinkWallet(user.sub);
  }

  /**
   * GET /qhq/claim/proof — get Merkle proof for current cumulative allocation.
   * The frontend passes this directly to the smart contract's claim() function.
   */
  @Get('claim/proof')
  async getClaimProof(@CurrentUser() user: any) {
    return this.qhqService.getMerkleProof(user.sub);
  }

  /**
   * POST /qhq/claim/confirm — record a completed on-chain claim.
   * Called by frontend after the wallet transaction is confirmed on Base.
   */
  @Post('claim/confirm')
  @HttpCode(HttpStatus.OK)
  async confirmClaim(@CurrentUser() user: any, @Body() dto: ConfirmClaimDto) {
    return this.qhqService.recordClaim(user.sub, dto.tx_hash, dto.amount);
  }

  /**
   * POST /qhq/spend/subscription-discount — spend QHQ for next billing discount.
   * Amounts: 50 QHQ → 5%, 100 QHQ → 10%, 200 QHQ → 15%
   */
  @Post('spend/subscription-discount')
  @HttpCode(HttpStatus.OK)
  async spendForDiscount(@CurrentUser() user: any, @Body() dto: SpendForDiscountDto) {
    return this.qhqService.spendForSubscriptionDiscount(user.sub, dto.qhq_amount);
  }

  /** GET /qhq/discount — check if user has a pending subscription discount */
  @Get('discount')
  async getPendingDiscount(@CurrentUser() user: any) {
    return this.qhqService.getPendingDiscount(user.sub);
  }

  /** GET /qhq/referral-bonus — can the user claim the referral signup bonus? */
  @Get('referral-bonus')
  async getReferralBonus(@CurrentUser() user: any) {
    return this.qhqService.getReferralBonusStatus(user.sub);
  }

  /** POST /qhq/referral-bonus/claim — one-time 100 QHQ + 10% first-purchase discount */
  @Post('referral-bonus/claim')
  @HttpCode(HttpStatus.OK)
  async claimReferralBonus(@CurrentUser() user: any) {
    return this.qhqService.claimReferralBonus(user.sub);
  }

  /** GET /qhq/stats — global token stats */
  @Get('stats')
  async getStats() {
    return this.qhqService.getTokenStats();
  }

  /** GET /qhq/reward-rules — earning opportunities list */
  @Get('reward-rules')
  async getRewardRules() {
    return this.qhqService.getRewardRules();
  }
}
