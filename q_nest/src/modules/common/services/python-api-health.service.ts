import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class PythonApiHealthService {
  private readonly logger = new Logger(PythonApiHealthService.name);
  private failureCount = 0;
  private lastFailureTime: Date | null = null;
  private readonly MAX_FAILURES = 5;
  private readonly RESET_TIMEOUT = 60 * 1000; // 1 minute
  private circuitOpen = false;

  /**
   * Record a failure
   */
  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = new Date();

    if (this.failureCount >= this.MAX_FAILURES) {
      this.circuitOpen = true;
      this.logger.warn(
        `Circuit breaker opened after ${this.failureCount} failures`,
      );
    }
  }

  /**
   * Record a success
   */
  recordSuccess(): void {
    if (this.failureCount > 0) {
      this.failureCount = 0;
      this.lastFailureTime = null;
      if (this.circuitOpen) {
        this.circuitOpen = false;
        this.logger.log('Circuit breaker closed - service recovered');
      }
    }
  }

  /**
   * Check if Python API is healthy
   */
  isHealthy(): boolean {
    // If circuit is open, check if timeout has passed
    if (this.circuitOpen && this.lastFailureTime) {
      const timeSinceLastFailure =
        Date.now() - this.lastFailureTime.getTime();
      if (timeSinceLastFailure >= this.RESET_TIMEOUT) {
        // Reset circuit breaker
        this.circuitOpen = false;
        this.failureCount = 0;
        this.lastFailureTime = null;
        this.logger.log('Circuit breaker reset after timeout');
        return true;
      }
      return false;
    }

    return !this.circuitOpen;
  }

  /**
   * Get health status
   */
  getStatus(): {
    healthy: boolean;
    failureCount: number;
    circuitOpen: boolean;
    lastFailureTime: Date | null;
  } {
    return {
      healthy: this.isHealthy(),
      failureCount: this.failureCount,
      circuitOpen: this.circuitOpen,
      lastFailureTime: this.lastFailureTime,
    };
  }
}

