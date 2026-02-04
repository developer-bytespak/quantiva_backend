import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import {
  AccountTestnetBalanceDto,
  AssetTestnetBalanceDto,
  TestnetOrderDto,
  TestnetPortfolioDto,
  TestnetTickerPriceDto,
  TestnetOrderBookDto,
  TestnetRecentTradeDto,
  TestnetPositionDto,
} from '../dto/testnet-data.dto';
import {
  TestnetApiException,
  TestnetRateLimitException,
  InvalidTestnetApiKeyException,
} from '../exceptions/testnet.exceptions';
import { binanceTestnetConfig } from '../../../config/binance-testnet.config';

interface BinanceTestnetAccountInfo {
  accountType: string;
  permissions: string[];
  balances: Array<{
    asset: string;
    free: string;
    locked: string;
  }>;
}

interface BinanceTestnetOrder {
  orderId: number;
  symbol: string;
  side: string;
  type: string;
  origQty: string;
  price: string;
  status: string;
  time: number;
  executedQty: string;
  cummulativeQuoteQty: string; // Note: Binance uses 'cummulativeQuoteQty' not 'cumulativeQuoteAssetTransacted'
  cumulativeQuoteAssetTransacted?: string; // Also try this field name
}

@Injectable()
export class BinanceTestnetService {
  private readonly logger = new Logger(BinanceTestnetService.name);
  private readonly baseUrl = binanceTestnetConfig.apiEndpoint;
  private readonly apiClient: AxiosInstance;
  private readonly maxRetries = 2; // Reduced from 3 to speed up failures
  private readonly retryDelay = binanceTestnetConfig.retry.baseDelay;

  constructor() {
    this.apiClient = axios.create({
      baseURL: this.baseUrl,
      timeout: 5000, // Reduced from 10000ms to speed up failures
    });
  }

  /**
   * Creates a signature for Binance Testnet API requests
   */
  private createSignature(queryString: string, secret: string): string {
    const crypto = require('crypto');
    return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
  }

  /**
   * Gets Binance Testnet server time to sync with local time
   */
  private async getBinanceServerTime(): Promise<number> {
    try {
      const response = await this.makePublicRequest('/v3/time');
      return response.serverTime;
    } catch (error) {
      this.logger.warn('Failed to fetch Binance Testnet server time, using local time');
      return Date.now();
    }
  }

  /**
   * Makes a signed request to Binance Testnet API with retry logic
   */
  private async makeSignedRequest(
    method: string,
    endpoint: string,
    apiKey: string,
    apiSecret: string,
    params: Record<string, any> = {},
    data: Record<string, any> = {},
  ): Promise<any> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const timestamp = await this.getBinanceServerTime();
        // Convert all params to strings for URLSearchParams
        const stringParams = Object.entries(params).reduce((acc, [key, value]) => {
          acc[key] = value !== undefined && value !== null ? String(value) : '';
          return acc;
        }, {} as Record<string, string>);
        
        const queryParams = { ...stringParams, timestamp: timestamp.toString() };
        const queryString = new URLSearchParams(queryParams).toString();
        const signature = this.createSignature(queryString, apiSecret);

        this.logger.debug(
          `[Attempt ${attempt + 1}] ${method} ${endpoint} | Timestamp: ${timestamp} | Query: ${queryString}`,
        );

        const config = {
          method,
          url: endpoint,
          headers: {
            'X-MBX-APIKEY': apiKey,
          },
          params: { ...queryParams, signature },
          // Binance API uses query params even for POST, not request body
        };

        const response = await this.apiClient.request(config);
        this.logger.debug(`Response received for ${method} ${endpoint}`);
        return response.data;
      } catch (error) {
        lastError = error;

        this.logger.warn(`Request error on attempt ${attempt + 1}: ${error.message}`);
        
        // Log detailed error response from Binance
        if (error.response?.data) {
          this.logger.warn(`API Response: ${JSON.stringify(error.response.data)}`);
          
          // Extract Binance error message
          if (error.response.data.msg) {
            lastError = new Error(error.response.data.msg);
          }
        }

        // Check for IP ban (Binance returns 418 I'm a teapot when IP is banned)
        if (error.response?.status === 418 || 
            (error.response?.status === 400 && error.response.data?.msg?.includes('IP banned'))) {
          this.logger.error(`IP has been banned by Binance: ${error.response.data?.msg}`);
          throw new TestnetRateLimitException(
            `IP is temporarily banned from Binance API: ${error.response.data?.msg}`,
          );
        }

        if (error.response?.status === 429) {
          throw new TestnetRateLimitException();
        }

        if (error.response?.status === 401) {
          this.logger.error('Authentication failed (401) - Check API key and secret');
          throw new InvalidTestnetApiKeyException();
        }

        if (error.response?.status === 403) {
          this.logger.error('Access denied (403) - Check API key permissions');
          throw new TestnetApiException('Access denied. Check API key permissions.');
        }

        if (attempt < this.maxRetries - 1) {
          const delayMs = this.retryDelay * Math.pow(2, attempt);
          this.logger.warn(
            `Request failed (attempt ${attempt + 1}/${this.maxRetries}), retrying in ${delayMs}ms`,
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }

    throw new TestnetApiException(
      `Request failed after ${this.maxRetries} attempts: ${lastError?.message || 'Unknown error'}`,
    );
  }

  /**
   * Makes a public request (no signature required)
   */
  private async makePublicRequest(endpoint: string, params: Record<string, any> = {}): Promise<any> {
    try {
      const response = await this.apiClient.get(endpoint, { params });
      return response.data;
    } catch (error: any) {
      // Log detailed error information
      this.logger.error(`Public request failed: ${endpoint} with params ${JSON.stringify(params)}`);
      if (error.response) {
        this.logger.error(`Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`);
      }
      
      // Check for IP ban
      if (error.response?.status === 418 || 
          (error.response?.status === 400 && error.response.data?.msg?.includes('IP banned'))) {
        throw new TestnetRateLimitException(
          `IP is temporarily banned from Binance API: ${error.response.data?.msg}`,
        );
      }
      if (error.response?.status === 429) {
        throw new TestnetRateLimitException();
      }
      
      // Include Binance error message if available
      const errorMessage = error.response?.data?.msg || error.message || 'Public request failed';
      throw new TestnetApiException(errorMessage);
    }
  }

  /**
   * Tests the API connection with provided credentials
   */
  async testConnection(apiKey: string, apiSecret: string): Promise<boolean> {
    try {
      await this.makeSignedRequest('GET', '/v3/account', apiKey, apiSecret);
      return true;
    } catch (error) {
      this.logger.error(`Connection test failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Gets account balance information
   */
  async getAccountInfo(apiKey: string, apiSecret: string): Promise<any> {
    try {
      this.logger.log(`Fetching account info from: ${this.baseUrl}/v3/account`);
      
      const accountInfo: BinanceTestnetAccountInfo = await this.makeSignedRequest(
        'GET',
        '/v3/account',
        apiKey,
        apiSecret,
      );

      this.logger.log(`Account info received. Total balances: ${accountInfo.balances.length}`);
      return accountInfo;
    } catch (error) {
      this.logger.error(`Failed to get account info: ${error.message}`);
      throw error;
    }
  }

  async getAccountBalance(apiKey: string, apiSecret: string): Promise<AccountTestnetBalanceDto> {
    try {
      this.logger.log(`Fetching account balance from: ${this.baseUrl}/v3/account`);
      this.logger.log(`API Key configured: ${apiKey ? apiKey.substring(0, 10) + '...' : 'NOT SET'}`);
      
      const accountInfo: BinanceTestnetAccountInfo = await this.makeSignedRequest(
        'GET',
        '/v3/account',
        apiKey,
        apiSecret,
      );

      this.logger.log(`Account info received. Total balances: ${accountInfo.balances.length}`);

      // Filter only USDT balance
      const usdtBalance = accountInfo.balances.find((balance) => balance.asset === 'USDT');
      
      const balances: AssetTestnetBalanceDto[] = usdtBalance
        ? [{
            asset: usdtBalance.asset,
            free: parseFloat(usdtBalance.free),
            locked: parseFloat(usdtBalance.locked),
          }]
        : [];

      // Calculate total balance in USDT
      const totalBalanceUSD = balances.length > 0 
        ? (balances[0].free + balances[0].locked)
        : 0;

      this.logger.log(`USDT balance: ${totalBalanceUSD}`);

      return {
        balances,
        totalBalanceUSD,
      };
    } catch (error) {
      this.logger.error(`Failed to get account balance: ${error.message}`);
      this.logger.error(`Error details:`, error);
      throw error;
    }
  }

  /**
   * Gets open orders for a specific symbol or all symbols
   */
  async getOpenOrders(
    apiKey: string,
    apiSecret: string,
    symbol?: string,
  ): Promise<TestnetOrderDto[]> {
    try {
      const params = symbol ? { symbol } : {};
      const orders: BinanceTestnetOrder[] = await this.makeSignedRequest(
        'GET',
        '/v3/openOrders',
        apiKey,
        apiSecret,
        params,
      );

      return orders.map((order) => {
        const executedQty = parseFloat(order.executedQty) || 0;
        const price = parseFloat(order.price) || 0;
        let cumulativeQuote = parseFloat(order.cumulativeQuoteAssetTransacted);
        
        // If cumulativeQuoteAssetTransacted is null/NaN, calculate it
        if (!cumulativeQuote || isNaN(cumulativeQuote)) {
          cumulativeQuote = executedQty * price;
        }
        
        return {
          orderId: order.orderId,
          symbol: order.symbol,
          side: order.side,
          type: order.type,
          quantity: parseFloat(order.origQty),
          price: price,
          status: order.status,
          timestamp: order.time,
          executedQuantity: executedQty,
          cumulativeQuoteAssetTransacted: cumulativeQuote,
        };
      });
    } catch (error) {
      this.logger.error(`Failed to get open orders: ${error.message}`);
      throw error;
    }
  }

  /**
   * Gets all orders (including filled and cancelled) with comprehensive filters
   */
  async getAllOrders(
    apiKey: string,
    apiSecret: string,
    filters: {
      symbol?: string;
      status?: string;
      side?: string;
      type?: string;
      orderId?: number;
      startTime?: number;
      endTime?: number;
      limit?: number;
    },
  ): Promise<TestnetOrderDto[]> {
    try {
      const params: any = { 
        limit: filters.limit || 50,
      };
      
      // Binance API requires symbol for allOrders endpoint
      if (filters.symbol) {
        params.symbol = filters.symbol;
      }
      
      // Add orderId if specified (returns order and all subsequent orders)
      if (filters.orderId) {
        params.orderId = filters.orderId;
      }
      
      // Add time filters
      if (filters.startTime) {
        params.startTime = filters.startTime;
      }
      if (filters.endTime) {
        params.endTime = filters.endTime;
      }

      const orders: BinanceTestnetOrder[] = await this.makeSignedRequest(
        'GET',
        '/v3/allOrders',
        apiKey,
        apiSecret,
        params,
      );

      let filteredOrders = orders;

      // Apply client-side filters for fields not supported by Binance API
      if (filters.status) {
        filteredOrders = filteredOrders.filter(
          (order) => order.status === filters.status,
        );
      }
      if (filters.side) {
        filteredOrders = filteredOrders.filter(
          (order) => order.side === filters.side,
        );
      }
      if (filters.type) {
        filteredOrders = filteredOrders.filter(
          (order) => order.type === filters.type,
        );
      }

      return filteredOrders.map((order) => {
        const executedQty = parseFloat(order.executedQty) || 0;
        const price = parseFloat(order.price) || 0;
        
        // Try both field names - Binance uses 'cummulativeQuoteQty' (with typo)
        let cumulativeQuote = parseFloat(order.cummulativeQuoteQty) || 
                              parseFloat(order.cumulativeQuoteAssetTransacted) || 0;
        
        // Log raw order data for debugging
        this.logger.debug(`Order ${order.orderId} raw data: cummulativeQuoteQty=${order.cummulativeQuoteQty}, price=${order.price}, executedQty=${order.executedQty}`);
        
        // Calculate effective price for the order
        let effectivePrice = price;
        if (executedQty > 0 && cumulativeQuote > 0) {
          // For market orders, calculate from cumulative quote
          effectivePrice = cumulativeQuote / executedQty;
        }
        
        return {
          orderId: order.orderId,
          symbol: order.symbol,
          side: order.side,
          type: order.type,
          quantity: parseFloat(order.origQty),
          price: effectivePrice,
          status: order.status,
          timestamp: order.time,
          executedQuantity: executedQty,
          cumulativeQuoteAssetTransacted: cumulativeQuote,
        };
      });
    } catch (error) {
      this.logger.error(`Failed to get all orders: ${error.message}`);
      throw error;
    }
  }

  /**
   * Places a new order on the testnet
   */
  async placeOrder(
    apiKey: string,
    apiSecret: string,
    symbol: string,
    side: 'BUY' | 'SELL',
    type: 'MARKET' | 'LIMIT',
    quantity: number,
    price?: number,
  ): Promise<TestnetOrderDto> {
    try {
      // Validate symbol is not empty or undefined
      if (!symbol || typeof symbol !== 'string' || symbol.trim() === '') {
        throw new Error(`Invalid symbol provided: "${symbol}"`);
      }

      const params: any = {
        symbol: symbol.trim().toUpperCase(), // Ensure symbol is uppercase
        side: side.toUpperCase(),
        type: type.toUpperCase(),
      };

      this.logger.debug(`Placing ${type} order for symbol: ${params.symbol}, side: ${params.side}`);

      // For MARKET orders, use quoteOrderQty (amount in USDT) to avoid LOT_SIZE errors
      // For LIMIT orders, use quantity and price
      if (type === 'MARKET') {
        // For MARKET BUY orders, use quoteOrderQty (spend X USDT)
        // For MARKET SELL orders, use quantity (sell X units)
        if (side === 'BUY') {
          // Calculate USDT amount to spend (quantity is the amount we want to spend)
          params.quoteOrderQty = quantity.toFixed(2); // USDT amount
        } else {
          // For SELL, we need the actual quantity of the asset
          params.quantity = quantity.toString();
        }
      } else if (type === 'LIMIT') {
        if (!price) {
          throw new Error('Price is required for LIMIT orders');
        }
        params.quantity = quantity.toString();
        params.price = price.toString();
        params.timeInForce = 'GTC';
      }

      this.logger.log(`Placing ${type} order: ${JSON.stringify(params)}`);

      const order: BinanceTestnetOrder = await this.makeSignedRequest(
        'POST',
        '/v3/order',
        apiKey,
        apiSecret,
        params,
      );

      return {
        orderId: order.orderId,
        symbol: order.symbol,
        side: order.side,
        type: order.type,
        quantity: parseFloat(order.origQty),
        price: parseFloat(order.price),
        status: order.status,
        timestamp: order.time,
        executedQuantity: parseFloat(order.executedQty),
        cumulativeQuoteAssetTransacted: parseFloat(order.cumulativeQuoteAssetTransacted),
      };
    } catch (error) {
      this.logger.error(`Failed to place order: ${error.message}`);
      throw error;
    }
  }

  /**
   * Places an OCO (One-Cancels-Other) order for automatic stop-loss and take-profit
   * When either the stop-loss or take-profit is triggered, the other order is automatically cancelled
   * 
   * @param apiKey - Binance Testnet API key
   * @param apiSecret - Binance Testnet API secret
   * @param symbol - Trading pair symbol (e.g., BTCUSDT)
   * @param side - SELL for closing a long position (most common), BUY for closing a short
   * @param quantity - Amount of the asset to sell/buy
   * @param takeProfitPrice - Price at which to take profit (limit order)
   * @param stopLossPrice - Price at which to trigger stop loss (stop price)
   * @param stopLimitPrice - Price for the stop-loss limit order (usually slightly below stopLossPrice for sells)
   */
  async placeOcoOrder(
    apiKey: string,
    apiSecret: string,
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: number,
    takeProfitPrice: number,
    stopLossPrice: number,
    stopLimitPrice?: number,
  ): Promise<{
    orderListId: number;
    contingencyType: string;
    listStatusType: string;
    listOrderStatus: string;
    listClientOrderId: string;
    transactionTime: number;
    symbol: string;
    orders: Array<{
      orderId: number;
      symbol: string;
      clientOrderId: string;
    }>;
    orderReports: Array<{
      orderId: number;
      symbol: string;
      side: string;
      type: string;
      price: string;
      origQty: string;
      status: string;
      stopPrice?: string;
    }>;
  }> {
    try {
      if (!symbol || typeof symbol !== 'string' || symbol.trim() === '') {
        throw new Error(`Invalid symbol provided: "${symbol}"`);
      }

      // Get symbol info to determine tick size
      const symbolInfo = await this.getSymbolInfo(symbol);
      const tickSize = this.getTickSize(symbolInfo);
      
      this.logger.debug(`Symbol ${symbol} tick size: ${tickSize}`);

      // If stopLimitPrice not provided, use a small offset from stopLossPrice
      // For SELL OCO: stopLimitPrice should be slightly below stopLossPrice
      // For BUY OCO: stopLimitPrice should be slightly above stopLossPrice
      const effectiveStopLimitPrice = stopLimitPrice || 
        (side === 'SELL' 
          ? stopLossPrice * 0.995  // 0.5% below stop price for sells
          : stopLossPrice * 1.005  // 0.5% above stop price for buys
        );

      // Round all prices according to tick size
      const roundedTpPrice = this.roundPrice(takeProfitPrice, tickSize);
      const roundedSlPrice = this.roundPrice(stopLossPrice, tickSize);
      const roundedStopLimitPrice = this.roundPrice(effectiveStopLimitPrice, tickSize);

      const params: any = {
        symbol: symbol.trim().toUpperCase(),
        side: side.toUpperCase(),
        quantity: quantity.toString(),
        price: roundedTpPrice.toString(),
        stopPrice: roundedSlPrice.toString(),
        stopLimitPrice: roundedStopLimitPrice.toString(),
        stopLimitTimeInForce: 'GTC',
      };

      this.logger.log(
        `Placing OCO order: ${params.symbol} ${params.side} qty=${params.quantity} ` +
        `TP=${params.price} SL=${params.stopPrice} stopLimit=${params.stopLimitPrice}`
      );

      const result = await this.makeSignedRequest(
        'POST',
        '/v3/order/oco',
        apiKey,
        apiSecret,
        params,
      );

      this.logger.log(`OCO order placed successfully: orderListId=${result.orderListId}`);

      return {
        orderListId: result.orderListId,
        contingencyType: result.contingencyType,
        listStatusType: result.listStatusType,
        listOrderStatus: result.listOrderStatus,
        listClientOrderId: result.listClientOrderId,
        transactionTime: result.transactionTime,
        symbol: result.symbol,
        orders: result.orders || [],
        orderReports: result.orderReports || [],
      };
    } catch (error) {
      this.logger.error(`Failed to place OCO order: ${error.message}`);
      throw error;
    }
  }

  /**
   * Cancels an OCO order list
   */
  async cancelOcoOrder(
    apiKey: string,
    apiSecret: string,
    symbol: string,
    orderListId: number,
  ): Promise<any> {
    try {
      const result = await this.makeSignedRequest(
        'DELETE',
        '/v3/orderList',
        apiKey,
        apiSecret,
        { symbol, orderListId },
      );

      this.logger.log(`OCO order cancelled: orderListId=${orderListId}`);
      return result;
    } catch (error) {
      this.logger.error(`Failed to cancel OCO order: ${error.message}`);
      throw error;
    }
  }

  /**
   * Gets all OCO orders for a symbol
   */
  async getOcoOrders(
    apiKey: string,
    apiSecret: string,
    symbol?: string,
    limit?: number,
  ): Promise<any[]> {
    try {
      const params: any = {};
      if (symbol) params.symbol = symbol;
      if (limit) params.limit = limit;

      const result = await this.makeSignedRequest(
        'GET',
        '/v3/allOrderList',
        apiKey,
        apiSecret,
        params,
      );

      return result || [];
    } catch (error) {
      this.logger.error(`Failed to get OCO orders: ${error.message}`);
      throw error;
    }
  }

  /**
   * Cancels an open order
   */
  async cancelOrder(
    apiKey: string,
    apiSecret: string,
    symbol: string,
    orderId: number,
  ): Promise<TestnetOrderDto> {
    try {
      const order: BinanceTestnetOrder = await this.makeSignedRequest(
        'DELETE',
        '/v3/order',
        apiKey,
        apiSecret,
        { symbol, orderId },
      );

      return {
        orderId: order.orderId,
        symbol: order.symbol,
        side: order.side,
        type: order.type,
        quantity: parseFloat(order.origQty),
        price: parseFloat(order.price),
        status: order.status,
        timestamp: order.time,
        executedQuantity: parseFloat(order.executedQty),
        cumulativeQuoteAssetTransacted: parseFloat(order.cumulativeQuoteAssetTransacted),
      };
    } catch (error) {
      this.logger.error(`Failed to cancel order: ${error.message}`);
      throw error;
    }
  }

  /**
   * Gets ticker price for a symbol
   */
  async getTickerPrice(symbol: string): Promise<TestnetTickerPriceDto> {
    try {
      const ticker = await this.makePublicRequest('/v3/ticker/price', { symbol });
      return {
        symbol: ticker.symbol,
        price: parseFloat(ticker.price),
        timestamp: Date.now(),
      };
    } catch (error) {
      this.logger.error(`Failed to get ticker price: ${error.message}`);
      throw error;
    }
  }

  /**
   * Gets order book for a symbol
   */
  async getOrderBook(symbol: string, limit: number = 20): Promise<TestnetOrderBookDto> {
    try {
      const orderBook = await this.makePublicRequest('/v3/depth', {
        symbol,
        limit,
      });

      return {
        symbol,
        bids: orderBook.bids.map((bid: any) => [parseFloat(bid[0]), parseFloat(bid[1])]),
        asks: orderBook.asks.map((ask: any) => [parseFloat(ask[0]), parseFloat(ask[1])]),
        timestamp: orderBook.E || Date.now(),
      };
    } catch (error) {
      this.logger.error(`Failed to get order book: ${error.message}`);
      throw error;
    }
  }

  /**
   * Gets recent trades for a symbol
   */
  async getRecentTrades(symbol: string, limit: number = 10): Promise<TestnetRecentTradeDto[]> {
    try {
      const trades = await this.makePublicRequest('/v3/trades', { symbol, limit });

      return trades.map((trade: any) => ({
        id: trade.id,
        symbol: trade.symbol,
        price: parseFloat(trade.price),
        qty: parseFloat(trade.qty),
        time: trade.time,
        isBuyerMaker: trade.isBuyerMaker,
      }));
    } catch (error) {
      this.logger.error(`Failed to get recent trades: ${error.message}`);
      throw error;
    }
  }

  /**
   * Gets 24h ticker data
   */
  async get24hTicker(symbol: string): Promise<any> {
    try {
      const ticker = await this.makePublicRequest('/v3/ticker/24hr', { symbol });
      return {
        symbol: ticker.symbol,
        priceChange: parseFloat(ticker.priceChange),
        priceChangePercent: parseFloat(ticker.priceChangePercent),
        weightedAvgPrice: parseFloat(ticker.weightedAvgPrice),
        prevClosePrice: parseFloat(ticker.prevClosePrice),
        lastPrice: parseFloat(ticker.lastPrice),
        bidPrice: parseFloat(ticker.bidPrice),
        bidQty: parseFloat(ticker.bidQty),
        askPrice: parseFloat(ticker.askPrice),
        askQty: parseFloat(ticker.askQty),
        openPrice: parseFloat(ticker.openPrice),
        highPrice: parseFloat(ticker.highPrice),
        lowPrice: parseFloat(ticker.lowPrice),
        volume: parseFloat(ticker.volume),
        quoteAssetVolume: parseFloat(ticker.quoteAssetVolume),
        openTime: ticker.openTime,
        closeTime: ticker.closeTime,
        firstId: ticker.firstId,
        lastId: ticker.lastId,
        count: ticker.count,
      };
    } catch (error) {
      this.logger.error(`Failed to get 24h ticker: ${error.message}`);
      throw error;
    }
  }

  /**
   * Gets candlestick data
   */
  async getCandlestick(
    symbol: string,
    interval: string = '1h',
    limit: number = 100,
  ): Promise<any[]> {
    try {
      const candles = await this.makePublicRequest('/v3/klines', {
        symbol,
        interval,
        limit,
      });

      return candles.map((candle: any) => ({
        openTime: candle[0],
        open: parseFloat(candle[1]),
        high: parseFloat(candle[2]),
        low: parseFloat(candle[3]),
        close: parseFloat(candle[4]),
        volume: parseFloat(candle[5]),
        closeTime: candle[6],
        quoteAssetVolume: parseFloat(candle[7]),
        numberOfTrades: candle[8],
        takerBuyBaseAssetVolume: parseFloat(candle[9]),
        takerBuyQuoteAssetVolume: parseFloat(candle[10]),
      }));
    } catch (error) {
      this.logger.error(`Failed to get candlestick: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get account trade list (filled orders)
   * Binance API: GET /api/v3/myTrades
   */
  async getMyTrades(
    apiKey: string,
    apiSecret: string,
    filters: {
      symbol?: string;
      limit?: number;
      startTime?: number;
      endTime?: number;
      fromId?: number;
    },
  ): Promise<any[]> {
    try {
      const params: any = {
        limit: filters.limit || 500,
      };

      if (filters.symbol) {
        params.symbol = filters.symbol;
      }
      if (filters.startTime) {
        params.startTime = filters.startTime;
      }
      if (filters.endTime) {
        params.endTime = filters.endTime;
      }
      if (filters.fromId) {
        params.fromId = filters.fromId;
      }

      const trades = await this.makeSignedRequest(
        'GET',
        '/v3/myTrades',
        apiKey,
        apiSecret,
        params,
      );

      return trades;
    } catch (error) {
      this.logger.error(`Failed to get my trades: ${error.message}`);
      throw error;
    }
  }

  /**
   * Gets exchange information including all available trading pairs
   */
  async getExchangeInfo(): Promise<{ symbols: string[] }> {
    try {
      const exchangeInfo = await this.makePublicRequest('/v3/exchangeInfo');
      
      // Extract only USDT pairs that are actively trading
      const usdtSymbols = exchangeInfo.symbols
        .filter((s: any) => 
          s.symbol.endsWith('USDT') && 
          s.status === 'TRADING' &&
          s.isSpotTradingAllowed === true
        )
        .map((s: any) => s.symbol)
        .sort();
      
      return { symbols: usdtSymbols };
    } catch (error) {
      this.logger.error(`Failed to get exchange info: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get symbol-specific trading rules and filters
   */
  async getSymbolInfo(symbol: string): Promise<any> {
    try {
      const exchangeInfo = await this.makePublicRequest('/v3/exchangeInfo');
      const symbolInfo = exchangeInfo.symbols.find((s: any) => s.symbol === symbol.toUpperCase());
      return symbolInfo || null;
    } catch (error) {
      this.logger.error(`Failed to get symbol info for ${symbol}: ${error.message}`);
      return null;
    }
  }

  /**
   * Round price according to symbol's tick size (PRICE_FILTER)
   */
  private roundPrice(price: number, tickSize: string): number {
    const tick = parseFloat(tickSize);
    if (tick === 0) return price;
    
    // Round to nearest tick
    const rounded = Math.round(price / tick) * tick;
    
    // Get decimal places from tick size
    const decimals = tickSize.includes('.') ? tickSize.split('.')[1].replace(/0+$/, '').length : 0;
    
    return parseFloat(rounded.toFixed(decimals));
  }

  /**
   * Get tick size from symbol filters
   */
  private getTickSize(symbolInfo: any): string {
    if (!symbolInfo || !symbolInfo.filters) return '0.00000001';
    
    const priceFilter = symbolInfo.filters.find((f: any) => f.filterType === 'PRICE_FILTER');
    return priceFilter?.tickSize || '0.00000001';
  }
}
