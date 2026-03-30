import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { QhqTokenService } from './qhq-token.service';

@Injectable()
export class QhqTokenScheduler {
  private readonly logger = new Logger(QhqTokenScheduler.name);

  constructor(private qhqService: QhqTokenService) {}

  /** Daily at 9am — check and award 12-month loyalty bonuses */
  @Cron('0 9 * * *')
  async handleLoyaltyBonus() {
    this.logger.log('Running loyalty bonus check...');
    try {
      const awarded = await this.qhqService.processLoyaltyBonuses();
      this.logger.log(`Loyalty bonuses awarded to ${awarded} users.`);
    } catch (err) {
      this.logger.error(`Loyalty bonus failed: ${err.message}`);
    }
  }

  /** Every Sunday at midnight — update Merkle root on-chain */
  @Cron('0 0 * * 0')
  async handleMerkleRootUpdate() {
    this.logger.log('Running weekly Merkle root update...');
    try {
      const txHash = await this.qhqService.generateAndUpdateMerkleRoot();
      this.logger.log(`Merkle root updated. TX: ${txHash ?? 'stored in DB only'}`);
    } catch (err) {
      this.logger.error(`Merkle root update failed: ${err.message}`);
    }
  }
}
