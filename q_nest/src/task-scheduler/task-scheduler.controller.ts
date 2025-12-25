import { Controller, Get, Logger } from '@nestjs/common';
import { TaskSchedulerService, CleanupMetrics } from './task-scheduler.service';

/**
 * Task Scheduler Controller
 * Provides admin endpoints for manual cleanup and status checking
 */
@Controller('admin/cleanup')
export class TaskSchedulerController {
  private readonly logger = new Logger(TaskSchedulerController.name);

  constructor(private taskScheduler: TaskSchedulerService) {}

  /**
   * Manually trigger cleanup
   * GET /admin/cleanup/trigger
   */
  @Get('trigger')
  async triggerCleanup(): Promise<{
    success: boolean;
    message: string;
    metrics?: CleanupMetrics;
    error?: string;
  }> {
    this.logger.log('Manual cleanup triggered via API');
    try {
      const metrics = await this.taskScheduler.triggerManualCleanup();
      return {
        success: true,
        message: 'Cleanup completed successfully',
        metrics,
      };
    } catch (error: any) {
      this.logger.error('Manual cleanup failed', error);
      return {
        success: false,
        message: error.message || 'Cleanup failed',
        error: error.message,
      };
    }
  }

  /**
   * Get cleanup status
   * GET /admin/cleanup/status
   */
  @Get('status')
  async getStatus() {
    const status = this.taskScheduler.getStatus();
    return {
      success: true,
      ...status,
    };
  }
}
