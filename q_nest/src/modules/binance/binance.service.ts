import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';

interface Ticker24h {
  symbol: string;
  priceChange: string;
  priceChangePercent: string;
  weightedAvgPrice: string;
  lastPrice: string;
  lastQty: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  volume: string;
  quoteVolume: string;
  openTime: number;
  closeTime: number;
  count: number;
}

interface TickerPrice {
  symbol: string;
  price: string;
}

interface Candlestick {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

@Injectable()
export class BinanceService {
  private readonly logger = new Logger(BinanceService.name);
  private readonly baseUrl = 'https://api.binance.com';
  private readonly apiClient: AxiosInstance;

  constructor() {
    this.apiClient = axios.create({
      baseURL: this.baseUrl,
      timeout: 10000,
    });
  }

  /**
   * Get current price for a symbol
   */
  async getPrice(symbol: string): Promise<number> {
    try {
      const formattedSymbol = this.formatSymbol(symbol);
      const response = await this.apiClient.get<TickerPrice>('/api/v3/ticker/price', {
        params: { symbol: formattedSymbol },
      });
      return parseFloat(response.data.price);
    } catch (error: any) {
      this.logger.error(`Failed to get price for ${symbol}: ${error.message}`);
      throw new Error(`Failed to fetch price for ${symbol}`);
    }
  }

  /**
   * Get 24h ticker statistics for a symbol
   */
  async get24hStats(symbol: string): Promise<{
    price: number;
    priceChangePercent: number;
    high24h: number;
    low24h: number;
    volume24h: number;
    quoteVolume24h: number;
  }> {
    try {
      const formattedSymbol = this.formatSymbol(symbol);
      const response = await this.apiClient.get<Ticker24h>('/api/v3/ticker/24hr', {
        params: { symbol: formattedSymbol },
      });

      const data = response.data;
      return {
        price: parseFloat(data.lastPrice),
        priceChangePercent: parseFloat(data.priceChangePercent),
        high24h: parseFloat(data.highPrice),
        low24h: parseFloat(data.lowPrice),
        volume24h: parseFloat(data.volume),
        quoteVolume24h: parseFloat(data.quoteVolume),
      };
    } catch (error: any) {
      this.logger.error(`Failed to get 24h stats for ${symbol}: ${error.message}`);
      throw new Error(`Failed to fetch 24h stats for ${symbol}`);
    }
  }

  /**
   * Get OHLCV candlestick data
   */
  async getOHLCV(
    symbol: string,
    interval: string = '1h',
    limit: number = 100,
  ): Promise<Candlestick[]> {
    try {
      const formattedSymbol = this.formatSymbol(symbol);
      const response = await this.apiClient.get('/api/v3/klines', {
        params: {
          symbol: formattedSymbol,
          interval: this.mapInterval(interval),
          limit,
        },
      });

      return response.data.map((kline: any[]) => ({
        openTime: kline[0],
        open: parseFloat(kline[1]),
        high: parseFloat(kline[2]),
        low: parseFloat(kline[3]),
        close: parseFloat(kline[4]),
        volume: parseFloat(kline[5]),
        closeTime: kline[6],
      }));
    } catch (error: any) {
      this.logger.error(`Failed to get OHLCV for ${symbol}: ${error.message}`);
      throw new Error(`Failed to fetch OHLCV for ${symbol}`);
    }
  }

  /**
   * Calculate trade metrics based on current market data
   */
  async calculateTradeMetrics(
    symbol: string,
    entryPrice: number,
    stopLossPercent: number,
    takeProfitPercent: number,
  ): Promise<{
    entry: number;
    current_price: number;
    stop_loss: number;
    exit: number;
    profit_percent: number;
    extension_percent: number;
    volume: number;
    risk_reward_ratio: number;
  }> {
    try {
      const stats = await this.get24hStats(symbol);

      const stopLossPrice = entryPrice * (1 - stopLossPercent / 100);
      const takeProfitPrice = entryPrice * (1 + takeProfitPercent / 100);
      const profitPercent = ((stats.price - entryPrice) / entryPrice) * 100;
      const extensionPercent = profitPercent;
      const riskRewardRatio = takeProfitPercent / stopLossPercent;

      return {
        entry: entryPrice,
        current_price: stats.price,
        stop_loss: stopLossPrice,
        exit: takeProfitPrice,
        profit_percent: profitPercent,
        extension_percent: extensionPercent,
        volume: stats.volume24h,
        risk_reward_ratio: riskRewardRatio,
      };
    } catch (error: any) {
      this.logger.error(`Failed to calculate trade metrics for ${symbol}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get enriched market data for strategy preview
   * Returns null for price fields when API fails to allow fallback to database prices
   */
  async getEnrichedMarketData(symbol: string): Promise<{
    price: number | null;
    priceChangePercent: number | null;
    high24h: number | null;
    low24h: number | null;
    volume24h: number | null;
    quoteVolume24h: number | null;
    ohlcv?: Candlestick[];
  }> {
    try {
      const stats = await this.get24hStats(symbol);
      
      return {
        price: stats.price,
        priceChangePercent: stats.priceChangePercent,
        high24h: stats.high24h,
        low24h: stats.low24h,
        volume24h: stats.volume24h,
        quoteVolume24h: stats.quoteVolume24h,
      };
    } catch (error: any) {
      this.logger.warn(`Failed to get enriched market data for ${symbol}, returning nulls for fallback`);
      // Return nulls instead of 0s so frontend can fall back to database prices
      return {
        price: null,
        priceChangePercent: null,
        high24h: null,
        low24h: null,
        volume24h: null,
        quoteVolume24h: null,
      };
    }
  }

  /**
   * Format symbol to Binance format (e.g., BTC -> BTCUSDT)
   */
  private formatSymbol(symbol: string): string {
    // Remove any existing USDT suffix to avoid duplication
    const cleanSymbol = symbol.replace(/USDT$/i, '').replace(/\//g, '');
    
    // Add USDT suffix if not already present
    if (!cleanSymbol.endsWith('USDT')) {
      return `${cleanSymbol}USDT`;
    }
    
    return cleanSymbol;
  }

  /**
   * Map interval to Binance format
   */
  private mapInterval(interval: string): string {
    const intervalMap: Record<string, string> = {
      '1m': '1m',
      '3m': '3m',
      '5m': '5m',
      '15m': '15m',
      '30m': '30m',
      '1h': '1h',
      '2h': '2h',
      '4h': '4h',
      '6h': '6h',
      '8h': '8h',
      '12h': '12h',
      '1d': '1d',
      '3d': '3d',
      '1w': '1w',
      '1M': '1M',
    };
    
    return intervalMap[interval] || interval;
  }
}
