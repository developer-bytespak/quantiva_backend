import { Injectable, Logger } from '@nestjs/common';
import { ExchangesService } from '../../modules/exchanges/exchanges.service';
import { NewsService } from '../../modules/news/news.service';
import { BinanceService } from '../../modules/exchanges/integrations/binance.service';
import { BybitService } from '../../modules/exchanges/integrations/bybit.service';

@Injectable()
export class ContextService {
  private readonly logger = new Logger(ContextService.name);

  constructor(
    private readonly exchangesService: ExchangesService,
    private readonly newsService: NewsService,
    private readonly binanceService: BinanceService,
    private readonly bybitService: BybitService,
  ) {}

  async enrichContext(
    transcript: string,
    userId: string,
  ): Promise<{
    prices?: any;
    news?: any[];
    sentiment?: any;
    symbols?: string[];
  }> {
    try {
      // Extract potential crypto symbols from transcript
      const symbols = this.extractSymbols(transcript);

      // Fetch market data in parallel
      const [prices, news] = await Promise.all([
        this.fetchPrices(symbols, userId),
        this.fetchNews(symbols),
      ]);

      return {
        prices,
        news,
        sentiment: this.analyzeSentiment(news),
        symbols,
      };
    } catch (error) {
      this.logger.error(
        `Context enrichment failed: ${error.message}`,
        error.stack,
      );
      return {}; // Return empty context on error
    }
  }

  private extractSymbols(transcript: string): string[] {
    const symbols: string[] = [];
    const text = transcript.toLowerCase();

    // Common crypto mentions
    const cryptoMappings = {
      bitcoin: 'BTC',
      btc: 'BTC',
      ethereum: 'ETH',
      eth: 'ETH',
      'ether ': 'ETH',
      solana: 'SOL',
      sol: 'SOL',
      cardano: 'ADA',
      ada: 'ADA',
      ripple: 'XRP',
      xrp: 'XRP',
      dogecoin: 'DOGE',
      doge: 'DOGE',
      polkadot: 'DOT',
      dot: 'DOT',
      avalanche: 'AVAX',
      avax: 'AVAX',
      polygon: 'MATIC',
      matic: 'MATIC',
      chainlink: 'LINK',
      link: 'LINK',
      litecoin: 'LTC',
      ltc: 'LTC',
    };

    for (const [key, symbol] of Object.entries(cryptoMappings)) {
      if (text.includes(key)) {
        symbols.push(symbol);
      }
    }

    // Default to BTC and ETH if nothing detected
    if (symbols.length === 0) {
      symbols.push('BTC', 'ETH');
    }

    // Remove duplicates
    return [...new Set(symbols)];
  }

  private async fetchPrices(
    symbols: string[],
    userId: string,
  ): Promise<any> {
    try {
      const prices: any = {};

      for (const symbol of symbols.slice(0, 5)) {
        // Limit to 5 symbols
        try {
          // Use Binance service to get public ticker prices
          const tickers = await this.binanceService.getTickerPrices([`${symbol}USDT`]);
          
          if (tickers && tickers.length > 0) {
            const ticker = tickers[0];
            prices[symbol] = {
              price: ticker.price,
              change24h: ticker.change24h,
              changePercent24h: ticker.changePercent24h,
            };
          }
        } catch (error) {
          this.logger.warn(`Failed to fetch ${symbol} price: ${error.message}`);
        }
      }

      // If no prices fetched, use fallback
      if (Object.keys(prices).length === 0) {
        return this.fetchPublicPrices(symbols);
      }

      return prices;
    } catch (error) {
      this.logger.error(`Failed to fetch prices: ${error.message}`);
      return this.fetchPublicPrices(symbols);
    }
  }

  private async fetchPublicPrices(symbols: string[]): Promise<any> {
    // Fallback to a simple public API or return static data
    const prices: any = {};
    
    // Mock data for MVP - in production, call a public API like CoinGecko
    const mockPrices = {
      BTC: { price: 42500, change24h: 2.5 },
      ETH: { price: 2250, change24h: -1.2 },
      SOL: { price: 98, change24h: 5.3 },
      ADA: { price: 0.52, change24h: 1.8 },
      XRP: { price: 0.61, change24h: -0.5 },
    };

    for (const symbol of symbols) {
      if (mockPrices[symbol]) {
        prices[symbol] = mockPrices[symbol];
      }
    }

    return prices;
  }

  private async fetchNews(symbols: string[]): Promise<any[]> {
    try {
      // Use the first symbol for news
      const primarySymbol = symbols[0] || 'BTC';
      
      // Call NewsService with the correct signature
      const newsData = await this.newsService.getCryptoNews(primarySymbol, 5);

      return newsData?.news_items || [];
    } catch (error) {
      this.logger.error(`Failed to fetch news: ${error.message}`);
      return [];
    }
  }

  private analyzeSentiment(news: any[]): any {
    if (!news || news.length === 0) {
      return { overall: 'Neutral', score: 50 };
    }

    // Simple sentiment aggregation
    let totalScore = 0;
    let count = 0;

    for (const article of news) {
      if (article.sentiment?.score) {
        totalScore += article.sentiment.score;
        count++;
      }
    }

    const avgScore = count > 0 ? totalScore / count : 50;

    return {
      overall: avgScore > 60 ? 'Positive' : avgScore < 40 ? 'Negative' : 'Neutral',
      score: Math.round(avgScore),
    };
  }
}
