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
   * Run every 5 minutes to verify pending Binance P2P payments
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async handlePaymentVerification() {
    if (this.isRunning) {
      this.logger.warn('Previous verification cycle still running, skipping...');
      return;
    }

    this.isRunning = true;

    try {
      const result = await this.verificationService.verifyPendingPayments();

      if (result.processed > 0) {
        this.logger.log(
          `Payment verification complete: ` +
            `${result.approved} approved, ${result.rejected} rejected, ${result.errors} errors`,
        );
      }
    } catch (error: any) {
      this.logger.error(`Payment verification scheduler error: ${error.message}`);
    } finally {
      this.isRunning = false;
    }
  }
}
