import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ExchangesService } from '../exchanges/exchanges.service';
import { BinanceService } from '../exchanges/integrations/binance.service';
import { BinanceUSService } from '../exchanges/integrations/binance-us.service';

const STABLECOINS = new Set(['USDT', 'BUSD', 'USDC', 'TUSD', 'USDP', 'DAI', 'FDUSD']);

@Injectable()
export class BinanceTradingService {
  private readonly logger = new Logger(BinanceTradingService.name);

  constructor(
    private readonly exchangesService: ExchangesService,
    private readonly binanceService: BinanceService,
    private readonly binanceUSService: BinanceUSService,
  ) {}

  /**
   * Get user's Binance/Binance US API credentials from their active connection
   * Supports both 'binance' and 'binance-us' exchanges
   */
  private async getCredentialsWithExchange(userId: string) {
    const connection = await this.exchangesService.getActiveConnectionByType(userId, 'crypto');

    if (!connection) {
      throw new NotFoundException(
        'No active crypto exchange connection found. Please connect Binance or Binance US first.',
      );
    }

    const exchangeName = connection.exchange.name.toLowerCase();
    const isUS =
      exchangeName === 'binance-us' ||
      exchangeName === 'binance.us' ||
      exchangeName === 'binanceus';
    const isBinance = exchangeName === 'binance';

    if (!isBinance && !isUS) {
      throw new NotFoundException(
        `Active crypto connection is ${connection.exchange.name}. Please connect Binance or Binance US.`,
      );
    }

    const { apiKey, apiSecret } = await this.exchangesService.getDecryptedCredentials(
      connection.connection_id,
    );

    return {
      apiKey,
      apiSecret,
      connectionId: connection.connection_id,
      exchangeName,
      isUS,
    };
  }

  /**
   * Get the appropriate service based on exchange type
   */
  private getService(isUS: boolean) {
    return isUS ? this.binanceUSService : this.binanceService;
  }

  /**
   * Get user's Binance API credentials from their active connection (for backward compatibility)
   */
  private async getCredentials(userId: string) {
    const creds = await this.getCredentialsWithExchange(userId);
    return {
      apiKey: creds.apiKey,
      apiSecret: creds.apiSecret,
      connectionId: creds.connectionId,
    };
  }

  /**
   * Get non-stablecoin symbols user holds (for multi-symbol queries)
   */
  private async getTradingSymbols(apiKey: string, apiSecret: string, isUS: boolean): Promise<string[]> {
    const service = this.getService(isUS);
    const quote = isUS ? 'USD' : 'USDT';
    const positions = await service.getPositions(apiKey, apiSecret);
    return positions
      .filter((p) => !STABLECOINS.has(p.symbol) && p.quantity > 0)
      .map((p) => `${p.symbol}${quote}`);
  }

  /**
   * GET /binance-trading/balance
   * User's full account balance (all assets with free/locked)
   */
  async getBalance(userId: string) {
    const { apiKey, apiSecret, isUS } = await this.getCredentialsWithExchange(userId);
    const service = this.getService(isUS);
    return service.getAccountBalance(apiKey, apiSecret);
  }

  /**
   * GET /binance-trading/positions
   * Current holdings with live prices and P&L
   */
  async getPositions(userId: string) {
    const { apiKey, apiSecret, isUS } = await this.getCredentialsWithExchange(userId);
    const service = this.getService(isUS);
    return service.getPositions(apiKey, apiSecret);
  }

  /**
   * GET /binance-trading/orders/open
   * Currently open / pending orders
   */
  async getOpenOrders(userId: string, symbol?: string) {
    const { apiKey, apiSecret, isUS } = await this.getCredentialsWithExchange(userId);
    const service = this.getService(isUS);
    return service.getOpenOrders(apiKey, apiSecret, symbol);
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
    const { apiKey, apiSecret, isUS } = await this.getCredentialsWithExchange(userId);
    const service = this.getService(isUS);

    let symbols: string[];
    if (params.symbol) {
      symbols = [params.symbol.toUpperCase()];
    } else {
      symbols = await this.getTradingSymbols(apiKey, apiSecret, isUS);
    }

    if (symbols.length === 0) return [];

    const results = await Promise.all(
      symbols.map((sym) =>
        service
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
    const { apiKey, apiSecret, isUS } = await this.getCredentialsWithExchange(userId);
    const service = this.getService(isUS);

    let symbols: string[];
    if (params.symbol) {
      symbols = [params.symbol.toUpperCase()];
    } else {
      symbols = await this.getTradingSymbols(apiKey, apiSecret, isUS);
    }

    if (symbols.length === 0) return [];

    const allTradesPerSymbol = await Promise.all(
      symbols.map((sym) =>
        service
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
   * Works for both Binance and Binance US
   */
  async getDashboard(userId: string) {
    const { apiKey, apiSecret, isUS } = await this.getCredentialsWithExchange(userId);
    const service = this.getService(isUS);

    // Fetch account info once — reuse for balance + positions
    const accountInfo = await service.getAccountInfo(apiKey, apiSecret);

    const [balance, positions, openOrders] = await Promise.all([
      Promise.resolve(service.mapAccountToBalance(accountInfo)),
      service.getPositionsFromAccount(apiKey, apiSecret, accountInfo),
      service.getOpenOrders(apiKey, apiSecret),
    ]);

    const portfolio = service.calculatePortfolioFromPositions(positions);

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
