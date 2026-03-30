import { Injectable, HttpException, HttpStatus } from '@nestjs/common';

interface RateLimitEntry {
  attempts: number;
  lockUntil: number | null;
}

@Injectable()
export class RateLimitService {
  private readonly MAX_ATTEMPTS = 5;
  private readonly LOCK_DURATION = 5 * 60 * 1000; // 5 minutes in milliseconds
  private readonly attempts = new Map<string, RateLimitEntry>();

  checkRateLimit(ipAddress: string): void {
    const entry = this.attempts.get(ipAddress);
    const now = Date.now();

    // If entry exists and is locked, check if lock has expired
    if (entry?.lockUntil && entry.lockUntil > now) {
      const remainingSeconds = Math.ceil((entry.lockUntil - now) / 1000);
      throw new HttpException(
        `Too many login attempts. Please try again in ${remainingSeconds} seconds.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // If lock expired, reset the entry
    if (entry?.lockUntil && entry.lockUntil <= now) {
      this.attempts.delete(ipAddress);
    }
  }

  recordFailedAttempt(ipAddress: string): void {
    const entry = this.attempts.get(ipAddress) || { attempts: 0, lockUntil: null };
    entry.attempts += 1;

    if (entry.attempts >= this.MAX_ATTEMPTS) {
      entry.lockUntil = Date.now() + this.LOCK_DURATION;
      entry.attempts = 0; // Reset counter after lock
    }

    this.attempts.set(ipAddress, entry);
  }

  recordSuccessfulAttempt(ipAddress: string): void {
    // Clear rate limit on successful login
    this.attempts.delete(ipAddress);
  }

  isLocked(ipAddress: string): boolean {
    const entry = this.attempts.get(ipAddress);
    if (!entry?.lockUntil) {
      return false;
    }
    return entry.lockUntil > Date.now();
  }

  // Cleanup old entries periodically (optional, for memory management)
  cleanup(): void {
    const now = Date.now();
    for (const [ip, entry] of this.attempts.entries()) {
      if (entry.lockUntil && entry.lockUntil <= now) {
        this.attempts.delete(ip);
      }
    }
  }
}

