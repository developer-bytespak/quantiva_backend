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
   * Get all symbols user has traded (current holdings + open orders).
   * For trade history, use getAllTradedSymbols instead to also include fully-sold symbols.
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
   * Get ALL symbols user has ever traded — includes fully-sold assets.
   * Combines: current holdings + open orders + account balances (including dust).
   */
  private async getAllTradedSymbols(apiKey: string, apiSecret: string, isUS: boolean): Promise<string[]> {
    const service = this.getService(isUS);
    const quote = isUS ? 'USD' : 'USDT';
    const symbolSet = new Set<string>();

    // 1. Current holdings (non-zero balance)
    const positions = await service.getPositions(apiKey, apiSecret);
    for (const p of positions) {
      if (!STABLECOINS.has(p.symbol) && p.quantity > 0) {
        symbolSet.add(`${p.symbol}${quote}`);
      }
    }

    // 2. All account balances — includes dust from past trades (e.g. 0.00001 BTC from fees)
    try {
      const accountInfo = await service.getAccountInfo(apiKey, apiSecret);
      for (const b of accountInfo.balances) {
        const total = parseFloat(b.free) + parseFloat(b.locked);
        if (total > 0 && !STABLECOINS.has(b.asset)) {
          symbolSet.add(`${b.asset}${quote}`);
        }
      }
    } catch (err) {
      this.logger.warn(`getAllTradedSymbols: getAccountInfo failed: ${(err as any)?.message}`);
    }

    // 3. Open orders — catches symbols with pending orders but zero balance
    try {
      const openOrders = await service.getOpenOrders(apiKey, apiSecret);
      for (const o of openOrders) {
        if (o.symbol && !symbolSet.has(o.symbol)) {
          symbolSet.add(o.symbol);
        }
      }
    } catch (err) {
      this.logger.warn(`getAllTradedSymbols: getOpenOrders failed: ${(err as any)?.message}`);
    }

    return Array.from(symbolSet);
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
   * Current holdings with live prices, real avg entry price (FIFO), and P&L
   */
  async getPositions(userId: string) {
    const { apiKey, apiSecret, isUS } = await this.getCredentialsWithExchange(userId);
    const service = this.getService(isUS);
    const quote = isUS ? 'USD' : 'USDT';

    // 1. Get basic positions (balances + live prices + 24h change)
    const basicPositions = await service.getPositions(apiKey, apiSecret);

    // 2. Get trade fills for each non-stablecoin position to calculate real avg entry price
    const nonStablePositions = basicPositions.filter(
      (p) => !STABLECOINS.has(p.symbol) && p.quantity > 0,
    );

    const fillsPerSymbol = await Promise.all(
      nonStablePositions.map((p) =>
        service
          .getMyTrades(apiKey, apiSecret, `${p.symbol}${quote}`, { limit: 1000 })
          .then((fills) => ({ symbol: p.symbol, fills }))
          .catch(() => ({ symbol: p.symbol, fills: [] as any[] })),
      ),
    );

    // 3. FIFO matching per symbol to get avg entry price for remaining holdings
    const entryPriceMap = new Map<string, number>();

    for (const { symbol, fills } of fillsPerSymbol) {
      if (fills.length === 0) continue;

      // Sort oldest first
      const sorted = [...fills].sort((a, b) => a.time - b.time);
      const buyQueue: { price: number; remainingQty: number }[] = [];

      for (const fill of sorted) {
        if (fill.isBuyer) {
          const fPrice = Number(fill.price) || 0;
          const fQty = Number(fill.qty) || 0;
          if (fPrice > 0 && fQty > 0) {
            buyQueue.push({ price: fPrice, remainingQty: fQty });
          }
        } else {
          // SELL — consume from oldest buys
          let remaining = Number(fill.qty) || 0;
          while (remaining > 0 && buyQueue.length > 0) {
            const oldest = buyQueue[0];
            const matched = Math.min(remaining, oldest.remainingQty);
            remaining -= matched;
            oldest.remainingQty -= matched;
            if (oldest.remainingQty <= 0) buyQueue.shift();
          }
        }
      }

      // Remaining buy queue = current position's cost basis
      if (buyQueue.length > 0) {
        const totalCost = buyQueue.reduce((s, b) => s + b.price * b.remainingQty, 0);
        const totalQty = buyQueue.reduce((s, b) => s + b.remainingQty, 0);
        if (totalQty > 0) {
          entryPriceMap.set(symbol, totalCost / totalQty);
        }
      }
    }

    // 4. Enrich positions with real entry price and true P&L
    return basicPositions.map((p) => {
      const qty = Number(p.quantity) || 0;
      const curPrice = Number(p.currentPrice) || 0;
      const realEntryPrice = entryPriceMap.get(p.symbol);
      const hasRealEntry = realEntryPrice !== undefined && realEntryPrice > 0;
      const avgEntryPrice = hasRealEntry ? realEntryPrice : (Number(p.entryPrice) || curPrice);
      const totalCost = avgEntryPrice * qty;
      const marketValue = curPrice * qty;
      const totalPnl = hasRealEntry ? marketValue - totalCost : 0;
      const totalPnlPercent = hasRealEntry && totalCost > 0
        ? ((marketValue - totalCost) / totalCost) * 100
        : 0;

      return {
        symbol: p.symbol,
        quantity: qty,
        avgEntryPrice: Math.round(avgEntryPrice * 100000000) / 100000000,
        currentPrice: curPrice,
        marketValue: Math.round(marketValue * 100000000) / 100000000,
        totalCost: Math.round(totalCost * 100000000) / 100000000,
        // Real P&L since entry (FIFO-based avg entry vs current price)
        unrealizedPnl: Math.round(totalPnl * 1000) / 1000,
        unrealizedPnlPercent: Math.round(totalPnlPercent * 100) / 100,
        // 24h market movement (from Binance ticker)
        dailyChangePnl: Math.round((Number(p.unrealizedPnl) || 0) * 1000) / 1000,
        dailyChangePercent: Math.round((Number(p.pnlPercent) || 0) * 100) / 100,
        hasRealEntry,
      };
    });
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
   * All orders enriched: NEW, FILLED, CANCELED, EXPIRED, PARTIALLY_FILLED
   * Includes avg fill price, total value, fill percent calculated from cummulativeQuoteQty
   */
  async getAllOrders(
    userId: string,
    params: { symbol?: string; limit?: number },
  ) {
    const { apiKey, apiSecret, isUS } = await this.getCredentialsWithExchange(userId);
    const service = this.getService(isUS);

    let symbols: string[];
    if (params.symbol) {
      symbols = [params.symbol.toUpperCase()];
    } else {
      symbols = await this.getAllTradedSymbols(apiKey, apiSecret, isUS);
    }

    if (symbols.length === 0) return [];

    const results = await Promise.all(
      symbols.map((sym) =>
        service
          .getAllOrders(apiKey, apiSecret, sym, {
            limit: params.limit || 500,
          })
          .catch((err) => {
            this.logger.warn(`getAllOrders failed for ${sym}: ${err.message}`);
            return [];
          }),
      ),
    );

    const allOrders = results.flat();

    // Enrich each order with calculated fields
    return allOrders
      .map((order) => {
        const qty = Number(order.quantity) || 0;
        const execQty = Number(order.executedQty) || 0;
        const quoteQty = Number(order.cummulativeQuoteQty) || 0;
        const avgFillPrice = execQty > 0 ? quoteQty / execQty : 0;
        const fillPercent = qty > 0 ? Math.round((execQty / qty) * 100) : 0;

        return {
          orderId: order.orderId,
          symbol: order.symbol,
          side: order.side,
          type: order.type,
          status: order.status,
          fillPercent,
          quantity: qty,
          filledQuantity: execQty,
          avgFillPrice: Math.round(avgFillPrice * 100000000) / 100000000,
          orderPrice: order.type === 'MARKET' ? 'Market' : (order.price || order.stopPrice || 0),
          totalValue: Math.round(quoteQty * 100000000) / 100000000,
          stopPrice: order.stopPrice,
          timeInForce: order.timeInForce,
          time: order.time,
          updateTime: order.updateTime,
        };
      })
      .sort((a, b) => (b.updateTime || b.time || 0) - (a.updateTime || a.time || 0));
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
      // Use getAllTradedSymbols to include fully-sold assets
      symbols = await this.getAllTradedSymbols(apiKey, apiSecret, isUS);
    }

    if (symbols.length === 0) return [];

    // Fetch orders and fills in parallel
    const [allOrdersPerSymbol, allTradesPerSymbol] = await Promise.all([
      Promise.all(
        symbols.map((sym) =>
          service
            .getAllOrders(apiKey, apiSecret, sym, {
              limit: params.limit || 500,
              startTime: params.startTime,
              endTime: params.endTime,
            })
            .catch((err) => {
              this.logger.warn(`getAllOrders failed for ${sym}: ${err.message}`);
              return [];
            }),
        ),
      ),
      Promise.all(
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
      ),
    ]);

    const allOrders = allOrdersPerSymbol.flat();
    const allFills = allTradesPerSymbol.flat();

    // Group fills by orderId for enrichment
    const fillsByOrderId: Record<string, any[]> = {};
    for (const fill of allFills) {
      const oid = String(fill.orderId);
      if (!fillsByOrderId[oid]) fillsByOrderId[oid] = [];
      fillsByOrderId[oid].push(fill);
    }

    // Include all orders that have been executed (any amount filled)
    const enrichedOrders = allOrders
      .filter((o) => o.status === 'FILLED' || o.status === 'PARTIALLY_FILLED' || o.executedQty > 0)
      .map((order) => {
        const fills = fillsByOrderId[String(order.orderId)] || [];
        const totalFilledQty = fills.reduce((s: number, f: any) => s + f.qty, 0);
        const totalQuoteQty = fills.reduce((s: number, f: any) => s + f.quoteQty, 0);
        const totalFee = fills.reduce((s: number, f: any) => s + f.commission, 0);
        const avgPrice = totalFilledQty > 0 ? totalQuoteQty / totalFilledQty : order.price || 0;
        const feeAsset = fills.length > 0 ? fills[0].commissionAsset : '';
        const fillPercent = order.quantity > 0
          ? Math.round((order.executedQty / order.quantity) * 100)
          : 0;

        return {
          orderId: order.orderId,
          symbol: order.symbol,
          side: order.side,
          type: order.type,
          status: order.status,
          fillPercent,
          quantity: order.quantity,
          filledQuantity: order.executedQty,
          avgPrice: Math.round(avgPrice * 100000000) / 100000000,
          orderPrice: order.type === 'MARKET' ? 'Market' : order.price || order.stopPrice || 0,
          totalValue: Math.round(totalQuoteQty * 100000000) / 100000000,
          totalFee: Math.round(totalFee * 100000000) / 100000000,
          feeAsset,
          stopPrice: order.stopPrice,
          time: order.time,
          updateTime: order.updateTime,
          profitLoss: 0,
          profitLossPercent: 0,
        };
      });

    // FIFO matching: attach P&L to SELL orders
    const ordersBySymbol: Record<string, any[]> = {};
    for (const o of enrichedOrders) {
      if (!ordersBySymbol[o.symbol]) ordersBySymbol[o.symbol] = [];
      ordersBySymbol[o.symbol].push(o);
    }

    for (const [, orders] of Object.entries(ordersBySymbol)) {
      const sorted = [...orders].sort((a, b) => a.time - b.time);
      const buyQueue: { avgPrice: number; remainingQty: number }[] = [];

      for (const order of sorted) {
        if (order.side === 'BUY') {
          buyQueue.push({ avgPrice: order.avgPrice, remainingQty: order.filledQuantity });
        } else if (order.side === 'SELL') {
          let remainingQty = order.filledQuantity;
          let totalPL = 0;
          let totalEntryCost = 0;

          while (remainingQty > 0 && buyQueue.length > 0) {
            const oldest = buyQueue[0];
            const matchedQty = Math.min(remainingQty, oldest.remainingQty);
            totalPL += (order.avgPrice - oldest.avgPrice) * matchedQty;
            totalEntryCost += oldest.avgPrice * matchedQty;

            remainingQty -= matchedQty;
            oldest.remainingQty -= matchedQty;
            if (oldest.remainingQty <= 0) buyQueue.shift();
          }

          order.profitLoss = Math.round(totalPL * 1000) / 1000;
          order.profitLossPercent = totalEntryCost > 0
            ? Math.round(((totalPL / totalEntryCost) * 100) * 100) / 100
            : 0;
        }
      }
    }

    return enrichedOrders.sort((a, b) => b.time - a.time);
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
