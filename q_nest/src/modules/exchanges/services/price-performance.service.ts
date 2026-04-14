import { Injectable, Logger } from '@nestjs/common';
import { ExchangesService } from '../exchanges.service';
import { BinanceService } from '../integrations/binance.service';
import { BinanceUSService } from '../integrations/binance-us.service';
import { BybitService } from '../integrations/bybit.service';
import { AlpacaService } from '../integrations/alpaca.service';
import { CacheService } from './cache.service';
import { CacheKeyManager } from './cache-key-manager';

type PerformanceKey = '8h' | '1d' | '1w' | '1m' | '3m' | '6m';

type CandleLike = {
  openTime: number;
  open: number;
  close: number;
};

@Injectable()
export class PricePerformanceService {
  private readonly logger = new Logger(PricePerformanceService.name);

  constructor(
    private readonly exchangesService: ExchangesService,
    private readonly binanceService: BinanceService,
    private readonly binanceUSService: BinanceUSService,
    private readonly bybitService: BybitService,
    private readonly alpacaService: AlpacaService,
    private readonly cacheService: CacheService,
  ) {}

  async getPricePerformance(connectionId: string, symbol: string) {
    const connection = await this.exchangesService.getConnectionById(connectionId);
    if (!connection || !connection.exchange) {
      throw new Error('Connection not found');
    }

    const exchangeName = connection.exchange.name.toLowerCase();
    const cacheKey = CacheKeyManager.pricePerformance(connectionId, symbol);
    const ttl = this.cacheService.getTtlForType('candle');

    return this.cacheService.getOrSet(cacheKey, async () => {
      const configs: Array<{ key: PerformanceKey; interval: string; limit: number; candleCount: number }> = [
        { key: '8h', interval: '8h', limit: 1, candleCount: 1 },
        { key: '1d', interval: '1d', limit: 1, candleCount: 1 },
        { key: '1w', interval: '1w', limit: 1, candleCount: 1 },
        { key: '1m', interval: '1M', limit: 1, candleCount: 1 },
        { key: '3m', interval: '1M', limit: 3, candleCount: 3 },
        { key: '6m', interval: '1M', limit: 6, candleCount: 6 },
      ];

      const entries = await Promise.all(
        configs.map(async (config) => {
          try {
            const candles = await this.fetchCandles(exchangeName, symbol, config.interval, config.limit, connectionId);
            return [config.key, this.calculatePerformance(candles, config.candleCount)] as const;
          } catch (error: any) {
            this.logger.warn(`Failed to calculate ${config.key} price performance for ${symbol}: ${error?.message}`);
            return [config.key, null] as const;
          }
        }),
      );

      return {
        symbol,
        performance: Object.fromEntries(entries) as Record<PerformanceKey, number | null>,
      };
    }, ttl);
  }

  private async fetchCandles(
    exchangeName: string,
    symbol: string,
    interval: string,
    limit: number,
    connectionId?: string,
  ) {
    const normalizedInterval = this.normalizeIntervalForExchange(exchangeName, interval);

    if (exchangeName === 'bybit') {
      return this.bybitService.getCandlestickData(symbol, normalizedInterval, limit);
    }

    if (exchangeName === 'alpaca' && connectionId) {
      const { apiKey, apiSecret } = await this.exchangesService.getDecryptedCredentials(connectionId);
      return this.alpacaService.getCandlestickData(apiKey, apiSecret, symbol, interval, limit);
    }

    if (exchangeName === 'binance.us' || exchangeName === 'binanceus' || exchangeName === 'binance-us') {
      return this.binanceUSService.getCandlestickData(symbol, interval, limit);
    }

    return this.binanceService.getCandlestickData(symbol, interval, limit);
  }

  private calculatePerformance(candles: CandleLike[], candleCount: number): number | null {
    if (!Array.isArray(candles) || candles.length < candleCount) {
      return null;
    }

    const sortedCandles = [...candles].sort((a, b) => a.openTime - b.openTime);
    const relevantCandles = sortedCandles.slice(-candleCount);
    const startPrice = Number(relevantCandles[0]?.open || 0);
    const endPrice = Number(relevantCandles[relevantCandles.length - 1]?.close || 0);

    if (!startPrice || !Number.isFinite(startPrice) || !Number.isFinite(endPrice)) {
      return null;
    }

    return Number((((endPrice - startPrice) / startPrice) * 100).toFixed(2));
  }

  private normalizeIntervalForExchange(exchangeName: string, interval: string): string {
    if (exchangeName === 'bybit' && interval === '8h') {
      return '6h';
    }

    return interval;
  }
}
