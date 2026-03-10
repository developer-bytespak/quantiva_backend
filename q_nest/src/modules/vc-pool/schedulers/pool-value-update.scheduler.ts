import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PoolValueService } from '../services/pool-value.service';

@Injectable()
export class PoolValueUpdateScheduler {
  private readonly logger = new Logger(PoolValueUpdateScheduler.name);
  private isRunning = false;

  constructor(private readonly poolValueService: PoolValueService) {}

  @Cron('0 */5 * * *') // Every 5 minutes
  async handlePoolValueUpdate() {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const results = await this.poolValueService.updateAllActivePools();
      if (results.length > 0) {
        this.logger.log(`Updated values for ${results.length} active pool(s)`);
      }
    } catch (err) {
      this.logger.error(`Pool value update job failed: ${err.message}`);
    } finally {
      this.isRunning = false;
    }
  }
}
