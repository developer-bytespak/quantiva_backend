import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { Socket } from 'socket.io';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class WsRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(WsRateLimitGuard.name);
  private readonly requestMap = new Map<string, { count: number; resetTime: number }>();
  private readonly ttl: number;
  private readonly limit: number;

  constructor(private readonly configService: ConfigService) {
    this.ttl = this.configService.get<number>('stream.rateLimit.ttl', 60000);
    this.limit = this.configService.get<number>('stream.rateLimit.limit', 10);

    // Cleanup expired entries periodically
    setInterval(() => this.cleanup(), this.ttl);
  }

  canActivate(context: ExecutionContext): boolean {
    try {
      const client: Socket = context.switchToWs().getClient();
      const userId = client.data.userId || client.id;

      const now = Date.now();
      const userRecord = this.requestMap.get(userId);

      if (!userRecord || now > userRecord.resetTime) {
        // Initialize or reset
        this.requestMap.set(userId, {
          count: 1,
          resetTime: now + this.ttl,
        });
        return true;
      }

      if (userRecord.count >= this.limit) {
        this.logger.warn(
          `Rate limit exceeded for user ${userId}: ${userRecord.count}/${this.limit}`,
        );
        throw new WsException('Rate limit exceeded. Please try again later.');
      }

      userRecord.count++;
      return true;
    } catch (error) {
      if (error instanceof WsException) {
        throw error;
      }
      this.logger.error(`Rate limit guard error: ${error.message}`);
      return true; // Allow on error
    }
  }

  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [userId, record] of this.requestMap.entries()) {
      if (now > record.resetTime) {
        this.requestMap.delete(userId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.debug(`Cleaned up ${cleaned} expired rate limit records`);
    }
  }
}
