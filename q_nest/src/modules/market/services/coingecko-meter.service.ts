import { Injectable, Logger } from '@nestjs/common';

/**
 * Lightweight in-memory counter for outbound CoinGecko HTTP calls.
 *
 * NOT a quota gate — the Python service owns the hard quota shield and that
 * is sufficient because `pro-api.coingecko.com` rate-limits per API key
 * server-side. This counter only exists so we can answer: "how many CoinGecko
 * calls did NestJS make today?" — useful for diagnosing whether unexpected
 * monthly burn came from the Python side or the NestJS side.
 *
 * Counters reset at UTC midnight on first read after rollover.
 */
@Injectable()
export class CoinGeckoMeterService {
  private readonly logger = new Logger(CoinGeckoMeterService.name);
  private todayStr: string = this.utcDateString();
  private todayCount = 0;

  /** Increment the daily counter. Call once per outbound CoinGecko request. */
  bump(n: number = 1): void {
    this.rolloverIfNeeded();
    this.todayCount += n;
  }

  /** Return the current day's count + the date the count is for. */
  snapshot(): { date: string; count: number } {
    this.rolloverIfNeeded();
    return { date: this.todayStr, count: this.todayCount };
  }

  private rolloverIfNeeded(): void {
    const today = this.utcDateString();
    if (today !== this.todayStr) {
      this.logger.log(
        `[CoinGeckoMeter] day rollover ${this.todayStr} (count=${this.todayCount}) -> ${today}`,
      );
      this.todayStr = today;
      this.todayCount = 0;
    }
  }

  private utcDateString(): string {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  }
}
