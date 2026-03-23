import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ExchangesService } from '../exchanges/exchanges.service';
import { BinanceService } from '../exchanges/integrations/binance.service';

const STABLECOINS = new Set(['USDT', 'BUSD', 'USDC', 'TUSD', 'USDP', 'DAI', 'FDUSD']);

@Injectable()
export class BinanceTradingService {
  private readonly logger = new Logger(BinanceTradingService.name);

  constructor(
    private readonly exchangesService: ExchangesService,
    private readonly binanceService: BinanceService,
  ) {}

  /**
   * Get user's Binance API credentials from their active connection
   */
  private async getCredentials(userId: string) {
    const connection = await this.exchangesService.getActiveConnectionByType(userId, 'crypto');

    if (!connection) {
      throw new NotFoundException(
        'No active crypto exchange connection found. Please connect your Binance account first.',
      );
    }

    if (connection.exchange.name.toLowerCase() !== 'binance') {
      throw new NotFoundException(
        `Active crypto connection is ${connection.exchange.name}, not Binance. Please connect Binance.`,
      );
    }

    const { apiKey, apiSecret } = await this.exchangesService.getDecryptedCredentials(
      connection.connection_id,
    );

    return { apiKey, apiSecret, connectionId: connection.connection_id };
  }

  /**
   * Get non-stablecoin symbols user holds (for multi-symbol queries)
   */
  private async getTradingSymbols(apiKey: string, apiSecret: string): Promise<string[]> {
    const positions = await this.binanceService.getPositions(apiKey, apiSecret);
    return positions
      .filter((p) => !STABLECOINS.has(p.symbol) && p.quantity > 0)
      .map((p) => `${p.symbol}USDT`);
  }

  /**
   * GET /binance-trading/balance
   * User's full account balance (all assets with free/locked)
   */
  async getBalance(userId: string) {
    const { apiKey, apiSecret } = await this.getCredentials(userId);
    return this.binanceService.getAccountBalance(apiKey, apiSecret);
  }

  /**
   * GET /binance-trading/positions
   * Current holdings with live prices and P&L
   */
  async getPositions(userId: string) {
    const { apiKey, apiSecret } = await this.getCredentials(userId);
    return this.binanceService.getPositions(apiKey, apiSecret);
  }

  /**
   * GET /binance-trading/orders/open
   * Currently open / pending orders
   */
  async getOpenOrders(userId: string, symbol?: string) {
    const { apiKey, apiSecret } = await this.getCredentials(userId);
    return this.binanceService.getOpenOrders(apiKey, apiSecret, symbol);
  }

  /**
   * GET /binance-trading/orders/all
   * All orders: NEW, FILLED, CANCELED, EXPIRED, PENDING_CANCEL
   * Requires a symbol — if none given, queries all held asset pairs
   */
  async getAllOrders(
    userId: string,
    params: { symbol?: string; limit?: number; startTime?: number; endTime?: number },
  ) {
    const { apiKey, apiSecret } = await this.getCredentials(userId);

    let symbols: string[];
    if (params.symbol) {
      symbols = [params.symbol.toUpperCase()];
    } else {
      symbols = await this.getTradingSymbols(apiKey, apiSecret);
    }

    if (symbols.length === 0) return [];

    const results = await Promise.all(
      symbols.map((sym) =>
        this.binanceService
          .getAllOrders(apiKey, apiSecret, sym, {
            limit: params.limit || 100,
            startTime: params.startTime,
            endTime: params.endTime,
          })
          .catch((err) => {
            this.logger.warn(`getAllOrders failed for ${sym}: ${err.message}`);
            return [];
          }),
      ),
    );

    return results
      .flat()
      .sort((a: any, b: any) => (b.time || 0) - (a.time || 0));
  }

  /**
   * GET /binance-trading/trade-history
   * Closed (filled) trades with realized P&L calculated via FIFO matching of BUY/SELL fills
   */
  async getTradeHistory(
    userId: string,
    params: { symbol?: string; limit?: number; startTime?: number; endTime?: number },
  ) {
    const { apiKey, apiSecret } = await this.getCredentials(userId);

    let symbols: string[];
    if (params.symbol) {
      symbols = [params.symbol.toUpperCase()];
    } else {
      symbols = await this.getTradingSymbols(apiKey, apiSecret);
    }

    if (symbols.length === 0) return [];

    const allTradesPerSymbol = await Promise.all(
      symbols.map((sym) =>
        this.binanceService
          .getMyTrades(apiKey, apiSecret, sym, {
            limit: params.limit || 500,
            startTime: params.startTime,
            endTime: params.endTime,
          })
          .catch((err) => {
            this.logger.warn(`getMyTrades failed for ${sym}: ${err.message}`);
            return [];
          }),
      ),
    );

    const allTrades = allTradesPerSymbol.flat();
    if (allTrades.length === 0) return [];

    // Group by symbol
    const tradesBySymbol: Record<string, any[]> = {};
    for (const trade of allTrades) {
      if (!tradesBySymbol[trade.symbol]) tradesBySymbol[trade.symbol] = [];
      tradesBySymbol[trade.symbol].push(trade);
    }

    const closedTrades: any[] = [];

    for (const [symbol, trades] of Object.entries(tradesBySymbol)) {
      // Sort oldest first for FIFO matching
      trades.sort((a, b) => a.time - b.time);

      const buyQueue: any[] = [];

      for (const trade of trades) {
        if (trade.isBuyer) {
          buyQueue.push({ ...trade, remainingQty: trade.qty });
        } else {
          let remainingSellQty = trade.qty;

          while (remainingSellQty > 0 && buyQueue.length > 0) {
            const oldest = buyQueue[0];
            const matchedQty = Math.min(remainingSellQty, oldest.remainingQty);
            const profitLoss = (trade.price - oldest.price) * matchedQty;
            const profitLossPercent =
              oldest.price > 0 ? ((trade.price - oldest.price) / oldest.price) * 100 : 0;

            const durationMs = trade.time - oldest.time;
            const durationH = Math.floor(durationMs / (1000 * 60 * 60));
            const durationM = Math.floor((durationMs % (1000 * 60 * 60)) / (1000 * 60));
            const duration = durationH > 0 ? `${durationH}h ${durationM}m` : `${durationM}m`;

            closedTrades.push({
              symbol,
              entryPrice: oldest.price,
              exitPrice: trade.price,
              quantity: matchedQty,
              profitLoss: Math.round(profitLoss * 1000) / 1000,
              profitLossPercent: Math.round(profitLossPercent * 100) / 100,
              entryTime: new Date(oldest.time).toISOString(),
              exitTime: new Date(trade.time).toISOString(),
              duration,
              entryOrderId: oldest.orderId,
              exitOrderId: trade.orderId,
              commission: trade.commission + oldest.commission,
              commissionAsset: trade.commissionAsset,
            });

            remainingSellQty -= matchedQty;
            oldest.remainingQty -= matchedQty;
            if (oldest.remainingQty <= 0) buyQueue.shift();
          }
        }
      }
    }

    return closedTrades.sort(
      (a, b) => new Date(b.exitTime).getTime() - new Date(a.exitTime).getTime(),
    );
  }

  /**
   * GET /binance-trading/dashboard
   * Combined: account info + balance + positions + open orders
   */
  async getDashboard(userId: string) {
    const { apiKey, apiSecret } = await this.getCredentials(userId);

    // Fetch account info once — reuse for balance + positions
    const accountInfo = await this.binanceService.getAccountInfo(apiKey, apiSecret);

    const [balance, positions, openOrders] = await Promise.all([
      Promise.resolve(this.binanceService.mapAccountToBalance(accountInfo)),
      this.binanceService.getPositionsFromAccount(apiKey, apiSecret, accountInfo),
      this.binanceService.getOpenOrders(apiKey, apiSecret),
    ]);

    const portfolio = this.binanceService.calculatePortfolioFromPositions(positions);

    return {
      account: {
        accountType: (accountInfo as any).accountType || 'SPOT',
        permissions: (accountInfo as any).accountPermissions || (accountInfo as any).permissions || [],
        canTrade: (accountInfo as any).canTrade ?? true,
        canWithdraw: (accountInfo as any).canWithdraw ?? true,
        canDeposit: (accountInfo as any).canDeposit ?? true,
      },
      balance,
      portfolio,
      positions,
      openOrders,
      clock: {
        isOpen: true, // Crypto is 24/7
        nextOpen: new Date().toISOString(),
        nextClose: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      },
    };
  }
}
