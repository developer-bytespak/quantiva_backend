import { Injectable, Logger } from '@nestjs/common';
import { BinanceTestnetService } from '../binance-testnet/services/binance-testnet.service';

export interface BinancePaperPosition {
  asset_id: string;
  symbol: string;
  base_asset: string;
  exchange: string;
  asset_class: string;
  qty: string;
  side: string;
  avg_entry_price: string;
  current_price: string;
  market_value: string;
  cost_basis: string;
  unrealized_pl: string;
  unrealized_plpc: string;
}

@Injectable()
export class BinancePaperTradingService {
  private readonly logger = new Logger(BinancePaperTradingService.name);

  constructor(private readonly binanceTestnetService: BinanceTestnetService) {}

  isConfigured(): boolean {
    return this.binanceTestnetService.isConfigured();
  }

  getStatus() {
    return {
      ...this.binanceTestnetService.getStatus(),
      exchange: 'BINANCE_TESTNET',
    };
  }

  async verifyConnection(): Promise<boolean> {
    return this.binanceTestnetService.verifyConnection();
  }

  async getAccountBalance() {
    const balanceData = await this.binanceTestnetService.getAccountBalance();
    const usdtBalance = balanceData.balances?.find((b) => b.asset === 'USDT');
    const cash = usdtBalance ? Number(usdtBalance.free) : 0;
    const portfolioValue = balanceData.totalBalanceUSD || cash;

    return {
      buyingPower: cash,
      cash,
      portfolioValue,
      equity: portfolioValue,
      longMarketValue: portfolioValue - cash,
      shortMarketValue: 0,
      dailyChange: 0,
      dailyChangePercent: 0,
      allBalances: balanceData.balances,
    };
  }

  async getPositions(): Promise<BinancePaperPosition[]> {
    if (!this.isConfigured()) return [];

    try {
      const accountInfo = await this.binanceTestnetService.getAccountInfo();
      const rawBalances: any[] = accountInfo.balances || [];

      const holdings = rawBalances.filter((b) => {
        const total = parseFloat(b.free || '0') + parseFloat(b.locked || '0');
        return total > 0 && !['USDT', 'BUSD', 'USDC'].includes(b.asset);
      });

      if (holdings.length === 0) return [];

      const positions = await Promise.all(
        holdings.map(async (balance) => {
          const symbol = `${balance.asset}USDT`;
          const qty = parseFloat(balance.free || '0') + parseFloat(balance.locked || '0');

          let currentPrice = 0;
          try {
            const ticker = await this.binanceTestnetService.getTickerPrice(symbol);
            currentPrice = ticker.price || 0;
          } catch {
            this.logger.warn(`No ticker price found for ${symbol}`);
          }

          const marketValue = qty * currentPrice;

          return {
            asset_id: balance.asset,
            symbol,
            base_asset: balance.asset,
            exchange: 'BINANCE_TESTNET',
            asset_class: 'crypto',
            qty: qty.toString(),
            side: 'long',
            avg_entry_price: '0',
            current_price: currentPrice.toString(),
            market_value: marketValue.toString(),
            cost_basis: '0',
            unrealized_pl: '0',
            unrealized_plpc: '0',
          } as BinancePaperPosition;
        }),
      );

      return positions.filter((p) => parseFloat(p.market_value) > 0.01);
    } catch (error: any) {
      this.logger.error(`Failed to get positions: ${error?.message}`);
      return [];
    }
  }

  async getOpenOrders(symbol?: string) {
    return this.binanceTestnetService.getOpenOrders(symbol);
  }

  async getRecentOrders(limit = 20) {
    return this.binanceTestnetService.getOrdersFromDatabase(limit);
  }

  async getTradeHistory(params?: { limit?: number; startTime?: number; endTime?: number }) {
    return this.binanceTestnetService.getTradeHistory(params);
  }

  async getDashboardData() {
    if (!this.isConfigured()) {
      throw new Error('Binance testnet not configured. Set TESTNET_API_KEY and TESTNET_API_SECRET.');
    }

    try {
      const [balanceData, openOrders, recentOrders] = await Promise.all([
        this.binanceTestnetService.getAccountBalance(),
        this.binanceTestnetService.getOpenOrders(),
        this.binanceTestnetService.getOrdersFromDatabase(20),
      ]);

      const positions = await this.getPositions();

      const usdtBalance = balanceData.balances?.find((b) => b.asset === 'USDT');
      const cash = usdtBalance ? Number(usdtBalance.free) : 0;
      const longMarketValue = positions.reduce(
        (sum, p) => sum + parseFloat(p.market_value),
        0,
      );
      const portfolioValue = cash + longMarketValue;

      const account = {
        id: 'binance-testnet',
        status: 'ACTIVE',
        currency: 'USDT',
        buying_power: cash.toFixed(2),
        cash: cash.toFixed(2),
        portfolio_value: portfolioValue.toFixed(2),
        equity: portfolioValue.toFixed(2),
        long_market_value: longMarketValue.toFixed(2),
        short_market_value: '0',
      };

      const balance = {
        buyingPower: cash,
        cash,
        portfolioValue,
        equity: portfolioValue,
        longMarketValue,
        shortMarketValue: 0,
        dailyChange: 0,
        dailyChangePercent: 0,
      };

      return {
        account,
        balance,
        positions,
        openOrders,
        recentOrders,
        clock: {
          isOpen: true, // Crypto 24/7
          nextOpen: new Date().toISOString(),
          nextClose: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        },
      };
    } catch (error: any) {
      this.logger.error(`Failed to get dashboard data: ${error?.message}`);
      throw error;
    }
  }
}
