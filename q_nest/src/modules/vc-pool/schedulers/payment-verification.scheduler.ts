import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BinanceVerificationService } from '../services/binance-verification.service';

@Injectable()
export class PaymentVerificationScheduler {
  private readonly logger = new Logger(PaymentVerificationScheduler.name);
  private isRunning = false;

  constructor(
    private readonly verificationService: BinanceVerificationService,
  ) {}

  /**
   * Run every 5 minutes to verify pending payments via Binance deposit history
   * Payments are made via direct crypto transfers on the network (not P2P)
   * The transfers appear as deposits in the admin's Binance account
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async handlePaymentVerification() {
    if (this.isRunning) {
      this.logger.warn('Previous verification cycle still running, skipping...');
      return;
    }

    this.isRunning = true;

    try {
      // Check: Verify payment by checking Binance deposit history
      // Users send crypto directly to admin's address via blockchain network
      const depositResult = await this.verificationService.verifyPaymentsByDepositHistory();

      if (depositResult.approved > 0 || depositResult.rejected > 0) {
        this.logger.log(
          `[NETWORK DEPOSIT VERIFICATION] Complete: ` +
            `${depositResult.approved} approved, ${depositResult.errors} errors`,
        );
      }

      if (depositResult.approved > 0) {
        this.logger.log(
          `✓ Total payments approved this cycle: ${depositResult.approved} (verified via network deposits)`,
        );
      }
    } catch (error: any) {
      this.logger.error(`Payment verification scheduler error: ${error.message}`);
    } finally {
      this.isRunning = false;
    }
  }
}
