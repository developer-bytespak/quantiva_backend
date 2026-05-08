import {
  Controller,
  Post,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { HeldSymbolsWarmerService } from './held-symbols-warmer.service';
import { ExchangePositionsDiscoveryService } from './exchange-positions-discovery.service';

/**
 * Operator-only endpoints to trigger the held-symbols warmer on demand
 * (so we don't have to wait for the natural cron) and to inspect what the
 * discovery layer would find.
 *
 * Guarded by the same INTERNAL_API_KEY shared secret already used for
 * NestJS → Python service-to-service calls. Caller must send
 *   X-Internal-Api-Key: <value of INTERNAL_API_KEY env var>
 *
 * Intended to be removed after Issue 1 verification settles. Until then
 * leaving it in is fine — it's not exposed to end-user UI and the guard
 * means random callers can't drain the news API quota.
 */
@Controller('admin/news-warmer')
export class NewsWarmerController {
  private readonly logger = new Logger(NewsWarmerController.name);

  constructor(
    private readonly warmer: HeldSymbolsWarmerService,
    private readonly discovery: ExchangePositionsDiscoveryService,
  ) {}

  private assertAuthorized(headerKey: string | undefined) {
    const expected = process.env.INTERNAL_API_KEY;
    if (!expected) {
      throw new HttpException(
        'INTERNAL_API_KEY not configured on server',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (!headerKey || headerKey !== expected) {
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }
  }

  /** Returns what the warmer's discovery step would find right now. */
  @Public()
  @Get('discover')
  async discover(@Headers('x-internal-api-key') key?: string) {
    this.assertAuthorized(key);
    const { crypto, stock, stats } = await this.discovery.discoverAll();
    return {
      stats,
      crypto: [...crypto.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([symbol, holders]) => ({ symbol, holders })),
      stock: [...stock.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([symbol, holders]) => ({ symbol, holders })),
    };
  }

  /** Fires the crypto + stock warmers once, in sequence. Logs progress server-side. */
  @Public()
  @Post('run')
  async run(@Headers('x-internal-api-key') key?: string) {
    this.assertAuthorized(key);
    this.logger.log('admin trigger: running held-symbols warmer (crypto + stock)');

    const startedAt = Date.now();
    const errors: string[] = [];

    try {
      await this.warmer.warmCryptoHeldSymbols();
    } catch (err: any) {
      errors.push(`crypto: ${err?.message}`);
    }
    try {
      await this.warmer.warmStockHeldSymbols();
    } catch (err: any) {
      errors.push(`stock: ${err?.message}`);
    }

    const elapsedMs = Date.now() - startedAt;
    return {
      message: 'held-symbols warmer run complete',
      elapsedMs,
      errors,
    };
  }
}
