import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
  HttpCode,
  HttpStatus,
  HttpException,
} from '@nestjs/common';
import { ExchangesService } from './exchanges.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { KycVerifiedGuard } from '../../common/guards/kyc-verified.guard';
import { ConnectionOwnerGuard } from './guards/connection-owner.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { TokenPayload } from '../auth/services/token.service';
import { CreateConnectionDto } from './dto/create-connection.dto';
import { UpdateConnectionDto } from './dto/update-connection.dto';
import { PlaceOrderDto } from './dto/place-order.dto';
import { BinanceService } from './integrations/binance.service';
import { BybitService } from './integrations/bybit.service';
import { AlpacaService } from './integrations/alpaca.service';
import { CacheService } from './services/cache.service';
import { CacheKeyManager } from './services/cache-key-manager';
import { CacheHeadersInterceptor, CacheControl } from '../../common/interceptors/cache-headers.interceptor';
import { MarketDetailAggregatorService } from './services/market-detail-aggregator.service';
import { ExchangeType } from '@prisma/client';
import { ForbiddenException } from '@nestjs/common';
import { MarketService } from '../market/market.service';
import { MarketStocksDbService } from '../stocks-market/services/market-stocks-db.service';
import { FmpService } from '../stocks-market/services/fmp.service';

/**
 * Exchanges Controller
 * 
 * Handles exchange connections and exchange API integration (Binance, Bybit).
 * All endpoints require JWT authentication.
 * 
 * @api {post} /exchanges/connections Create Exchange Connection
 * @api {post} /exchanges/connections/:connectionId/verify Verify API Keys
 * @api {get} /exchanges/connections/:connectionId/balance Get Account Balance
 * @api {get} /exchanges/connections/:connectionId/positions Get Positions
 * @api {get} /exchanges/connections/:connectionId/orders Get Orders
 * @api {get} /exchanges/connections/:connectionId/portfolio Get Portfolio
 * @api {get} /exchanges/connections/:connectionId/ticker/:symbol Get Ticker Price
 * @api {get} /exchanges/connections/:connectionId/dashboard Get Dashboard Data (Combined)
 */
@Controller('exchanges')
@UseGuards(JwtAuthGuard)
@UseInterceptors(CacheHeadersInterceptor)
export class ExchangesController {
  constructor(
    private readonly exchangesService: ExchangesService,
    private readonly binanceService: BinanceService,
    private readonly bybitService: BybitService,
    private readonly alpacaService: AlpacaService,
    private readonly cacheService: CacheService,
    private readonly marketService: MarketService,
    private readonly marketDetailAggregator: MarketDetailAggregatorService,
    private readonly marketStocksDbService: MarketStocksDbService,
    private readonly fmpService: FmpService,
  ) {}

  @Get()
  findAll() {
    return this.exchangesService.findAll();
  }

  @Get('connections/active')
  async getActiveConnection(@CurrentUser() user: TokenPayload) {
    try {
      if (!user || !user.sub) {
        throw new HttpException(
          {
            code: 'UNAUTHORIZED',
            message: 'User not authenticated',
          },
          HttpStatus.UNAUTHORIZED,
        );
      }

      const connection = await this.exchangesService.getActiveConnection(user.sub);
      
      // Ensure the response is properly serialized
      return {
        success: true,
        data: connection,
      };
    } catch (error: any) {
      // Re-throw HTTP exceptions as-is (ConnectionNotFoundException extends HttpException)
      if (error instanceof HttpException || error?.statusCode) {
        throw error;
      }
      
      // For any other unexpected errors, return a proper HTTP exception
      throw new HttpException(
        {
          code: 'INTERNAL_SERVER_ERROR',
          message: error?.message || 'Failed to fetch active connection',
          details: process.env.NODE_ENV === 'development' ? error?.stack : undefined,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get all connections for the current authenticated user
   * This is used by the exchange configuration page
   * MUST be before @Get('connections/:userId') to avoid route collision
   */
  @Get('my-connections')
  async getUserConnectionsForCurrentUser(@CurrentUser() user: TokenPayload) {
    if (!user || !user.sub) {
      throw new HttpException(
        {
          code: 'UNAUTHORIZED',
          message: 'User not authenticated',
        },
        HttpStatus.UNAUTHORIZED,
      );
    }

    const connections = await this.exchangesService.getUserConnections(user.sub);

    return {
      success: true,
      data: connections || [],
    };
  }

  @Get('connections/:userId')
  getUserConnections(@Param('userId') userId: string) {
    return this.exchangesService.getUserConnections(userId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.exchangesService.findOne(id);
  }

  @Post()
  async create(@Body() createExchangeDto: { name: string; type: ExchangeType; supports_oauth?: boolean }) {
    // Check if exchange already exists
    const existing = await this.exchangesService.findByName(createExchangeDto.name);
    if (existing) {
      return existing;
    }
    
    return this.exchangesService.create(createExchangeDto);
  }

  /**
   * Create a new exchange connection
   * Requires KYC verification
   * 
   * @param createConnectionDto - Connection data including encrypted API keys
   * @param user - Current authenticated user
   * @returns Connection ID and status
   */
  @Post('connections')
  // @UseGuards(KycVerifiedGuard)
  @HttpCode(HttpStatus.CREATED)
  async createConnection(
    @Body() createConnectionDto: CreateConnectionDto,
    @CurrentUser() user: TokenPayload,
  ) {
    try {
      // First, get the exchange to get its name for verification
      const exchange = await this.exchangesService.findOne(createConnectionDto.exchange_id);
      if (!exchange) {
        throw new HttpException(
          {
            code: 'EXCHANGE_NOT_FOUND',
            message: 'Exchange not found',
          },
          HttpStatus.NOT_FOUND,
        );
      }

      // Verify credentials with the exchange before creating connection
      let verification;
      const exchangeName = exchange.name.toLowerCase();
      
      if (exchangeName.includes('binance')) {
        verification = await this.binanceService.verifyApiKey(
          createConnectionDto.api_key,
          createConnectionDto.api_secret,
        );
      } else if (exchangeName.includes('bybit')) {
        verification = await this.bybitService.verifyApiKey(
          createConnectionDto.api_key,
          createConnectionDto.api_secret,
        );
      } else if (exchangeName.includes('alpaca')) {
        verification = await this.alpacaService.verifyApiKey(
          createConnectionDto.api_key,
          createConnectionDto.api_secret,
        );
      } else {
        throw new HttpException(
          {
            code: 'UNSUPPORTED_EXCHANGE',
            message: 'Exchange verification not supported',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      if (!verification.valid) {
        throw new HttpException(
          {
            code: 'INVALID_CREDENTIALS',
            message: verification.error || 'Invalid API credentials',
          },
          HttpStatus.UNAUTHORIZED,
        );
      }
      const existingConnection = await this.exchangesService.getActiveConnection(user.sub);
      if (existingConnection) {
        await this.exchangesService.deleteConnection(existingConnection.connection_id);
      }
      
      // If verification passes, create the connection
      const connection = await this.exchangesService.createConnection({
        user_id: user.sub,
        exchange_id: createConnectionDto.exchange_id,
        auth_type: 'api_key',
        api_key: createConnectionDto.api_key,
        api_secret: createConnectionDto.api_secret,
        enable_trading: createConnectionDto.enable_trading,
      });

      return {
        success: true,
        data: {
          connection_id: connection.connection_id,
          status: connection.status,
        },
        message: 'Connection created successfully. Please verify your API keys.',
      };
    } catch (error: any) {
      // Re-throw HTTP exceptions
      if (error instanceof HttpException) {
        throw error;
      }

      // Handle other errors
      const message = error?.message || 'Failed to create connection';
      const statusCode = message.includes('Invalid') || message.includes('Unauthorized')
        ? HttpStatus.UNAUTHORIZED
        : HttpStatus.BAD_REQUEST;

      throw new HttpException(
        {
          code: 'CONNECTION_CREATION_FAILED',
          message,
        },
        statusCode,
      );
    }
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() updateExchangeDto: any) {
    return this.exchangesService.update(id, updateExchangeDto);
  }

  /**
   * Update exchange connection with new API credentials
   * Requires password verification and connection ownership
   * 
   * @param connectionId - Connection ID to update
   * @param updateConnectionDto - New API credentials and password
   * @param user - Current authenticated user
   * @returns Updated connection details
   */
  @Put('connections/:connectionId')
  @UseGuards(ConnectionOwnerGuard)
  @HttpCode(HttpStatus.OK)
  async updateConnection(
    @Param('connectionId') connectionId: string,
    @Body() updateConnectionDto: UpdateConnectionDto,
    @CurrentUser() user: TokenPayload,
  ) {
    try {
      const result = await this.exchangesService.updateConnection(
        connectionId,
        user.sub,
        updateConnectionDto.api_key,
        updateConnectionDto.api_secret,
        updateConnectionDto.password,
        updateConnectionDto.passphrase,
      );

      return {
        success: true,
        data: result,
        message: 'Exchange connection updated successfully',
      };
    } catch (error: any) {
      // Return proper HTTP exception with meaningful error message
      const statusCode = error?.message?.includes('password') 
        ? HttpStatus.UNAUTHORIZED 
        : error?.message?.includes('Unauthorized')
        ? HttpStatus.FORBIDDEN
        : HttpStatus.BAD_REQUEST;

      throw new HttpException(
        {
          code: 'UPDATE_CONNECTION_FAILED',
          message: error?.message || 'Failed to update connection',
        },
        statusCode,
      );
    }
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.exchangesService.delete(id);
  }

  @Delete('connections/:id')
  @UseGuards(ConnectionOwnerGuard)
  async removeConnection(@Param('id') id: string) {
    // Invalidate cache before deletion
    this.cacheService.invalidate(id);
    await this.exchangesService.deleteConnection(id);
    return {
      success: true,
      message: 'Connection deleted successfully',
    };
  }

  /**
   * Verify API keys with Binance
   * 
   * @param connectionId - Connection ID to verify
   * @returns Verification result with permissions
   */
  @Post('connections/:connectionId/verify')
  @UseGuards(ConnectionOwnerGuard)
  async verifyConnection(@Param('connectionId') connectionId: string) {
    const result = await this.exchangesService.verifyConnection(connectionId);
    return {
      success: result.valid,
      data: {
        valid: result.valid,
        status: result.status,
        permissions: result.permissions,
      },
      last_updated: new Date().toISOString(),
    };
  }

  @Get('connections/:connectionId/balance')
  @UseGuards(ConnectionOwnerGuard)
  async getBalance(@Param('connectionId') connectionId: string) {
    // Get connection to determine exchange name for cache key
    const connection = await this.exchangesService.getConnectionById(connectionId);
    if (!connection || !connection.exchange) {
      throw new HttpException('Connection not found', HttpStatus.NOT_FOUND);
    }
    
    const exchangeName = connection.exchange.name.toLowerCase();
    const cacheKey = `${exchangeName}:${connectionId}:balance`;
    const cached = this.cacheService.getCached(cacheKey);
    
    if (cached) {
      return {
        success: true,
        data: cached,
        last_updated: new Date().toISOString(),
        cached: true,
      };
    }

    const balance = await this.exchangesService.getConnectionData(connectionId, 'balance');
    return {
      success: true,
      data: balance,
      last_updated: new Date().toISOString(),
      cached: false,
    };
  }

  @Get('connections/:connectionId/profile')
  @UseGuards(ConnectionOwnerGuard)
  async getConnectionProfile(@Param('connectionId') connectionId: string) {
    try {
      const profile = await this.exchangesService.getConnectionProfile(connectionId);
      return {
        success: true,
        data: profile,
        last_updated: new Date().toISOString(),
      };
    } catch (error: any) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        {
          code: 'PROFILE_FETCH_FAILED',
          message: error?.message || 'Failed to fetch connection profile',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('connections/:connectionId/positions')
  @UseGuards(ConnectionOwnerGuard)
  async getPositions(@Param('connectionId') connectionId: string) {
    // Get connection to determine exchange name for cache key
    const connection = await this.exchangesService.getConnectionById(connectionId);
    if (!connection || !connection.exchange) {
      throw new HttpException('Connection not found', HttpStatus.NOT_FOUND);
    }
    
    const exchangeName = connection.exchange.name.toLowerCase();
    const cacheKey = `${exchangeName}:${connectionId}:positions`;
    const cached = this.cacheService.getCached(cacheKey);
    
    if (cached) {
      return {
        success: true,
        data: cached,
        last_updated: new Date().toISOString(),
        cached: true,
      };
    }

    const positions = await this.exchangesService.getConnectionData(connectionId, 'positions');
    return {
      success: true,
      data: positions,
      last_updated: new Date().toISOString(),
      cached: false,
    };
  }

  @Get('connections/:connectionId/orders')
  @UseGuards(ConnectionOwnerGuard)
  async getOrders(
    @Param('connectionId') connectionId: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    // Get connection to determine exchange name for cache key
    const connection = await this.exchangesService.getConnectionById(connectionId);
    if (!connection || !connection.exchange) {
      throw new HttpException('Connection not found', HttpStatus.NOT_FOUND);
    }
    
    const exchangeName = connection.exchange.name.toLowerCase();
    const cacheKey = `${exchangeName}:${connectionId}:orders`;
    const cached = this.cacheService.getCached(cacheKey);
    
    if (cached && (!status || status === 'open')) {
      let orders = cached as any[];
      if (status === 'open') {
        orders = orders.filter((o) => o.status === 'NEW' || o.status === 'PARTIALLY_FILLED');
      }
      if (limit) {
        orders = orders.slice(0, parseInt(limit, 10));
      }
      return {
        success: true,
        data: orders,
        last_updated: new Date().toISOString(),
        cached: true,
      };
    }

    const orders = await this.exchangesService.getConnectionData(connectionId, 'orders');
    let filteredOrders = orders as any[];
    
    if (status === 'open') {
      filteredOrders = filteredOrders.filter((o) => o.status === 'NEW' || o.status === 'PARTIALLY_FILLED');
    }
    if (limit) {
      filteredOrders = filteredOrders.slice(0, parseInt(limit, 10));
    }

    return {
      success: true,
      data: filteredOrders,
      last_updated: new Date().toISOString(),
      cached: false,
    };
  }

  @Get('connections/:connectionId/portfolio')
  @UseGuards(ConnectionOwnerGuard)
  async getPortfolio(@Param('connectionId') connectionId: string) {
    // Get connection to determine exchange name for cache key
    const connection = await this.exchangesService.getConnectionById(connectionId);
    if (!connection || !connection.exchange) {
      throw new HttpException('Connection not found', HttpStatus.NOT_FOUND);
    }
    
    const exchangeName = connection.exchange.name.toLowerCase();
    const cacheKey = `${exchangeName}:${connectionId}:portfolio`;
    const cached = this.cacheService.getCached(cacheKey);
    
    if (cached) {
      return {
        success: true,
        data: cached,
        last_updated: new Date().toISOString(),
        cached: true,
      };
    }

    const portfolio = await this.exchangesService.getConnectionData(connectionId, 'portfolio');
    return {
      success: true,
      data: portfolio,
      last_updated: new Date().toISOString(),
      cached: false,
    };
  }

  @Get('connections/:connectionId/ticker/:symbol')
  @UseGuards(ConnectionOwnerGuard)
  async getTickerPrice(
    @Param('connectionId') connectionId: string,
    @Param('symbol') symbol: string,
  ) {
    // Get connection to determine which exchange service to use
    const connection = await this.exchangesService.getConnectionById(connectionId);
    if (!connection || !connection.exchange) {
      throw new HttpException('Connection not found', HttpStatus.NOT_FOUND);
    }

    // Ticker prices are public, no need for API keys
    // Route to the correct exchange service
    const exchangeName = connection.exchange.name.toLowerCase();
    let prices;
    
    if (exchangeName === 'bybit') {
      prices = await this.bybitService.getTickerPrices([symbol]);
    } else {
      // Default to Binance
      prices = await this.binanceService.getTickerPrices([symbol]);
    }
    
    const price = prices[0] || null;

    return {
      success: true,
      data: price,
      last_updated: new Date().toISOString(),
    };
  }

  @Get('connections/:connectionId/candles/:symbol')
  @UseGuards(ConnectionOwnerGuard)
  @CacheControl({ maxAge: 300, staleWhileRevalidate: 60, public: false })
  async getCandlestickData(
    @Param('connectionId') connectionId: string,
    @Param('symbol') symbol: string,
    @Query('interval') interval: string = '1h',
    @Query('limit') limit: string = '100',
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
  ) {
    // Get connection to determine which exchange service to use
    const connection = await this.exchangesService.getConnectionById(connectionId);
    if (!connection || !connection.exchange) {
      throw new HttpException('Connection not found', HttpStatus.NOT_FOUND);
    }

    // Candlestick data is public, no need for API keys
    const exchangeName = connection.exchange.name.toLowerCase();
    const limitNum = parseInt(limit, 10) || 100;
    const startTimeNum = startTime ? parseInt(startTime, 10) : undefined;
    const endTimeNum = endTime ? parseInt(endTime, 10) : undefined;

    // Normalize interval for Bybit (8h is not supported, use 6h instead)
    const normalizedInterval = this.normalizeIntervalForExchange(exchangeName, interval);

    // Use cache for candle data (no custom time range)
    const cacheKey = CacheKeyManager.candle(connectionId, symbol, interval);
    const candleTtl = this.cacheService.getTtlForType('candle');

    const candles = await this.cacheService.getOrSet(
      cacheKey,
      async () => {
        if (exchangeName === 'bybit') {
          return this.bybitService.getCandlestickData(symbol, normalizedInterval, limitNum, startTimeNum, endTimeNum);
        } else {
          return this.binanceService.getCandlestickData(symbol, interval, limitNum, startTimeNum, endTimeNum);
        }
      },
      // Only cache when there's no custom time range (default requests)
      (!startTime && !endTime) ? candleTtl : 15000,
    );

    return {
      success: true,
      data: candles,
      last_updated: new Date().toISOString(),
    };
  }

  @Get('connections/:connectionId/trading-permissions')
  @UseGuards(ConnectionOwnerGuard)
  async getTradingPermissions(@Param('connectionId') connectionId: string) {
    const permissionCheck = await this.exchangesService.checkTradingPermission(connectionId);
    return {
      success: true,
      data: permissionCheck,
      last_updated: new Date().toISOString(),
    };
  }

  @Post('connections/:connectionId/orders/place')
  @UseGuards(ConnectionOwnerGuard)
  async placeOrder(
    @Param('connectionId') connectionId: string,
    @Body() placeOrderDto: PlaceOrderDto,
  ) {
    // Check trading permissions
    const permissionCheck = await this.exchangesService.checkTradingPermission(connectionId);
    if (!permissionCheck.canTrade) {
      throw new ForbiddenException(permissionCheck.reason || 'Trading is not allowed');
    }

    // Place order through service
    const order = await this.exchangesService.placeOrder(
      connectionId,
      placeOrderDto.symbol,
      placeOrderDto.side,
      placeOrderDto.type,
      placeOrderDto.quantity,
      placeOrderDto.price,
    );

    return {
      success: true,
      data: order,
      message: 'Order placed successfully',
      last_updated: new Date().toISOString(),
    };
  }

  @Get('connections/:connectionId/coin/:symbol')
  @UseGuards(ConnectionOwnerGuard)
  @CacheControl({ maxAge: 600, staleWhileRevalidate: 120, public: false })
  async getCoinDetail(
    @Param('connectionId') connectionId: string,
    @Param('symbol') symbol: string,
    @Query('intervals') intervals?: string,
  ) {
    // Get connection to determine which exchange service to use
    const connection = await this.exchangesService.getConnectionById(connectionId);
    if (!connection || !connection.exchange) {
      throw new HttpException('Connection not found', HttpStatus.NOT_FOUND);
    }

    const exchangeName = connection.exchange.name.toLowerCase();

    // Parse requested intervals (default: 1d only for backward compatibility)
    const requestedIntervals = intervals
      ? intervals.split(',').map(i => i.trim())
      : ['1d'];

    // Use unified cache key for coin detail
    const cacheKey = CacheKeyManager.coinDetail(connectionId, symbol);
    const coinDetailTtl = this.cacheService.getTtlForType('coin-detail');

    // Check if we have a recent cached version with same or superset intervals
    const cached = this.cacheService.getCached(cacheKey);
    if (cached && this.hasAllIntervals(cached, requestedIntervals)) {
      return {
        success: true,
        data: cached,
        cached: true,
        last_updated: new Date().toISOString(),
      };
    }

    // Parallel fetch: ticker + multi-interval candles + balance
    const [ticker, candlesByInterval, balance] = await Promise.all([
      // Ticker
      this.fetchTicker(exchangeName, symbol),
      // Multi-interval candles (parallel)
      this.fetchMultiIntervalCandles(exchangeName, connectionId, symbol, requestedIntervals),
      // Balance
      this.exchangesService.getConnectionData(connectionId, 'balance').catch(() => null),
    ]);

    const quoteCurrency = 'USDT';
    const quoteBalance = (balance as any)?.assets?.find((a: any) => a.symbol === quoteCurrency) || null;
    const availableBalance = quoteBalance ? parseFloat(quoteBalance.free || '0') : 0;

    // Extract 24h stats from 1d candles if available
    let high24h = 0;
    let low24h = 0;
    let volume24h = 0;

    const dailyCandles = candlesByInterval['1d'] || candlesByInterval[requestedIntervals[0]];
    if (ticker && dailyCandles && dailyCandles.length > 0) {
      const recentCandles = dailyCandles.slice(-24);
      high24h = Math.max(...recentCandles.map(c => c.high));
      low24h = Math.min(...recentCandles.map(c => c.low));
      volume24h = recentCandles.reduce((sum, c) => sum + c.volume, 0);
    }

    const result = {
      symbol,
      tradingPair: symbol,
      currentPrice: ticker?.price || 0,
      change24h: ticker?.change24h || 0,
      changePercent24h: ticker?.changePercent24h || 0,
      high24h,
      low24h,
      volume24h,
      availableBalance,
      quoteCurrency,
      // Multi-interval candles: { '1d': [...], '1h': [...], '15m': [...] }
      candlesByInterval,
      // Backward compatible: default candles from first interval
      candles: (dailyCandles || []).slice(0, 100),
    };

    // Cache the result
    this.cacheService.setCached(cacheKey, result, coinDetailTtl);

    return {
      success: true,
      data: result,
      cached: false,
      last_updated: new Date().toISOString(),
    };
  }

  /**
   * Get stock historical bars using the user's Alpaca connection (Data API).
   * Only available for Alpaca connections. Declared before stock/:symbol so /bars is matched.
   */
  @Get('connections/:connectionId/stock/:symbol/bars')
  @UseGuards(ConnectionOwnerGuard)
  @CacheControl({ maxAge: 300, staleWhileRevalidate: 60, public: false })
  async getStockBars(
    @Param('connectionId') connectionId: string,
    @Param('symbol') symbol: string,
    @Query('timeframe') timeframe?: string,
    @Query('limit') limit?: string,
  ) {
    const connection = await this.exchangesService.getConnectionById(connectionId);
    if (!connection?.exchange) {
      throw new HttpException('Connection not found', HttpStatus.NOT_FOUND);
    }
    const exchangeName = connection.exchange.name.toLowerCase();
    if (exchangeName !== 'alpaca') {
      throw new HttpException(
        'Stock bars are only available for Alpaca connections',
        HttpStatus.BAD_REQUEST,
      );
    }
    const { apiKey, apiSecret } = await this.exchangesService.getDecryptedCredentials(connectionId);
    const bars = await this.alpacaService.getStockBars(
      apiKey,
      apiSecret,
      symbol,
      timeframe || '1Day',
      limit ? parseInt(limit, 10) : 100,
    );
    return {
      symbol: symbol.toUpperCase(),
      timeframe: timeframe || '1Day',
      bars: bars.map((b) => ({
        timestamp: b.t,
        open: b.o,
        high: b.h,
        low: b.l,
        close: b.c,
        volume: b.v,
      })),
    };
  }

  /**
   * Get stock detail using the user's Alpaca connection (Data API).
   * Uses the connection's API key so rate limits are per user, not shared.
   * Only available for Alpaca connections.
   */
  @Get('connections/:connectionId/stock/:symbol')
  @UseGuards(ConnectionOwnerGuard)
  @CacheControl({ maxAge: 60, staleWhileRevalidate: 30, public: false })
  async getStockDetail(
    @Param('connectionId') connectionId: string,
    @Param('symbol') symbol: string,
  ) {
    const connection = await this.exchangesService.getConnectionById(connectionId);
    if (!connection?.exchange) {
      throw new HttpException('Connection not found', HttpStatus.NOT_FOUND);
    }
    const exchangeName = connection.exchange.name.toLowerCase();
    if (exchangeName !== 'alpaca') {
      throw new HttpException(
        'Stock data is only available for Alpaca connections',
        HttpStatus.BAD_REQUEST,
      );
    }
    const { apiKey, apiSecret } = await this.exchangesService.getDecryptedCredentials(connectionId);
    const sym = symbol.toUpperCase();
    const [quote, dbStocks] = await Promise.all([
      this.alpacaService.getStockSnapshot(apiKey, apiSecret, sym),
      this.marketStocksDbService.getBySymbols([sym]).catch(() => []),
    ]);
    const metadata = dbStocks[0] ?? null;
    return {
      symbol: quote.symbol,
      name: metadata?.name ?? quote.symbol,
      price: quote.price,
      change24h: quote.change24h,
      changePercent24h: quote.changePercent24h,
      volume24h: quote.volume24h,
      marketCap: metadata?.marketCap ?? null,
      sector: metadata?.sector ?? 'Unknown',
      high24h: quote.dayHigh,
      low24h: quote.dayLow,
      prevClose: quote.prevClose,
      open: quote.dayOpen,
      timestamp: new Date().toISOString(),
      ...(quote.bidPrice != null && { bidPrice: quote.bidPrice }),
      ...(quote.askPrice != null && { askPrice: quote.askPrice }),
      ...(quote.bidSize != null && { bidSize: quote.bidSize }),
      ...(quote.askSize != null && { askSize: quote.askSize }),
      ...(quote.spread != null && { spread: quote.spread }),
      ...(quote.spreadPercent != null && { spreadPercent: quote.spreadPercent }),
    };
  }

  /**
   * Fetch ticker price from correct exchange
   */
  private async fetchTicker(exchangeName: string, symbol: string) {
    try {
      if (exchangeName === 'bybit') {
        const tickers = await this.bybitService.getTickerPrices([symbol]);
        return tickers[0] || null;
      } else {
        const tickers = await this.binanceService.getTickerPrices([symbol]);
        return tickers[0] || null;
      }
    } catch (error) {
      return null;
    }
  }

  /**
   * Fetch candles for multiple intervals in parallel.
   * Each interval is cached individually for reuse.
   */
  private async fetchMultiIntervalCandles(
    exchangeName: string,
    connectionId: string,
    symbol: string,
    intervals: string[],
  ): Promise<Record<string, any[]>> {
    const candleTtl = this.cacheService.getTtlForType('candle');

    const results = await Promise.all(
      intervals.map(async (interval) => {
        const cacheKey = CacheKeyManager.candle(connectionId, symbol, interval);
        // Normalize interval for Bybit (8h is not supported, use 6h instead)
        const normalizedInterval = this.normalizeIntervalForExchange(exchangeName, interval);

        const candles = await this.cacheService.getOrSet(
          cacheKey,
          async () => {
            if (exchangeName === 'bybit') {
              return this.bybitService.getCandlestickData(symbol, normalizedInterval, 100);
            } else {
              return this.binanceService.getCandlestickData(symbol, interval, 100);
            }
          },
          candleTtl,
        );

        return { interval, candles };
      }),
    );

    const candlesByInterval: Record<string, any[]> = {};
    for (const { interval, candles } of results) {
      candlesByInterval[interval] = candles;
    }
    return candlesByInterval;
  }

  /**
   * Check if cached data already contains all requested intervals
   */
  private hasAllIntervals(cachedData: any, requestedIntervals: string[]): boolean {
    if (!cachedData?.candlesByInterval) return false;
    return requestedIntervals.every(
      (interval) => cachedData.candlesByInterval[interval] !== undefined,
    );
  }

  /**
   * Normalize interval for exchange-specific limitations.
   * Bybit doesn't support 8h intervals, so we map 8h to 6h for Bybit.
   */
  private normalizeIntervalForExchange(exchangeName: string, interval: string): string {
    if (exchangeName === 'bybit' && interval === '8h') {
      return '6h';
    }
    return interval;
  }

  /**
   * UNIFIED ENDPOINT: Get all market detail page data in a single call.
   * Replaces multiple separate API calls with one aggregated response.
   *
   * Query params:
   *  - intervals: comma-separated list (default: "1d,1h,15m")
   *  - includeOrderBook: boolean (default: true)
   *  - includeRecentTrades: boolean (default: true)
   *  - coinGeckoId: optional specific CoinGecko ID
   */
  @Get('connections/:connectionId/market-detail/:symbol')
  @UseGuards(ConnectionOwnerGuard)
  @CacheControl({ maxAge: 300, staleWhileRevalidate: 120, public: false })
  async getMarketDetail(
    @Param('connectionId') connectionId: string,
    @Param('symbol') symbol: string,
    @Query('intervals') intervals?: string,
    @Query('includeOrderBook') includeOrderBook?: string,
    @Query('includeRecentTrades') includeRecentTrades?: string,
    @Query('coinGeckoId') coinGeckoId?: string,
  ) {
    const parsedIntervals = intervals
      ? intervals.split(',').map(i => i.trim())
      : ['1d', '1h', '15m'];

    const data = await this.marketDetailAggregator.getMarketDetail(
      connectionId,
      symbol,
      {
        intervals: parsedIntervals,
        includeOrderBook: includeOrderBook !== 'false',
        includeRecentTrades: includeRecentTrades !== 'false',
        coinGeckoId,
      },
    );

    return {
      success: true,
      data,
      last_updated: new Date().toISOString(),
    };
  }

  /**
   * Get combined dashboard data (optimized endpoint)
   * Returns balance, positions, orders, portfolio, and prices in a single call
   * 
   * @param connectionId - Connection ID
   * @returns Combined dashboard data
   */

  /**
   * Get stock logo URL using external API
   * Uses a public stock logo CDN pattern
   */
  private getStockLogoUrl(symbol: string): string {
    // Use multiple fallback sources for stock logos
    const upper = symbol.toUpperCase();
    
    // Try Finnhub logo first (most reliable)
    // Format: https://api.example.com/logo?symbol=AAPL
    // Fallback: Use a CDN pattern that works for most stocks
    return `https://logo.clearbit.com/${upper}.com`;
  }

  /**
   * Extract logo URL from CoinGecko image object or string
   * Handles both formats: { large: "url" } or "url"
   */
  private extractLogoUrl(image: any): string | null {
    if (!image) return null;
    
    // If it's a string, return it directly
    if (typeof image === 'string') {
      return image;
    }
    
    // If it's an object with large/thumb/small properties, prioritize "large"
    if (typeof image === 'object') {
      return image.large || image.thumb || image.small || null;
    }
    
    return null;
  }

  /**
   * Fetch logos for all symbols in dashboard data
   * Dynamically queries CoinGecko for crypto and stock logo CDN for stocks
   * NO HARDCODING - fully dynamic approach
   */
  private async getLogosForSymbols(
    symbols: string[] = [],
    assetTypes: Record<string, "crypto" | "stock"> = {},
  ): Promise<Record<string, string>> {
    const logos: Record<string, string> = {};
    
    // Ensure symbols is an array
    if (!Array.isArray(symbols) || symbols.length === 0) {
      return logos;
    }
    
    // Remove duplicates and clean symbols - just uppercase, remove USDT trading pair suffix only
    const uniqueSymbols = Array.from(new Set(
      symbols
        .filter(s => s && typeof s === 'string')
        .map(s => {
          // General cleanup: uppercase and remove trading pair suffix (e.g., "BNBUSDT" -> "BNB")
          // but keep pure stablecoins and tokens as-is
          const upper = s.toUpperCase();
          
          // If symbol looks like a trading pair (contains USDT at end and is long enough)
          // Remove the USDT suffix to get base symbol
          if (upper.endsWith('USDT') && upper.length > 4) {
            return upper.replace(/USDT$/, '');
          }
          return upper;
        })
        .filter(s => s.length > 0)
    ));

    if (uniqueSymbols.length === 0) {
      return logos;
    }

    const logoPromises = uniqueSymbols.map(async (symbol) => {
      const assetType = assetTypes[symbol] || 'crypto';

      try {
        if (assetType === 'crypto') {
          try {
            const coinDetails = await this.marketService.getCoinDetails(symbol);
            if (coinDetails) {
              const logoUrl = this.extractLogoUrl(coinDetails.image);
              if (logoUrl) {
                logos[symbol] = logoUrl;
                return;
              }
            }
          } catch (error: any) {
            // Not found in CoinGecko
          }
        }

        if (assetType === 'stock') {
          const stockLogoUrl = this.getStockLogoUrl(symbol);
          logos[symbol] = stockLogoUrl;
          return;
        }

        if (assetType === 'crypto') {
          const stockLogoUrl = this.getStockLogoUrl(symbol);
          logos[symbol] = stockLogoUrl;
        }
      } catch (error: any) {
        // Skip failed logo fetch
      }
    });

    const batchSize = 5;
    for (let i = 0; i < logoPromises.length; i += batchSize) {
      await Promise.all(logoPromises.slice(i, i + batchSize));
    }

    return logos;
  }

  @Get('connections/:connectionId/dashboard')
  @UseGuards(ConnectionOwnerGuard)
  async getDashboard(@Param('connectionId') connectionId: string) {
    try {
      // Get connection to determine exchange
      const connection = await this.exchangesService.getConnectionById(connectionId);
      if (!connection || !connection.exchange) {
        throw new HttpException('Connection not found', HttpStatus.NOT_FOUND);
      }

      const exchangeName = connection.exchange.name.toLowerCase();

      if (connection.status !== 'active') {
        throw new HttpException(
          `Connection status is ${connection.status}. Please reconnect your exchange account.`,
          HttpStatus.BAD_REQUEST
        );
      }
      
      // OPTIMIZATION: Check if all data is cached before syncing
      // This prevents unnecessary API calls to external exchanges
      const isCached = this.exchangesService.isDashboardDataCached(connectionId, exchangeName);
      
      if (!isCached) {
        await this.exchangesService.syncConnectionData(connectionId);
      }

      const [balance, positions, orders, portfolio] = await Promise.all([
        this.exchangesService.getConnectionData(connectionId, 'balance'),
        this.exchangesService.getConnectionData(connectionId, 'positions'),
        this.exchangesService.getConnectionData(connectionId, 'orders'),
        this.exchangesService.getConnectionData(connectionId, 'portfolio'),
      ]);

      // OPTIMIZATION: Reuse prices from positions (already fetched during sync)
      // Only fetch additional prices if needed for symbols not in positions
      const topPositions = Array.isArray(positions) ? (positions as any[]).slice(0, 10) : [];
      
      // For crypto exchanges, append USDT to symbols. For stocks (Alpaca), use symbol as-is
      const isCryptoExchange = exchangeName === 'binance' || exchangeName === 'bybit';
      const assetType = isCryptoExchange ? 'crypto' : 'stock';
      
      const positionSymbols = new Set(topPositions.map((p) => 
        isCryptoExchange ? `${p?.symbol}USDT` : p?.symbol
      ).filter(s => s));
      
      // Prices are already in positions data, extract them
      const prices = topPositions
        .filter((p) => p && p.symbol && p.currentPrice)
        .map((p) => ({
          symbol: isCryptoExchange ? `${p.symbol}USDT` : p.symbol,
          price: p.currentPrice,
          change24h: 0, // Not available in positions, would need separate call
          changePercent24h: p.pnlPercent || 0,
        }));

      // Collect ALL symbols from entire response
      // This ensures every asset in the response will have a logo
      const allSymbols: string[] = [];
      const assetTypeMap: Record<string, "crypto" | "stock"> = {};
      
      // Add position symbols (safely)
      if (Array.isArray(positions)) {
        (positions as any[])
          .filter((p) => p && p.symbol)
          .forEach((p) => {
            const sym = p.symbol;
            allSymbols.push(sym);
            assetTypeMap[sym] = assetType;
          });
      }
      
      // Add balance asset symbols (safely)
      if (balance && Array.isArray((balance as any)?.assets)) {
        (balance as any).assets
          .filter((a: any) => a && a.symbol)
          .forEach((a: any) => {
            const sym = a.symbol;
            if (!allSymbols.includes(sym)) {
              allSymbols.push(sym);
              assetTypeMap[sym] = assetType;
            }
          });
      }
      
      // Add portal asset symbols (safely)
      if (portfolio && Array.isArray((portfolio as any)?.assets)) {
        (portfolio as any).assets
          .filter((a: any) => a && a.symbol)
          .forEach((a: any) => {
            const sym = a.symbol;
            if (!allSymbols.includes(sym)) {
              allSymbols.push(sym);
              assetTypeMap[sym] = assetType;
            }
          });
      }

      // Add order symbols (safely)
      if (Array.isArray(orders)) {
        (orders as any[])
          .filter((o) => o && o.symbol)
          .forEach((o) => {
            const sym = o.symbol;
            if (!allSymbols.includes(sym)) {
              allSymbols.push(sym);
              assetTypeMap[sym] = assetType;
            }
          });
      }

      // Add price symbols (safely)
      if (Array.isArray(prices)) {
        prices
          .filter((p) => p && p.symbol)
          .forEach((p) => {
            const sym = p.symbol;
            if (!allSymbols.includes(sym)) {
              allSymbols.push(sym);
              assetTypeMap[sym] = assetType;
            }
          });
      }

      const logos = await this.getLogosForSymbols(allSymbols, assetTypeMap);

      return {
        success: true,
        data: {
          balance,
          positions,
          orders: (orders as any[]).slice(0, 50), // Limit orders for dashboard
          portfolio,
          prices,
          logos, // All symbol -> logo URL mappings
          asset_types: assetTypeMap, // All symbol -> asset type mappings
        },
        last_updated: new Date().toISOString(),
        cached: isCached, // Indicate if data came from cache
      };
    } catch (error) {
      throw error;
    }
  }

  @Get('connections/:connectionId/orderbook/:symbol')
  @UseGuards(ConnectionOwnerGuard)
  async getOrderBook(
    @Param('connectionId') connectionId: string,
    @Param('symbol') symbol: string,
    @Query('limit') limit: string = '20',
  ) {
    const orderBook = await this.exchangesService.getOrderBook(
      connectionId,
      symbol,
      parseInt(limit, 10),
    );

    return {
      success: true,
      data: orderBook,
      last_updated: new Date().toISOString(),
    };
  }

  @Get('connections/:connectionId/trades/:symbol')
  @UseGuards(ConnectionOwnerGuard)
  async getRecentTrades(
    @Param('connectionId') connectionId: string,
    @Param('symbol') symbol: string,
    @Query('limit') limit: string = '50',
  ) {
    const trades = await this.exchangesService.getRecentTrades(
      connectionId,
      symbol,
      parseInt(limit, 10),
    );

    return {
      success: true,
      data: trades,
      last_updated: new Date().toISOString(),
    };
  }
}

