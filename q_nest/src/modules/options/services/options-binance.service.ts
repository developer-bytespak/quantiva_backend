import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import * as ccxt from 'ccxt';
import {
  OptionContractDto,
  OptionsChainResponseDto,
  GreeksDto,
  OptionsAccountDto,
  OptionsPositionDto,
  OptionsOrderDto,
  OptionTypeEnum,
  AvailableUnderlyingDto,
} from '../dto/options.dto';

interface OptionCredentials {
  apiKey: string;
  apiSecret: string;
}

/**
 * Low-level Binance Options API wrapper using ccxt.
 * Uses direct eapi (European Options API) endpoint calls for reliability,
 * because ccxt unified methods (fetchPositions, fetchBalance) route to
 * futures (fapi) endpoints instead of options (eapi) endpoints.
 *
 * Binance Options API base: https://eapi.binance.com
 * WebSocket streams:        wss://nbstream.binance.com/eoptions/stream
 */
@Injectable()
export class OptionsBinanceService {
  private readonly logger = new Logger(OptionsBinanceService.name);

  // Cache exchange instances per user to avoid re-creation overhead
  private readonly exchangeInstances = new Map<string, ccxt.binance>();

  // Cache exchange info (shared across all users, refreshed periodically)
  private exchangeInfoCache: any = null;
  private exchangeInfoCachedAt = 0;
  private readonly EXCHANGE_INFO_TTL = 5 * 60 * 1000; // 5 minutes

  /**
   * Get or create a ccxt binance instance for the given credentials.
   * Used primarily for its eapi* methods (direct Binance endpoint calls)
   * and for signed request handling.
   */
  getExchange(credentials: OptionCredentials, userId?: string): ccxt.binance {
    const cacheKey = userId || credentials.apiKey.substring(0, 8);
    const existing = this.exchangeInstances.get(cacheKey);

    if (existing) {
      return existing;
    }

    const exchange = new ccxt.binance({
      apiKey: credentials.apiKey,
      secret: credentials.apiSecret,
      options: {
        defaultType: 'option',
      },
      enableRateLimit: true,
    });

    this.exchangeInstances.set(cacheKey, exchange);
    return exchange;
  }

  /**
   * Fetch and cache the eapi exchange info (available contracts, underlyings).
   * This is a PUBLIC endpoint — no API key needed.
   */
  private async getExchangeInfo(exchange: ccxt.binance): Promise<any> {
    const now = Date.now();
    if (this.exchangeInfoCache && now - this.exchangeInfoCachedAt < this.EXCHANGE_INFO_TTL) {
      return this.exchangeInfoCache;
    }

    const info = await (exchange as any).eapiPublicGetExchangeInfo();
    this.exchangeInfoCache = info;
    this.exchangeInfoCachedAt = now;
    this.logger.log(`Options exchange info loaded: ${info.optionSymbols?.length || 0} option symbols`);
    return info;
  }

  /**
   * Get all available underlying assets for options trading.
   * Uses direct eapi/v1/exchangeInfo (public, no auth needed).
   */
  async getAvailableUnderlyings(credentials: OptionCredentials, userId?: string): Promise<AvailableUnderlyingDto[]> {
    const exchange = this.getExchange(credentials, userId);

    try {
      const exchangeInfo = await this.getExchangeInfo(exchange);
      const optionSymbols: any[] = exchangeInfo.optionSymbols || [];

      // Extract unique underlyings from optionSymbols
      // Each symbol has "underlying" like "BTCUSDT", we strip the quote asset
      const underlyingMap = new Map<string, number>();
      for (const sym of optionSymbols) {
        const underlying = sym.underlying?.replace(/USDT$/, '') || sym.baseAsset || '';
        if (underlying) {
          underlyingMap.set(underlying, (underlyingMap.get(underlying) || 0) + 1);
        }
      }

      // Fetch index prices for each underlying
      const results: AvailableUnderlyingDto[] = [];
      for (const [symbol, contractCount] of underlyingMap) {
        let indexPrice = 0;
        try {
          const indexData = await (exchange as any).eapiPublicGetIndex({ underlying: `${symbol}USDT` });
          indexPrice = parseFloat(indexData?.indexPrice || '0');
        } catch {
          this.logger.warn(`Could not fetch index price for ${symbol}`);
        }
        results.push({ symbol, indexPrice, contractCount });
      }

      return results.sort((a, b) => b.contractCount - a.contractCount);
    } catch (error: any) {
      this.logger.error(`Failed to fetch available underlyings: ${error.message}`);
      throw new Error(`Failed to fetch options underlyings: ${error.message}`);
    }
  }

  /**
   * Get all unique underlying base symbols from Binance exchange info (public, no auth).
   * e.g. ['BTC', 'ETH', 'SOL', ...]
   */
  async getAllUnderlyings(): Promise<string[]> {
    const exchange = new ccxt.binance({
      options: { defaultType: 'option' },
      enableRateLimit: true,
    });
    const info = await this.getExchangeInfo(exchange);
    const optionSymbols: any[] = info.optionSymbols || [];
    const seen = new Set<string>();
    for (const sym of optionSymbols) {
      const base = sym.underlying?.replace(/USDT$/, '') || sym.baseAsset || '';
      if (base) seen.add(base);
    }
    return Array.from(seen).sort();
  }

  /**
   * Get the ATM implied volatility for an underlying (public endpoint, no credentials needed).
   * Finds the nearest ATM option and returns its mark IV.
   */
  async getAtmIv(underlying: string): Promise<number | null> {
    try {
      // Use a temporary exchange for public calls (no credentials required)
      const exchange = new ccxt.binance({
        options: { defaultType: 'option' },
        enableRateLimit: true,
      });

      // Get spot price
      const indexData = await (exchange as any).eapiPublicGetIndex({ underlying: `${underlying}USDT` });
      const spotPrice = parseFloat(indexData?.indexPrice || '0');
      if (!spotPrice) return null;

      // Get exchange info to find ATM contracts
      const exchangeInfo = await this.getExchangeInfo(exchange);
      const optionSymbols: any[] = exchangeInfo.optionSymbols || [];

      // Find nearest ATM call expiring in ~30 days
      const now = Date.now();
      const targetExpiry = now + 30 * 24 * 60 * 60 * 1000;
      let bestSymbol: string | null = null;
      let bestDistance = Infinity;

      for (const sym of optionSymbols) {
        if (!sym.symbol?.includes(underlying) || sym.side !== 'CALL') continue;
        const expiry = parseInt(sym.expiryDate || '0', 10);
        const strike = parseFloat(sym.strikePrice || '0');
        if (!expiry || !strike) continue;

        const expiryDist = Math.abs(expiry - targetExpiry);
        const strikeDist = Math.abs(strike - spotPrice) / spotPrice;
        const combinedDist = expiryDist / (30 * 24 * 60 * 60 * 1000) + strikeDist;

        if (combinedDist < bestDistance) {
          bestDistance = combinedDist;
          bestSymbol = sym.symbol;
        }
      }

      if (!bestSymbol) return null;

      // Fetch mark data for the ATM contract
      const markData: any[] = await (exchange as any).eapiPublicGetMark({ symbol: bestSymbol });
      const mark = Array.isArray(markData) ? markData[0] : markData;
      return mark?.markIV ? parseFloat(mark.markIV) : null;
    } catch (error: any) {
      this.logger.warn(`getAtmIv failed for ${underlying}: ${error.message}`);
      return null;
    }
  }

  /**
   * Convert Binance eapi symbol (BTC-260327-100000-C) to ccxt format
   * ccxt: BTC/USDT:USDT-260327-100000-C
   */
  private toCcxtSymbol(contractSymbol: string): string {
    const parts = contractSymbol.split('-');
    if (parts.length !== 4) {
      throw new Error(`Invalid option contract symbol: ${contractSymbol}`);
    }
    const [underlying, expiry, strike, type] = parts;
    return `${underlying}/USDT:USDT-${expiry}-${strike}-${type}`;
  }

  /**
   * Convert ccxt symbol back to Binance eapi symbol
   * ccxt: BTC/USDT:USDT-260327-100000-C → BTC-260327-100000-C
   */
  private fromCcxtSymbol(ccxtSymbol: string): string {
    const match = ccxtSymbol.match(/^(\w+)\/USDT:USDT-(.+)$/);
    if (match) {
      return `${match[1]}-${match[2]}`;
    }
    return ccxtSymbol;
  }

  /**
   * Fetch the full options chain for an underlying asset.
   * Uses direct eapi endpoints: exchangeInfo + ticker + mark.
   */
  async fetchOptionsChain(
    credentials: OptionCredentials,
    underlying: string,
    userId?: string,
  ): Promise<OptionsChainResponseDto> {
    const exchange = this.getExchange(credentials, userId);
    const exchangeInfo = await this.getExchangeInfo(exchange);

    // Filter contracts for this underlying from exchangeInfo
    const optionSymbols: any[] = (exchangeInfo.optionSymbols || []).filter(
      (s: any) => {
        const base = s.underlying?.replace(/USDT$/, '') || s.baseAsset || '';
        return base === underlying;
      },
    );

    if (optionSymbols.length === 0) {
      return {
        underlying,
        underlyingPrice: 0,
        expiryDates: [],
        contracts: [],
        timestamp: Date.now(),
      };
    }

    // Fetch tickers and mark prices in parallel (public endpoints)
    let tickers: any[] = [];
    let markPrices: any[] = [];
    let indexPrice = 0;

    try {
      const [tickerResult, markResult, indexResult] = await Promise.allSettled([
        (exchange as any).eapiPublicGetTicker(),
        (exchange as any).eapiPublicGetMark(),
        (exchange as any).eapiPublicGetIndex({ underlying: `${underlying}USDT` }),
      ]);
      if (tickerResult.status === 'fulfilled') tickers = tickerResult.value || [];
      if (markResult.status === 'fulfilled') markPrices = markResult.value || [];
      if (indexResult.status === 'fulfilled') indexPrice = parseFloat(indexResult.value?.indexPrice || '0');
    } catch (error: any) {
      this.logger.warn(`Options chain data fetch error: ${error.message}`);
    }

    // Index tickers and marks by symbol for quick lookup
    const tickerMap = new Map<string, any>();
    for (const t of tickers) {
      if (t.symbol) tickerMap.set(t.symbol, t);
    }
    const markMap = new Map<string, any>();
    for (const m of markPrices) {
      if (m.symbol) markMap.set(m.symbol, m);
    }

    // Build contracts list
    const contracts: OptionContractDto[] = [];
    const expirySet = new Set<string>();

    for (const sym of optionSymbols) {
      const symbol = sym.symbol; // e.g. "BTC-260327-100000-C"
      const ticker = tickerMap.get(symbol) || {};
      const mark = markMap.get(symbol) || {};

      const expiryMs = sym.expiryDate ? parseInt(sym.expiryDate) : 0;
      const expiryDate = expiryMs ? new Date(expiryMs).toISOString() : '';

      if (expiryDate) {
        expirySet.add(expiryDate.split('T')[0]);
      }

      const strike = parseFloat(sym.strikePrice || '0');
      const optType = (sym.side || '').toUpperCase().startsWith('C')
        ? OptionTypeEnum.CALL
        : OptionTypeEnum.PUT;

      contracts.push({
        symbol,
        underlying,
        strike,
        expiry: expiryDate,
        type: optType,
        bidPrice: parseFloat(ticker.bidPrice || '0'),
        askPrice: parseFloat(ticker.askPrice || '0'),
        markPrice: parseFloat(mark.markPrice || ticker.lastPrice || '0'),
        lastPrice: parseFloat(ticker.lastPrice || '0'),
        volume: parseFloat(ticker.volume || '0'),
        openInterest: parseFloat(ticker.openInterest || mark.openInterest || '0'),
        greeks: {
          delta: parseFloat(mark.delta || '0'),
          gamma: parseFloat(mark.gamma || '0'),
          theta: parseFloat(mark.theta || '0'),
          vega: parseFloat(mark.vega || '0'),
          impliedVolatility: mark.markIV ? parseFloat(mark.markIV) : undefined,
        },
        contractSize: parseInt(sym.unit || '1'),
      });
    }

    return {
      underlying,
      underlyingPrice: indexPrice,
      expiryDates: Array.from(expirySet).sort(),
      contracts,
      timestamp: Date.now(),
    };
  }

  /**
   * Fetch Greeks for a specific option contract.
   * Uses direct eapi/v1/mark endpoint (public).
   */
  async fetchGreeks(
    credentials: OptionCredentials,
    contractSymbol: string,
    userId?: string,
  ): Promise<GreeksDto> {
    const exchange = this.getExchange(credentials, userId);

    try {
      const markData: any[] = await (exchange as any).eapiPublicGetMark({ symbol: contractSymbol });
      const mark = Array.isArray(markData) ? markData[0] : markData;

      return {
        delta: parseFloat(mark?.delta || '0'),
        gamma: parseFloat(mark?.gamma || '0'),
        theta: parseFloat(mark?.theta || '0'),
        vega: parseFloat(mark?.vega || '0'),
        impliedVolatility: mark?.markIV ? parseFloat(mark.markIV) : undefined,
      };
    } catch (error: any) {
      this.logger.warn(`fetchGreeks via eapi failed for ${contractSymbol}: ${error.message}`);
      return { delta: 0, gamma: 0, theta: 0, vega: 0 };
    }
  }

  /**
   * Fetch ticker for a specific option contract.
   * Uses direct eapi/v1/ticker endpoint (public).
   */
  async fetchOptionTicker(
    credentials: OptionCredentials,
    contractSymbol: string,
    userId?: string,
  ): Promise<any> {
    const exchange = this.getExchange(credentials, userId);

    try {
      const tickers: any[] = await (exchange as any).eapiPublicGetTicker({ symbol: contractSymbol });
      return Array.isArray(tickers) ? tickers[0] : tickers;
    } catch (error: any) {
      this.logger.error(`fetchOptionTicker failed for ${contractSymbol}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Fetch order book depth for an option contract.
   * Uses direct eapi/v1/depth endpoint (public).
   */
  async fetchOptionDepth(
    credentials: OptionCredentials,
    contractSymbol: string,
    limit: number = 20,
    userId?: string,
  ): Promise<any> {
    const exchange = this.getExchange(credentials, userId);

    try {
      return await (exchange as any).eapiPublicGetDepth({
        symbol: contractSymbol,
        limit: limit.toString(),
      });
    } catch (error: any) {
      this.logger.error(`fetchOptionDepth failed for ${contractSymbol}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Place a LIMIT order for an option contract.
   * Uses direct eapi/v1/order endpoint (private).
   */
  async placeOptionOrder(
    credentials: OptionCredentials,
    contractSymbol: string,
    side: 'buy' | 'sell',
    quantity: number,
    price: number,
    userId?: string,
  ): Promise<any> {
    const exchange = this.getExchange(credentials, userId);

    this.logger.log(
      `Placing options order: ${side.toUpperCase()} ${quantity} ${contractSymbol} @ ${price}`,
    );

    try {
      const order = await (exchange as any).eapiPrivatePostOrder({
        symbol: contractSymbol,
        side: side.toUpperCase(),
        type: 'LIMIT',
        quantity: quantity.toString(),
        price: price.toString(),
        timeInForce: 'GTC',
      });

      this.logger.log(`Options order placed: ${order.orderId} status=${order.status}`);
      return order;
    } catch (error: any) {
      this.logger.error(`placeOptionOrder failed: ${error.message}`);
      // Extract the real Binance error message so the frontend sees it (not a generic 500)
      const msg = error?.info?.msg || error?.message || 'Order placement failed';
      throw new BadRequestException(msg);
    }
  }

  /**
   * Cancel an open option order.
   * Uses direct eapi/v1/order DELETE endpoint (private).
   */
  async cancelOptionOrder(
    credentials: OptionCredentials,
    contractSymbol: string,
    binanceOrderId: string,
    userId?: string,
  ): Promise<any> {
    const exchange = this.getExchange(credentials, userId);

    try {
      return await (exchange as any).eapiPrivateDeleteOrder({
        symbol: contractSymbol,
        orderId: binanceOrderId,
      });
    } catch (error: any) {
      this.logger.error(`cancelOptionOrder failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Cancel all open orders for a contract or by underlying.
   * Uses direct eapi/v1/allOpenOrdersByUnderlying DELETE endpoint (private).
   */
  async cancelAllOptionOrders(
    credentials: OptionCredentials,
    contractSymbol: string,
    userId?: string,
  ): Promise<any> {
    const exchange = this.getExchange(credentials, userId);
    const underlying = contractSymbol.split('-')[0];

    try {
      return await (exchange as any).eapiPrivateDeleteAllOpenOrdersByUnderlying({
        underlying: `${underlying}USDT`,
      });
    } catch (error: any) {
      this.logger.error(`cancelAllOptionOrders failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Fetch a single order by ID.
   * Uses direct eapi/v1/order GET endpoint (private).
   */
  async fetchOrder(
    credentials: OptionCredentials,
    contractSymbol: string,
    binanceOrderId: string,
    userId?: string,
  ): Promise<any> {
    const exchange = this.getExchange(credentials, userId);

    try {
      return await (exchange as any).eapiPrivateGetOrder({
        symbol: contractSymbol,
        orderId: binanceOrderId,
      });
    } catch (error: any) {
      this.logger.error(`fetchOrder failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Fetch open orders for options.
   * Uses direct eapi/v1/openOrders GET endpoint (private).
   */
  async fetchOpenOrders(
    credentials: OptionCredentials,
    contractSymbol?: string,
    userId?: string,
  ): Promise<any[]> {
    const exchange = this.getExchange(credentials, userId);

    try {
      const params: any = {};
      if (contractSymbol) {
        params.symbol = contractSymbol;
      }
      const orders = await (exchange as any).eapiPrivateGetOpenOrders(params);
      return Array.isArray(orders) ? orders : [];
    } catch (error: any) {
      this.logger.error(`fetchOpenOrders failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Fetch order history.
   * Uses direct eapi/v1/historyOrders GET endpoint (private).
   */
  async fetchOrderHistory(
    credentials: OptionCredentials,
    contractSymbol?: string,
    limit: number = 50,
    userId?: string,
  ): Promise<any[]> {
    const exchange = this.getExchange(credentials, userId);

    try {
      const params: any = { limit: limit.toString() };
      if (contractSymbol) {
        params.symbol = contractSymbol;
      }
      const orders = await (exchange as any).eapiPrivateGetHistoryOrders(params);
      return Array.isArray(orders) ? orders : [];
    } catch (error: any) {
      this.logger.error(`fetchOrderHistory failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Fetch current option positions.
   * Uses direct eapi/v1/position GET endpoint (private).
   *
   * NOTE: ccxt's unified fetchPositions() routes to futures (fapi) endpoints
   * which fails for options. We use the direct eapi endpoint instead.
   */
  async fetchPositions(
    credentials: OptionCredentials,
    userId?: string,
  ): Promise<OptionsPositionDto[]> {
    const exchange = this.getExchange(credentials, userId);

    try {
      const rawPositions: any[] = await (exchange as any).eapiPrivateGetPosition();
      const positions = Array.isArray(rawPositions) ? rawPositions : [];

      return positions
        .filter((p: any) => parseFloat(p.quantity || '0') !== 0)
        .map((p: any) => ({
          positionId: '',
          contractSymbol: p.symbol || '',
          underlying: (p.symbol || '').split('-')[0],
          strike: parseFloat(p.strikePrice || '0'),
          expiry: p.expiryDate
            ? new Date(parseInt(p.expiryDate)).toISOString()
            : '',
          optionType: (p.optionSide || p.side || '').toUpperCase().startsWith('C')
            ? OptionTypeEnum.CALL
            : OptionTypeEnum.PUT,
          quantity: parseFloat(p.quantity || '0'),
          avgPremium: parseFloat(p.entryPrice || '0'),
          currentPremium: parseFloat(p.markPrice || '0'),
          unrealizedPnl: parseFloat(p.unrealizedPNL || p.unrealizedPnl || '0'),
          realizedPnl: parseFloat(p.realizedPNL || p.realizedPnl || '0'),
          greeks: {
            delta: parseFloat(p.delta || '0'),
            gamma: parseFloat(p.gamma || '0'),
            theta: parseFloat(p.theta || '0'),
            vega: parseFloat(p.vega || '0'),
          },
          isOpen: true,
        }));
    } catch (error: any) {
      this.logger.warn(`fetchPositions via eapi failed: ${error.message}`);
      // Return empty positions instead of crashing — user may not have options enabled
      return [];
    }
  }

  /**
   * Fetch options account balance.
   * Uses direct eapi/v1/account GET endpoint (private).
   *
   * NOTE: ccxt's unified fetchBalance() routes to futures (fapi) endpoints.
   * We use the direct eapi endpoint instead.
   */
  async fetchBalance(
    credentials: OptionCredentials,
    userId?: string,
  ): Promise<OptionsAccountDto> {
    const exchange = this.getExchange(credentials, userId);

    try {
      // Binance Options uses /eapi/v1/marginAccount (not /account)
      const account: any = await (exchange as any).eapiPrivateGetMarginAccount();
      // Response: [{ asset, equity, maxWithdrawAmount, availableBalance, unrealizedPNL, marginBalance, ... }]
      const assets = Array.isArray(account) ? account : (account?.asset || []);
      const usdtAsset = assets.find((a: any) => a.asset === 'USDT');

      return {
        totalBalance: parseFloat(usdtAsset?.equity || '0'),
        availableBalance: parseFloat(usdtAsset?.availableBalance || usdtAsset?.available || '0'),
        unrealizedPnl: parseFloat(usdtAsset?.unrealizedPNL || '0'),
        marginBalance: parseFloat(usdtAsset?.marginBalance || '0'),
      };
    } catch (error: any) {
      this.logger.warn(`fetchBalance via eapi failed: ${error.message}`);
      // Return zeroes instead of crashing
      return { totalBalance: 0, availableBalance: 0, unrealizedPnl: 0, marginBalance: 0 };
    }
  }

  /**
   * Fetch user's option trades (fills).
   * Uses direct eapi/v1/userTrades GET endpoint (private).
   */
  async fetchMyTrades(
    credentials: OptionCredentials,
    contractSymbol?: string,
    limit: number = 50,
    userId?: string,
  ): Promise<any[]> {
    const exchange = this.getExchange(credentials, userId);

    try {
      const params: any = { limit: limit.toString() };
      if (contractSymbol) {
        params.symbol = contractSymbol;
      }
      const trades = await (exchange as any).eapiPrivateGetUserTrades(params);
      return Array.isArray(trades) ? trades : [];
    } catch (error: any) {
      this.logger.error(`fetchMyTrades failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Remove cached exchange instance for a user (e.g., on disconnect).
   */
  removeInstance(userId: string): void {
    this.exchangeInstances.delete(userId);
  }

  /**
   * Clear all cached instances (e.g., on module destroy).
   */
  clearAllInstances(): void {
    this.exchangeInstances.clear();
    this.exchangeInfoCache = null;
  }
}
