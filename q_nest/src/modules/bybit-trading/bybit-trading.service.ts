import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ExchangesService } from '../exchanges/exchanges.service';
import { BybitService } from '../exchanges/integrations/bybit.service';

const STABLECOINS = new Set(['USDT', 'BUSD', 'USDC', 'TUSD', 'USDP', 'DAI', 'FDUSD']);

@Injectable()
export class BybitTradingService {
  private readonly logger = new Logger(BybitTradingService.name);

  constructor(
    private readonly exchangesService: ExchangesService,
    private readonly bybitService: BybitService,
  ) {}

  /**
   * Get user's Bybit API credentials from their active crypto connection.
   */
  private async getCredentials(userId: string) {
    const connection = await this.exchangesService.getActiveConnectionByType(userId, 'crypto');

    if (!connection) {
      throw new NotFoundException('No active crypto exchange connection found.');
    }

    const exchangeName = connection.exchange.name.toLowerCase();
    if (exchangeName !== 'bybit') {
      throw new NotFoundException(
        `Active crypto connection is ${connection.exchange.name}, not Bybit.`,
      );
    }

    const { apiKey, apiSecret } = await this.exchangesService.getDecryptedCredentials(
      connection.connection_id,
    );

    return { apiKey, apiSecret, connectionId: connection.connection_id };
  }

  /**
   * Get all symbols the user currently holds or has open orders for.
   */
  private async getTradedSymbols(apiKey: string, apiSecret: string): Promise<string[]> {
    const symbolSet = new Set<string>();

    // Current holdings
    const positions = await this.bybitService.getPositions(apiKey, apiSecret);
    for (const p of positions) {
      if (!STABLECOINS.has(p.symbol) && p.quantity > 0) {
        symbolSet.add(`${p.symbol}USDT`);
      }
    }

    // Open orders
    try {
      const openOrders = await this.bybitService.getOpenOrders(apiKey, apiSecret);
      for (const o of openOrders) {
        if (o.symbol) symbolSet.add(o.symbol);
      }
    } catch {
      // non-fatal
    }

    return Array.from(symbolSet);
  }

  /**
   * GET /bybit-trading/balance
   */
  async getBalance(userId: string) {
    const { apiKey, apiSecret } = await this.getCredentials(userId);
    return this.bybitService.getAccountBalance(apiKey, apiSecret);
  }

  /**
   * GET /bybit-trading/positions
   * Current holdings with live prices and P&L (FIFO entry price from trade fills).
   */
  async getPositions(userId: string) {
    const { apiKey, apiSecret } = await this.getCredentials(userId);

    // 1. Basic positions (balances + live prices)
    const basicPositions = await this.bybitService.getPositions(apiKey, apiSecret);

    // 2. Fetch trade fills for non-stablecoin positions to get real avg entry price
    const nonStable = basicPositions.filter(
      (p) => !STABLECOINS.has(p.symbol) && p.quantity > 0,
    );

    const fillsPerSymbol = await Promise.all(
      nonStable.map((p) =>
        this.bybitService
          .getMyTrades(apiKey, apiSecret, `${p.symbol}USDT`, { limit: 500 })
          .then((fills) => ({ symbol: p.symbol, fills }))
          .catch(() => ({ symbol: p.symbol, fills: [] as any[] })),
      ),
    );

    // 3. FIFO matching to get avg entry price for remaining holdings
    const entryPriceMap = new Map<string, number>();

    for (const { symbol, fills } of fillsPerSymbol) {
      if (fills.length === 0) continue;

      const sorted = [...fills].sort((a, b) => a.time - b.time);
      const buyQueue: { price: number; remainingQty: number }[] = [];

      for (const fill of sorted) {
        if (fill.isBuyer) {
          if (fill.price > 0 && fill.qty > 0) {
            buyQueue.push({ price: fill.price, remainingQty: fill.qty });
          }
        } else {
          let remaining = fill.qty || 0;
          while (remaining > 0 && buyQueue.length > 0) {
            const oldest = buyQueue[0];
            const matched = Math.min(remaining, oldest.remainingQty);
            remaining -= matched;
            oldest.remainingQty -= matched;
            if (oldest.remainingQty <= 0) buyQueue.shift();
          }
        }
      }

      if (buyQueue.length > 0) {
        const totalCost = buyQueue.reduce((s, b) => s + b.price * b.remainingQty, 0);
        const totalQty = buyQueue.reduce((s, b) => s + b.remainingQty, 0);
        if (totalQty > 0) entryPriceMap.set(symbol, totalCost / totalQty);
      }
    }

    // 4. Enrich positions
    return basicPositions.map((p) => {
      const qty = Number(p.quantity) || 0;
      const curPrice = Number(p.currentPrice) || 0;
      const realEntry = entryPriceMap.get(p.symbol);
      const hasRealEntry = realEntry !== undefined && realEntry > 0;
      const avgEntryPrice = hasRealEntry ? realEntry : curPrice;
      const totalCost = avgEntryPrice * qty;
      const marketValue = curPrice * qty;
      const totalPnl = hasRealEntry ? marketValue - totalCost : 0;
      const totalPnlPercent = hasRealEntry && totalCost > 0
        ? ((marketValue - totalCost) / totalCost) * 100
        : 0;

      return {
        symbol: p.symbol,
        quantity: qty,
        avgEntryPrice: Math.round(avgEntryPrice * 1e8) / 1e8,
        currentPrice: curPrice,
        marketValue: Math.round(marketValue * 1e8) / 1e8,
        totalCost: Math.round(totalCost * 1e8) / 1e8,
        unrealizedPnl: Math.round(totalPnl * 1000) / 1000,
        unrealizedPnlPercent: Math.round(totalPnlPercent * 100) / 100,
        dailyChangePnl: Math.round((Number(p.unrealizedPnl) || 0) * 1000) / 1000,
        dailyChangePercent: Math.round((Number(p.pnlPercent) || 0) * 100) / 100,
        hasRealEntry,
      };
    });
  }

  /**
   * GET /bybit-trading/orders/open
   */
  async getOpenOrders(userId: string, symbol?: string) {
    const { apiKey, apiSecret } = await this.getCredentials(userId);
    return this.bybitService.getOpenOrders(apiKey, apiSecret, symbol);
  }

  /**
   * GET /bybit-trading/orders/all
   * All orders enriched with avg fill price, fill percent, total value.
   */
  async getAllOrders(
    userId: string,
    params: { symbol?: string; limit?: number },
  ) {
    const { apiKey, apiSecret } = await this.getCredentials(userId);

    let symbols: string[];
    if (params.symbol) {
      symbols = [params.symbol.toUpperCase()];
    } else {
      symbols = await this.getTradedSymbols(apiKey, apiSecret);
    }

    if (symbols.length === 0) return [];

    const results = await Promise.all(
      symbols.map((sym) =>
        this.bybitService
          .getAllOrders(apiKey, apiSecret, sym, { limit: params.limit || 500 })
          .catch((err) => {
            this.logger.warn(`getAllOrders failed for ${sym}: ${err.message}`);
            return [];
          }),
      ),
    );

    const allOrders = results.flat();

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
          avgFillPrice: Math.round(avgFillPrice * 1e8) / 1e8,
          orderPrice: order.type === 'MARKET' ? 'Market' : (order.price || order.stopPrice || 0),
          totalValue: Math.round(quoteQty * 1e8) / 1e8,
          stopPrice: order.stopPrice,
          timeInForce: order.timeInForce,
          time: order.time,
          updateTime: order.updateTime,
        };
      })
      .sort((a, b) => (b.updateTime || b.time || 0) - (a.updateTime || a.time || 0));
  }

  /**
   * GET /bybit-trading/trade-history
   * Closed trades with realized P&L (FIFO matched BUY/SELL fills).
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
      symbols = await this.getTradedSymbols(apiKey, apiSecret);
    }

    if (symbols.length === 0) return [];

    // Fetch orders and fills in parallel
    const [allOrdersPerSymbol, allTradesPerSymbol] = await Promise.all([
      Promise.all(
        symbols.map((sym) =>
          this.bybitService
            .getAllOrders(apiKey, apiSecret, sym, {
              limit: params.limit || 500,
              startTime: params.startTime,
              endTime: params.endTime,
            })
            .catch(() => []),
        ),
      ),
      Promise.all(
        symbols.map((sym) =>
          this.bybitService
            .getMyTrades(apiKey, apiSecret, sym, {
              limit: params.limit || 500,
              startTime: params.startTime,
              endTime: params.endTime,
            })
            .catch(() => []),
        ),
      ),
    ]);

    const allOrders = allOrdersPerSymbol.flat();
    const allFills = allTradesPerSymbol.flat();

    // Group fills by orderId
    const fillsByOrderId: Record<string, any[]> = {};
    for (const fill of allFills) {
      const oid = String(fill.orderId);
      if (!fillsByOrderId[oid]) fillsByOrderId[oid] = [];
      fillsByOrderId[oid].push(fill);
    }

    // Enrich orders with fill data
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
          avgPrice: Math.round(avgPrice * 1e8) / 1e8,
          orderPrice: order.type === 'MARKET' ? 'Market' : order.price || order.stopPrice || 0,
          totalValue: Math.round(totalQuoteQty * 1e8) / 1e8,
          totalFee: Math.round(totalFee * 1e8) / 1e8,
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
   * GET /bybit-trading/dashboard
   */
  async getDashboard(userId: string) {
    const { apiKey, apiSecret } = await this.getCredentials(userId);

    const accountInfo = await this.bybitService.getAccountInfo(apiKey, apiSecret);

    const [balance, positions, openOrders] = await Promise.all([
      Promise.resolve(this.bybitService.mapAccountToBalance(accountInfo)),
      this.bybitService.getPositionsFromAccount(apiKey, apiSecret, accountInfo),
      this.bybitService.getOpenOrders(apiKey, apiSecret),
    ]);

    const portfolio = this.bybitService.calculatePortfolioFromPositions(positions);

    return {
      account: {
        accountType: accountInfo.accountType || 'UNIFIED',
        permissions: [],
        canTrade: true,
        canWithdraw: true,
        canDeposit: true,
      },
      balance,
      portfolio,
      positions,
      openOrders,
      clock: {
        isOpen: true,
        nextOpen: new Date().toISOString(),
        nextClose: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      },
    };
  }
}
