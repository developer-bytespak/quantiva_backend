import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ExchangesService } from '../exchanges/exchanges.service';
import { AlpacaService } from '../exchanges/integrations/alpaca.service';

@Injectable()
export class AlpacaTradingService {
  private readonly logger = new Logger(AlpacaTradingService.name);

  constructor(
    private readonly exchangesService: ExchangesService,
    private readonly alpacaService: AlpacaService,
  ) {}

  /**
   * Get user's Alpaca API credentials from their active stocks connection
   */
  private async getCredentials(userId: string) {
    const connection = await this.exchangesService.getActiveConnectionByType(userId, 'stocks');

    if (!connection) {
      throw new NotFoundException(
        'No active stocks exchange connection found. Please connect your Alpaca account first.',
      );
    }

    if (connection.exchange.name.toLowerCase() !== 'alpaca') {
      throw new NotFoundException(
        `Active stocks connection is ${connection.exchange.name}, not Alpaca. Please connect Alpaca.`,
      );
    }

    const { apiKey, apiSecret } = await this.exchangesService.getDecryptedCredentials(
      connection.connection_id,
    );

    return { apiKey, apiSecret, connectionId: connection.connection_id };
  }

  /**
   * GET /alpaca-trading/balance
   * Account balance with buying power, cash and portfolio value
   */
  async getBalance(userId: string) {
    const { apiKey, apiSecret } = await this.getCredentials(userId);
    return this.alpacaService.getAccountBalance(apiKey, apiSecret);
  }

  /**
   * GET /alpaca-trading/positions
   * Current holdings with live prices and P&L
   */
  async getPositions(userId: string) {
    const { apiKey, apiSecret } = await this.getCredentials(userId);
    return this.alpacaService.getPositions(apiKey, apiSecret);
  }

  /**
   * GET /alpaca-trading/orders/open
   * Currently open / pending orders
   */
  async getOpenOrders(userId: string, symbol?: string) {
    const { apiKey, apiSecret } = await this.getCredentials(userId);
    const orders = await this.alpacaService.getOrders(apiKey, apiSecret, 'open');
    if (symbol) {
      const upper = symbol.toUpperCase();
      return orders.filter((o: any) => o.symbol?.toUpperCase() === upper);
    }
    return orders;
  }

  /**
   * GET /alpaca-trading/orders/all
   * All orders (open + closed)
   */
  async getAllOrders(
    userId: string,
    params: { symbol?: string; limit?: number },
  ) {
    const { apiKey, apiSecret } = await this.getCredentials(userId);
    let orders = await this.alpacaService.getOrders(apiKey, apiSecret, 'all');

    if (params.symbol) {
      const upper = params.symbol.toUpperCase();
      orders = orders.filter((o: any) => o.symbol?.toUpperCase() === upper);
    }
    if (params.limit) {
      orders = orders.slice(0, params.limit);
    }
    return orders;
  }

  /**
   * GET /alpaca-trading/trade-history
   * Filled (closed) orders as trade history
   */
  async getTradeHistory(
    userId: string,
    params: { symbol?: string; limit?: number },
  ) {
    const { apiKey, apiSecret } = await this.getCredentials(userId);
    const orders = await this.alpacaService.getOrders(apiKey, apiSecret, 'closed');

    let filled = orders
      .filter((o: any) => o.status === 'filled')
      .map((o: any) => ({
        orderId: o.id,
        symbol: o.symbol,
        side: o.side?.toUpperCase(),
        qty: parseFloat(o.filled_qty || o.qty || 0),
        filledPrice: parseFloat(o.filled_avg_price || o.limit_price || 0),
        submittedAt: o.submitted_at || o.created_at,
        filledAt: o.filled_at || o.updated_at,
        orderType: o.type?.toUpperCase(),
        status: o.status?.toUpperCase(),
        timeInForce: o.time_in_force,
        notional: parseFloat(o.filled_avg_price || 0) * parseFloat(o.filled_qty || 0),
      }));

    if (params.symbol) {
      const upper = params.symbol.toUpperCase();
      filled = filled.filter((o) => o.symbol?.toUpperCase() === upper);
    }
    if (params.limit) {
      filled = filled.slice(0, params.limit);
    }

    return filled;
  }

  /**
   * GET /alpaca-trading/dashboard
   * Combined: account info + balance + portfolio + positions + open orders + market clock
   */
  async getDashboard(userId: string) {
    const { apiKey, apiSecret } = await this.getCredentials(userId);

    const [accountInfo, positions, openOrders] = await Promise.all([
      this.alpacaService.getAccountInfo(apiKey, apiSecret),
      this.alpacaService.getPositions(apiKey, apiSecret),
      this.alpacaService.getOrders(apiKey, apiSecret, 'open'),
    ]);

    const equity       = parseFloat(accountInfo.equity           || accountInfo.portfolio_value || 0);
    const cash         = parseFloat(accountInfo.cash             || 0);
    const buyingPower  = parseFloat(accountInfo.buying_power     || accountInfo.cash            || 0);
    const longMktValue = parseFloat(accountInfo.long_market_value || 0);

    const unrealizedPnl = positions.reduce(
      (sum: number, p: any) => sum + parseFloat(p.unrealized_pl || 0),
      0,
    );
    const costBasis = longMktValue - unrealizedPnl;
    const pnlPct    = costBasis > 0 ? (unrealizedPnl / costBasis) * 100 : 0;

    const balance = {
      assets: [{ symbol: 'USD', free: buyingPower.toString(), locked: '0', total: cash.toString() }],
      totalValueUSD: equity,
      buyingPower,
    };

    const portfolio = {
      totalValue: equity,
      totalCost: costBasis,
      totalPnl: Math.round(unrealizedPnl * 1000) / 1000,
      pnlPercent: Math.round(pnlPct * 100) / 100,
      assets: positions.map((p: any) => ({
        symbol:     p.symbol,
        quantity:   parseFloat(p.qty),
        value:      parseFloat(p.market_value   || 0),
        cost:       parseFloat(p.cost_basis      || 0),
        pnl:        parseFloat(p.unrealized_pl   || 0),
        pnlPercent: parseFloat(p.unrealized_plpc || 0) * 100,
      })),
    };

    // US market hours check (Mon–Fri 9:30–16:00 EST = UTC-5)
    const now     = new Date();
    const utcMin  = now.getUTCHours() * 60 + now.getUTCMinutes();
    const etMin   = (utcMin - 5 * 60 + 24 * 60) % (24 * 60);
    const weekday = now.getUTCDay();
    const isOpen  = weekday >= 1 && weekday <= 5 && etMin >= 570 && etMin < 960;

    return {
      account: {
        accountType:      accountInfo.account_type    || 'MARGIN',
        status:           accountInfo.status,
        canTrade:         !accountInfo.trading_blocked,
        canWithdraw:      !accountInfo.transfers_blocked,
        canDeposit:       !accountInfo.account_blocked,
        currency:         accountInfo.currency         || 'USD',
        patternDayTrader: accountInfo.pattern_day_trader,
      },
      balance,
      portfolio,
      positions,
      openOrders,
      clock: {
        isOpen,
        timezone: 'America/New_York',
        nextOpen:  isOpen ? null : 'Next trading day 09:30 ET',
        nextClose: isOpen ? 'Today 16:00 ET' : null,
      },
    };
  }
}
